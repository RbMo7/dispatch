import { hashTypedData, encodePacked, encodeFunctionData, parseAbi, concat, pad, toHex, hexToBigInt, size } from 'viem';
export const ZERO = '0x0000000000000000000000000000000000000000';
export const SAFE_TX_TYPES = { SafeTx: [
  { type: 'address', name: 'to' }, { type: 'uint256', name: 'value' }, { type: 'bytes', name: 'data' },
  { type: 'uint8', name: 'operation' }, { type: 'uint256', name: 'safeTxGas' }, { type: 'uint256', name: 'baseGas' },
  { type: 'uint256', name: 'gasPrice' }, { type: 'address', name: 'gasToken' }, { type: 'address', name: 'refundReceiver' },
  { type: 'uint256', name: 'nonce' } ] };
export const typedData = (safe, chainId, tx) => ({
  domain: { chainId, verifyingContract: safe }, types: SAFE_TX_TYPES, primaryType: 'SafeTx',
  message: { to: tx.to, value: BigInt(tx.value ?? 0), data: tx.data ?? '0x', operation: tx.operation ?? 0, safeTxGas: BigInt(tx.safeTxGas ?? 0),
    baseGas: BigInt(tx.baseGas ?? 0), gasPrice: BigInt(tx.gasPrice ?? 0), gasToken: tx.gasToken ?? ZERO, refundReceiver: tx.refundReceiver ?? ZERO, nonce: BigInt(tx.nonce) } });
export const safeTxHash = (safe, chainId, tx) => hashTypedData(typedData(safe, chainId, tx));
// MultiSend: each = operation(1) | to(20) | value(32) | dataLength(32) | data
export const encodeMultiSendTxs = (items) => concat(items.map((i) => encodePacked(['uint8','address','uint256','uint256','bytes'], [i.operation ?? 0, i.to, BigInt(i.value ?? 0), BigInt(size(i.data ?? '0x')), i.data ?? '0x'])));
export const multiSendCalldata = (items) => encodeFunctionData({ abi: parseAbi(['function multiSend(bytes transactions)']), functionName: 'multiSend', args: [encodeMultiSendTxs(items)] });
export const erc20Transfer = (to, amt) => encodeFunctionData({ abi: parseAbi(['function transfer(address,uint256) returns (bool)']), functionName: 'transfer', args: [to, amt] });
export const SAFE_ABI = parseAbi([
  'function VERSION() view returns (string)', 'function nonce() view returns (uint256)', 'function getThreshold() view returns (uint256)', 'function getOwners() view returns (address[])',
  'function getTransactionHash(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 _nonce) view returns (bytes32)',
  'function execTransaction(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,bytes signatures) payable returns (bool)',
  'function approveHash(bytes32 hashToApprove)', 'function approvedHashes(address,bytes32) view returns (uint256)',
  'function getModulesPaginated(address start,uint256 pageSize) view returns (address[] array,address next)',
  'function domainSeparator() view returns (bytes32)', 'function isOwner(address) view returns (bool)',
  'event ExecutionSuccess(bytes32 txHash,uint256 payment)', 'event ExecutionFailure(bytes32 txHash,uint256 payment)', 'event ApproveHash(bytes32 indexed approvedHash,address indexed owner)']);
// signatures: 65 bytes each r|s|v, sorted ascending by owner address. v=27/28 ECDSA over safeTxHash; v=1: pre-approved (r=owner, s=0)
export const ecdsaSig = (sig) => sig; // viem sign() output is already r|s|v with v=27/28
export const approvedHashSig = (owner) => concat([pad(owner, { size: 32 }), pad('0x00', { size: 32 }), '0x01']);
export function packSignatures(entries /* [{owner, sig}] */) {
  return concat([...entries].sort((a, b) => (BigInt(a.owner) < BigInt(b.owner) ? -1 : 1)).map((e) => e.sig));
}
