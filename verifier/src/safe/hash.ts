// Safe transaction construction and hashing, written from the Safe contracts'
// published encoding (see .scratch/safe-multisig-base/spike-findings.md). It
// deliberately shares no code with the Signer, so a bug or compromise there
// cannot hide a mismatch here.
import {
  concat,
  encodeFunctionData,
  encodePacked,
  hashTypedData,
  hexToBigInt,
  hexToBytes,
  parseAbi,
  size,
  type Hex,
} from 'viem';
import { NATIVE, type Payment } from '../payments.js';

export const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

/** MultiSendCallOnly deployments per Safe version (safe-deployments; verified on Base Sepolia, spike #79). */
export const MULTISEND_CALL_ONLY: Record<string, string[]> = {
  '1.4.1': ['0x9641d764fc13c8B624c04430C7356C1C7C8102e2'],
  // eip155 variant first (the one the package maps Base to), then the canonical variant
  '1.3.0': [
    '0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B',
    '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D',
  ],
};

export interface SafeTx {
  to: string;
  value: bigint;
  data: Hex;
  operation: 0 | 1;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: string;
  refundReceiver: string;
  nonce: bigint;
}

const SAFE_TX_TYPES = {
  SafeTx: [
    { type: 'address', name: 'to' },
    { type: 'uint256', name: 'value' },
    { type: 'bytes', name: 'data' },
    { type: 'uint8', name: 'operation' },
    { type: 'uint256', name: 'safeTxGas' },
    { type: 'uint256', name: 'baseGas' },
    { type: 'uint256', name: 'gasPrice' },
    { type: 'address', name: 'gasToken' },
    { type: 'address', name: 'refundReceiver' },
    { type: 'uint256', name: 'nonce' },
  ],
} as const;

/** The EIP-712 digest owners sign: domain is `{chainId, verifyingContract}` only, for Safe 1.3.0 and 1.4.1. */
export function safeTxHash(safe: string, chainId: number, tx: SafeTx): Hex {
  return hashTypedData({
    domain: { chainId, verifyingContract: safe as Hex },
    types: SAFE_TX_TYPES,
    primaryType: 'SafeTx',
    message: {
      to: tx.to as Hex,
      value: tx.value,
      data: tx.data,
      operation: tx.operation,
      safeTxGas: tx.safeTxGas,
      baseGas: tx.baseGas,
      gasPrice: tx.gasPrice,
      gasToken: tx.gasToken as Hex,
      refundReceiver: tx.refundReceiver as Hex,
      nonce: tx.nonce,
    },
  });
}

export interface MultiSendItem {
  to: string;
  value: bigint;
  data: Hex;
}

const ERC20 = parseAbi(['function transfer(address to, uint256 amount) returns (bool)']);
const MULTISEND = parseAbi(['function multiSend(bytes transactions)']);

/** A payment as a MultiSend inner call: native is a value transfer, ERC-20 is `transfer(recipient, amount)`. */
export function paymentToItem(p: Pick<Payment, 'recipient' | 'asset' | 'amount'>): MultiSendItem {
  if (p.asset === NATIVE) return { to: p.recipient, value: p.amount, data: '0x' };
  return {
    to: p.asset,
    value: 0n,
    data: encodeFunctionData({
      abi: ERC20,
      functionName: 'transfer',
      args: [p.recipient as Hex, p.amount],
    }),
  };
}

/** `operation (1) | to (20) | value (32) | dataLength (32) | data`, each item operation 0 (call). */
export function encodeMultiSend(items: MultiSendItem[]): Hex {
  return concat(
    items.map((i) =>
      encodePacked(
        ['uint8', 'address', 'uint256', 'uint256', 'bytes'],
        [0, i.to as Hex, i.value, BigInt(size(i.data)), i.data],
      ),
    ),
  );
}

export function multiSendCalldata(items: MultiSendItem[]): Hex {
  return encodeFunctionData({
    abi: MULTISEND,
    functionName: 'multiSend',
    args: [encodeMultiSend(items)],
  });
}

/** The Safe transaction the engine proposes for a bundle: delegatecall to MultiSendCallOnly, all gas fields zero. */
export function bundleTx(multiSend: string, items: MultiSendItem[], nonce: bigint): SafeTx {
  return {
    to: multiSend,
    value: 0n,
    data: multiSendCalldata(items),
    operation: 1,
    safeTxGas: 0n,
    baseGas: 0n,
    gasPrice: 0n,
    gasToken: ZERO_ADDRESS,
    refundReceiver: ZERO_ADDRESS,
    nonce,
  };
}

export type DecodedItem =
  | { kind: 'native'; recipient: string; amount: bigint }
  | { kind: 'erc20'; token: string; recipient: string; amount: bigint }
  | { kind: 'unknown'; reason: string };

const MULTISEND_SELECTOR = '0x8d80ff0a';
const TRANSFER_SELECTOR = '0xa9059cbb';

/** Decode the `multiSend(bytes)` calldata of a Safe transaction into payments; anything else is `unknown`. */
export function decodeMultiSend(data: Hex): DecodedItem[] | null {
  if (!data.toLowerCase().startsWith(MULTISEND_SELECTOR)) return null;
  const bytes = hexToBytes(data);
  // selector(4) | offset(32) | length(32) | packed items, zero-padded to a word
  if (bytes.length < 68) return null;
  const length = Number(hexToBigInt(`0x${Buffer.from(bytes.subarray(36, 68)).toString('hex')}`));
  const packed = bytes.subarray(68, 68 + length);
  if (packed.length !== length) return null;
  const items: DecodedItem[] = [];
  let o = 0;
  while (o < packed.length) {
    if (o + 85 > packed.length) {
      items.push({ kind: 'unknown', reason: 'truncated MultiSend item' });
      break;
    }
    const op = packed[o] as number;
    const to = `0x${Buffer.from(packed.subarray(o + 1, o + 21)).toString('hex')}`;
    const value = hexToBigInt(`0x${Buffer.from(packed.subarray(o + 21, o + 53)).toString('hex')}`);
    const dataLen = Number(
      hexToBigInt(`0x${Buffer.from(packed.subarray(o + 53, o + 85)).toString('hex')}`),
    );
    const inner = packed.subarray(o + 85, o + 85 + dataLen);
    o += 85 + dataLen;
    if (inner.length !== dataLen) {
      items.push({ kind: 'unknown', reason: 'truncated MultiSend item data' });
      break;
    }
    const innerHex = `0x${Buffer.from(inner).toString('hex')}`;
    if (op !== 0)
      items.push({ kind: 'unknown', reason: `inner operation ${op} (delegatecall) to ${to}` });
    else if (dataLen === 0) items.push({ kind: 'native', recipient: to, amount: value });
    else if (value === 0n && dataLen === 68 && innerHex.startsWith(TRANSFER_SELECTOR)) {
      const recipient = `0x${innerHex.slice(10 + 24, 10 + 64)}`;
      const amount = BigInt(`0x${innerHex.slice(10 + 64, 10 + 128)}`);
      items.push({ kind: 'erc20', token: to, recipient, amount });
    } else
      items.push({
        kind: 'unknown',
        reason: `call to ${to} with ${dataLen} bytes of data${value > 0n ? ` and value ${value}` : ''}`,
      });
  }
  return items;
}
