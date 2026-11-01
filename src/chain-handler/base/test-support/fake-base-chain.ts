import {
  keccak256,
  parseTransaction,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializedEIP1559,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';

import { ok, type Result } from '../../../domain/result.js';
import type { DispatchError } from '../../../domain/errors.js';
import { SignerClient, type SignRequest, type SignResponse } from '../../../signer/client.js';

export const FAKE_CHAIN_ID = 84532;
const BASE_FEE = 1_000_000n;

type Mined = { hash: Hex; from: string; nonce: number; to: string; value: bigint; ours: boolean };

/**
 * An offline Base chain behind the JSON-RPC calls `BaseChainHandler` makes:
 * one account nonce per address, a pool, and receipts. A transaction at the
 * account's next nonce is mined as soon as it is sent; one above waits in the
 * pool until the gap closes. `outsiderSends` is another sender using the same
 * wallet, which evicts any pooled transaction at the nonces it takes.
 */
export class FakeBaseChain {
  readonly mined: Mined[] = [];
  /** When false, a sent transaction only enters the pool until `mineAll`. */
  mineOnSend = true;
  /** When true, every receipt read fails as an RPC error. */
  failReceipts = false;
  /** Runs before each `eth_sendRawTransaction` is answered. */
  beforeSend: () => void = () => {};
  private readonly nonces = new Map<string, number>();
  private readonly pool = new Map<string, Map<number, { hash: Hex; raw: Hex }>>();
  private readonly receipts = new Map<Hex, Mined>();
  private outsiderCount = 0;

  nonceOf(address: string): number {
    return this.nonces.get(address.toLowerCase()) ?? 0;
  }

  /** Another sender uses `count` nonces of `address`'s wallet. */
  outsiderSends(address: string, count = 1): void {
    const from = address.toLowerCase();
    for (let i = 0; i < count; i++) {
      const nonce = this.nonceOf(from);
      this.pool.get(from)?.delete(nonce);
      const hash = keccak256(`0x${(++this.outsiderCount).toString(16).padStart(8, '0')}`);
      this.record({ hash, from, nonce, to: '0xoutsider', value: 0n, ours: false });
    }
    this.minePooled(from);
  }

  mineAll(): void {
    for (const from of this.pool.keys()) this.minePooled(from);
  }

  /** Payments this engine's key made to `to`, as the chain sees them. */
  paidTo(to: string): Mined[] {
    return this.mined.filter((m) => m.ours && m.to.toLowerCase() === to.toLowerCase());
  }

  readonly fetch: typeof fetch = async (_input, init) => {
    const request = JSON.parse(init?.body as string) as {
      id: number;
      method: string;
      params: unknown[];
    };
    const answer = await this.answer(request.method, request.params);
    return new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, ...answer }), {
      headers: { 'content-type': 'application/json' },
    });
  };

  private async answer(
    method: string,
    params: unknown[],
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    switch (method) {
      case 'eth_chainId':
        return { result: hex(FAKE_CHAIN_ID) };
      case 'eth_getTransactionCount': {
        const from = String(params[0]).toLowerCase();
        const pending = params[1] === 'pending' ? this.contiguousPooled(from) : this.nonceOf(from);
        return { result: hex(pending) };
      }
      case 'eth_getBlockByNumber':
        return { result: block() };
      case 'eth_estimateGas':
        return { result: hex(21_000) };
      case 'eth_getBalance':
        return { result: hex(10n ** 18n) };
      case 'eth_sendRawTransaction':
        this.beforeSend();
        return this.send(params[0] as Hex);
      case 'eth_getTransactionReceipt': {
        if (this.failReceipts) return { error: { code: -32603, message: 'internal error' } };
        const mined = this.receipts.get(params[0] as Hex);
        return { result: mined ? receipt(mined) : null };
      }
      default:
        return { error: { code: -32601, message: `fake chain: no ${method}` } };
    }
  }

  private async send(
    raw: Hex,
  ): Promise<{ result: unknown } | { error: { code: number; message: string } }> {
    const tx = parseTransaction(raw);
    const from = (
      await recoverTransactionAddress({
        serializedTransaction: raw as TransactionSerializedEIP1559,
      })
    ).toLowerCase();
    const hash = keccak256(raw);
    const nonce = tx.nonce ?? 0;
    if (this.receipts.has(hash)) return { error: { code: -32000, message: 'already known' } };
    const next = this.nonceOf(from);
    if (nonce < next) {
      return {
        error: { code: -32000, message: `nonce too low: next nonce ${next}, tx nonce ${nonce}` },
      };
    }
    const pooled = this.pool.get(from) ?? new Map<number, { hash: Hex; raw: Hex }>();
    const existing = pooled.get(nonce);
    if (existing?.hash === hash) return { error: { code: -32000, message: 'already known' } };
    if (existing) {
      return { error: { code: -32000, message: 'replacement transaction underpriced' } };
    }
    pooled.set(nonce, { hash, raw });
    this.pool.set(from, pooled);
    if (this.mineOnSend) this.minePooled(from);
    return { result: hash };
  }

  private contiguousPooled(from: string): number {
    let next = this.nonceOf(from);
    while (this.pool.get(from)?.has(next)) next++;
    return next;
  }

  private minePooled(from: string): void {
    const pooled = this.pool.get(from);
    for (let next = this.nonceOf(from); pooled?.has(next); next = this.nonceOf(from)) {
      const { hash, raw } = pooled.get(next)!;
      pooled.delete(next);
      const tx = parseTransaction(raw);
      this.record({ hash, from, nonce: next, to: tx.to ?? '', value: tx.value ?? 0n, ours: true });
    }
  }

  private record(mined: Mined): void {
    this.mined.push(mined);
    this.receipts.set(mined.hash, mined);
    this.nonces.set(mined.from, mined.nonce + 1);
  }
}

/** A Signer on ADR-0046's contract, signing with one in-memory key. */
export class KeySigner extends SignerClient {
  readonly key: Hex;
  readonly address: `0x${string}`;

  constructor(key: Hex = generatePrivateKey()) {
    super('http://signer.invalid', undefined);
    this.key = key;
    this.address = privateKeyToAccount(key).address;
  }

  override async requestSignature(
    request: SignRequest,
  ): Promise<Result<SignResponse, DispatchError>> {
    const hash = keccak256(Buffer.from(request.unsignedTransaction, 'base64'));
    const { r, s, yParity } = await sign({ hash, privateKey: this.key, to: 'object' });
    const signature = Buffer.concat([
      Buffer.from(r.slice(2).padStart(64, '0'), 'hex'),
      Buffer.from(s.slice(2).padStart(64, '0'), 'hex'),
      Buffer.from([yParity ?? 0]),
    ]);
    return ok({ signature: signature.toString('base64') });
  }
}

const hex = (n: number | bigint) => `0x${n.toString(16)}`;
const ZERO_HASH = `0x${'0'.repeat(64)}`;

function block() {
  return {
    number: '0x1',
    hash: ZERO_HASH,
    parentHash: ZERO_HASH,
    timestamp: '0x1',
    baseFeePerGas: hex(BASE_FEE),
    gasLimit: hex(30_000_000),
    gasUsed: '0x0',
    transactions: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    difficulty: '0x0',
    extraData: '0x',
    miner: `0x${'0'.repeat(40)}`,
    nonce: '0x0000000000000000',
    size: '0x0',
    stateRoot: ZERO_HASH,
    receiptsRoot: ZERO_HASH,
    transactionsRoot: ZERO_HASH,
    sha3Uncles: ZERO_HASH,
    uncles: [],
  };
}

function receipt(mined: Mined) {
  return {
    transactionHash: mined.hash,
    transactionIndex: '0x0',
    blockHash: ZERO_HASH,
    blockNumber: '0x1',
    from: mined.from,
    to: mined.to,
    cumulativeGasUsed: hex(21_000),
    gasUsed: hex(21_000),
    effectiveGasPrice: hex(BASE_FEE),
    contractAddress: null,
    logs: [],
    logsBloom: `0x${'0'.repeat(512)}`,
    status: '0x1',
    type: '0x2',
  };
}
