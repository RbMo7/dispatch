import { readFileSync } from 'node:fs';
import { encodeFunctionResult, hashTypedData, parseAbi, toFunctionSelector, type Hex } from 'viem';
import { describe, expect, it } from 'vitest';
import { RpcError, UsageError } from '../errors.js';
import type { Payment } from '../payments.js';
import { bundleTx, decodeMultiSend, paymentToItem, safeTxHash, type SafeTx } from './hash.js';
import type { EvmRpc } from './rpc.js';
import type { ServiceClient, ServiceTx } from './service.js';
import { verifySafe } from './verify.js';

interface Vector {
  name: string;
  safe: string;
  chainId?: number;
  tx: {
    to: string;
    value: string;
    data: string;
    operation: number;
    nonce: number;
    safeTxGas?: string;
    baseGas?: string;
    gasPrice?: string;
    gasToken?: string;
    refundReceiver?: string;
  };
  safeTxHash: string;
}
const load = (v: string) =>
  JSON.parse(
    readFileSync(new URL(`../../fixtures/safe-vectors-${v}.json`, import.meta.url), 'utf8'),
  ) as Vector[];
const V141 = load('1.4.1');
const V130 = load('1.3.0');

const SAFE_141 = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const SAFE_130 = '0xD784eeEA715626931bAb54b90b4d9cDE61d8DD97';
const MULTISEND_141 = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const MULTISEND_130 = '0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B';
const USDC = '0x036cbd53842c5426634e7929541ec2318f3dcf7e';
const R = '0x1111111111111111111111111111111111111111';
const bob = '0x2222222222222222222222222222222222222222';
const carol = '0x3333333333333333333333333333333333333333';

const ABI = parseAbi([
  'function VERSION() view returns (string)',
  'function nonce() view returns (uint256)',
  'function getThreshold() view returns (uint256)',
  'function getOwners() view returns (address[])',
]);

function fakeRpc(opts: { chainId?: number; version?: string; nonce?: bigint } = {}): EvmRpc {
  const version = opts.version ?? '1.4.1';
  const nonce = opts.nonce ?? 7n;
  const sel = (n: 'VERSION' | 'nonce' | 'getThreshold' | 'getOwners') =>
    toFunctionSelector(ABI.find((a) => a.type === 'function' && a.name === n)!);
  return {
    chainId: () => Promise.resolve(opts.chainId ?? 84532),
    call: (_to, data) => {
      const s = data.slice(0, 10);
      if (s === sel('VERSION'))
        return Promise.resolve(
          encodeFunctionResult({ abi: ABI, functionName: 'VERSION', result: version }),
        );
      if (s === sel('nonce'))
        return Promise.resolve(
          encodeFunctionResult({ abi: ABI, functionName: 'nonce', result: nonce }),
        );
      if (s === sel('getThreshold'))
        return Promise.resolve(
          encodeFunctionResult({ abi: ABI, functionName: 'getThreshold', result: 2n }),
        );
      if (s === sel('getOwners'))
        return Promise.resolve(
          encodeFunctionResult({ abi: ABI, functionName: 'getOwners', result: [R, bob, carol] }),
        );
      return Promise.reject(new Error('unexpected call'));
    },
  };
}

const pay = (recipient: string, asset: string, amount: bigint, line: number): Payment => ({
  recipient,
  asset,
  amount,
  line,
});

// The spike's v2 vector: 1 wei native to R, then 5,000,000 USDC units to R.
const vectorFile = (): Payment[] => [pay(R, 'native', 1n, 1), pay(R, USDC, 5_000_000n, 2)];

describe('hashing against the spike vectors', () => {
  for (const [label, vectors] of [
    ['1.4.1', V141],
    ['1.3.0', V130],
  ] as const) {
    for (const v of vectors) {
      it(`${label} ${v.name}`, () => {
        const tx: SafeTx = {
          to: v.tx.to,
          value: BigInt(v.tx.value),
          data: v.tx.data as Hex,
          operation: v.tx.operation as 0 | 1,
          safeTxGas: BigInt(v.tx.safeTxGas ?? 0),
          baseGas: BigInt(v.tx.baseGas ?? 0),
          gasPrice: BigInt(v.tx.gasPrice ?? 0),
          gasToken: v.tx.gasToken ?? '0x0000000000000000000000000000000000000000',
          refundReceiver: v.tx.refundReceiver ?? '0x0000000000000000000000000000000000000000',
          nonce: BigInt(v.tx.nonce),
        };
        expect(safeTxHash(v.safe, v.chainId ?? 84532, tx).toLowerCase()).toBe(
          v.safeTxHash.toLowerCase(),
        );
      });
    }
  }

  it('builds the spike MultiSend bundle byte for byte', () => {
    const v = V141[1]!;
    const tx = bundleTx(MULTISEND_141, vectorFile().map(paymentToItem), 7n);
    expect(tx.data.toLowerCase()).toBe(v.tx.data.toLowerCase());
    expect(safeTxHash(SAFE_141, 84532, tx).toLowerCase()).toBe(v.safeTxHash.toLowerCase());
  });

  it('decodes MultiSend calldata back to the payments', () => {
    const items = decodeMultiSend(V141[1]!.tx.data as Hex);
    expect(items).toEqual([
      { kind: 'native', recipient: R, amount: 1n },
      { kind: 'erc20', token: USDC, recipient: R, amount: 5_000_000n },
    ]);
  });
});

describe('verifySafe: hash check', () => {
  const base = { safe: SAFE_141, bundleSize: 50, rpc: fakeRpc(), nonce: 7n };

  it('MATCH on the 1.4.1 vector', async () => {
    const r = await verifySafe({
      ...base,
      payments: vectorFile(),
      safeTxHash: V141[1]!.safeTxHash,
    });
    expect(r.verdict).toBe('MATCH');
    expect(r.chunk).toEqual({ index: 1, of: 1, firstLine: 1, lastLine: 2 });
    expect(Object.fromEntries(r.facts)['MultiSend']).toContain(MULTISEND_141);
    expect(Object.fromEntries(r.facts)['Status']).toMatch(/next in the Safe queue/);
  });

  it('MATCH is case-insensitive in the supplied hash and the file addresses', async () => {
    const r = await verifySafe({
      ...base,
      payments: vectorFile(),
      safeTxHash: V141[1]!.safeTxHash.toUpperCase().replace('0X', '0x'),
    });
    expect(r.verdict).toBe('MATCH');
  });

  it('MATCH for Safe 1.3.0, using the 1.3.0 MultiSendCallOnly', async () => {
    const payments = vectorFile();
    const tx = bundleTx(MULTISEND_130, payments.map(paymentToItem), 7n);
    // independent computation of the expected hash with viem's own typed-data hashing
    const expected = hashTypedData({
      domain: { chainId: 84532, verifyingContract: SAFE_130 },
      types: {
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
      },
      primaryType: 'SafeTx',
      message: {
        ...tx,
        to: tx.to as Hex,
        gasToken: tx.gasToken as Hex,
        refundReceiver: tx.refundReceiver as Hex,
      },
    });
    const r = await verifySafe({
      ...base,
      safe: SAFE_130,
      rpc: fakeRpc({ version: '1.3.0' }),
      payments,
      safeTxHash: expected,
    });
    expect(r.verdict).toBe('MATCH');
    expect(Object.fromEntries(r.facts)['MultiSend']).toContain(MULTISEND_130);
  });

  it('strips a +L2 suffix from VERSION()', async () => {
    const r = await verifySafe({
      ...base,
      rpc: fakeRpc({ version: '1.4.1+L2' }),
      payments: vectorFile(),
      safeTxHash: V141[1]!.safeTxHash,
    });
    expect(r.verdict).toBe('MATCH');
  });

  describe('chunks of a longer file', () => {
    const file = [
      pay(R, 'native', 1n, 1),
      pay(R, USDC, 5_000_000n, 2),
      pay(bob, 'native', 10n, 3),
      pay(carol, USDC, 20n, 4),
      pay(bob, USDC, 30n, 5),
    ];
    const hashOf = (chunk: Payment[], nonce = 7n) =>
      safeTxHash(SAFE_141, 84532, bundleTx(MULTISEND_141, chunk.map(paymentToItem), nonce));

    it('says which chunk matched: first', async () => {
      const r = await verifySafe({
        ...base,
        bundleSize: 2,
        payments: file,
        safeTxHash: hashOf(file.slice(0, 2)),
      });
      expect(r.verdict).toBe('MATCH');
      expect(r.chunk).toEqual({ index: 1, of: 3, firstLine: 1, lastLine: 2 });
    });
    it('second', async () => {
      const r = await verifySafe({
        ...base,
        bundleSize: 2,
        payments: file,
        safeTxHash: hashOf(file.slice(2, 4)),
      });
      expect(r.verdict).toBe('MATCH');
      expect(r.chunk).toEqual({ index: 2, of: 3, firstLine: 3, lastLine: 4 });
      expect(r.comparison?.matched).toHaveLength(2);
    });
    it('last, short chunk', async () => {
      const r = await verifySafe({
        ...base,
        bundleSize: 2,
        payments: file,
        safeTxHash: hashOf(file.slice(4)),
      });
      expect(r.chunk).toMatchObject({ index: 3, firstLine: 5, lastLine: 5 });
    });
    it('MISMATCH with the wrong bundle size', async () => {
      const r = await verifySafe({
        ...base,
        bundleSize: 3,
        payments: file,
        safeTxHash: hashOf(file.slice(2, 4)),
      });
      expect(r.verdict).toBe('MISMATCH');
      expect(r.problems.join('\n')).toMatch(/not the hash of any of the 2 chunk/);
    });
    it('MISMATCH when the payments are reordered', async () => {
      const r = await verifySafe({
        ...base,
        bundleSize: 2,
        payments: file,
        safeTxHash: hashOf([file[1]!, file[0]!]),
      });
      expect(r.verdict).toBe('MISMATCH');
    });
  });

  it('MISMATCH: a changed amount in the file', async () => {
    const file = vectorFile();
    file[1] = pay(R, USDC, 5_000_001n, 2);
    const r = await verifySafe({ ...base, payments: file, safeTxHash: V141[1]!.safeTxHash });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.chunk).toBeUndefined();
    expect(r.notes.join('\n')).toMatch(/--tx-service-url/);
  });

  it('MISMATCH: wrong nonce, and says which nonce does match', async () => {
    const r = await verifySafe({
      ...base,
      nonce: 8n,
      payments: vectorFile(),
      safeTxHash: V141[1]!.safeTxHash,
    });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.problems.join('\n')).toMatch(/IS chunk 1 .* at nonce 7/);
  });

  it('MISMATCH: wrong Safe', async () => {
    const r = await verifySafe({
      ...base,
      safe: SAFE_130,
      payments: vectorFile(),
      safeTxHash: V141[1]!.safeTxHash,
    });
    expect(r.verdict).toBe('MISMATCH');
  });

  it('MISMATCH: wrong chain (the RPC reports another chain id)', async () => {
    const r = await verifySafe({
      ...base,
      rpc: fakeRpc({ chainId: 8453 }),
      payments: vectorFile(),
      safeTxHash: V141[1]!.safeTxHash,
    });
    expect(r.verdict).toBe('MISMATCH');
    expect(Object.fromEntries(r.facts)['Chain']).toContain('Base (chain id 8453)');
  });

  it('MISMATCH: wrong asset (ERC-20 vs native)', async () => {
    const file = [pay(R, 'native', 1n, 1), pay(R, 'native', 5_000_000n, 2)];
    const r = await verifySafe({ ...base, payments: file, safeTxHash: V141[1]!.safeTxHash });
    expect(r.verdict).toBe('MISMATCH');
  });

  it('defaults the nonce to the Safe nonce and says so; reports an already-passed nonce', async () => {
    const r = await verifySafe({
      ...base,
      nonce: undefined,
      rpc: fakeRpc({ nonce: 7n }),
      payments: vectorFile(),
      safeTxHash: V141[1]!.safeTxHash,
    });
    expect(r.verdict).toBe('MATCH');
    expect(r.notes.join('\n')).toMatch(/assumed the Safe's current nonce 7/);
    const old = await verifySafe({
      ...base,
      rpc: fakeRpc({ nonce: 9n }),
      payments: vectorFile(),
      safeTxHash: V141[1]!.safeTxHash,
    });
    expect(old.verdict).toBe('MATCH');
    expect(Object.fromEntries(old.facts)['Status']).toMatch(/already 9/);
  });

  it('errors (exit 2) on an unsupported Safe version and on no hash', async () => {
    await expect(
      verifySafe({
        ...base,
        rpc: fakeRpc({ version: '1.5.0' }),
        payments: vectorFile(),
        safeTxHash: V141[1]!.safeTxHash,
      }),
    ).rejects.toBeInstanceOf(RpcError);
    await expect(verifySafe({ ...base, payments: vectorFile() })).rejects.toBeInstanceOf(
      UsageError,
    );
  });
});

describe('verifySafe: Transaction Service cross-check', () => {
  const file = [pay(R, 'native', 1n, 1), pay(R, USDC, 5_000_000n, 2), pay(bob, 'native', 10n, 3)];
  const toService = (tx: SafeTx, extra: Partial<ServiceTx> = {}): ServiceTx => ({
    safe: SAFE_141,
    to: tx.to,
    value: String(tx.value),
    data: tx.data,
    operation: tx.operation,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: tx.gasToken,
    refundReceiver: tx.refundReceiver,
    nonce: String(tx.nonce),
    safeTxHash: safeTxHash(SAFE_141, 84532, tx),
    isExecuted: false,
    isSuccessful: null,
    confirmationsRequired: 2,
    confirmations: [{}],
    ...extra,
  });
  const client = (txs: ServiceTx[]): ServiceClient => ({
    getTx: (h) =>
      Promise.resolve(txs.find((t) => t.safeTxHash.toLowerCase() === h.toLowerCase()) ?? null),
    listByNonce: (_s, n) => Promise.resolve(txs.filter((t) => BigInt(t.nonce) === n)),
  });
  const base = { safe: SAFE_141, bundleSize: 3, rpc: fakeRpc() };

  it('MATCH, with the service status', async () => {
    const tx = bundleTx(MULTISEND_141, file.map(paymentToItem), 7n);
    const r = await verifySafe({
      ...base,
      payments: file,
      safeTxHash: safeTxHash(SAFE_141, 84532, tx),
      service: client([toService(tx)]),
    });
    expect(r.verdict).toBe('MATCH');
    expect(Object.fromEntries(r.facts)['Status']).toMatch(/Awaiting.*1 of 2/);
  });

  it('looks the proposal up from --nonce alone', async () => {
    const tx = bundleTx(MULTISEND_141, file.map(paymentToItem), 7n);
    const r = await verifySafe({
      ...base,
      payments: file,
      nonce: 7n,
      service: client([toService(tx)]),
    });
    expect(r.verdict).toBe('MATCH');
  });

  it('MISMATCH with a per-line diff against the closest chunk', async () => {
    const tampered = [
      pay(R, 'native', 1n, 1),
      pay(R, USDC, 9_000_000n, 2),
      pay(bob, 'native', 10n, 3),
      pay(carol, 'native', 99n, 4),
    ];
    const tx = bundleTx(MULTISEND_141, tampered.map(paymentToItem), 7n);
    const r = await verifySafe({
      ...base,
      payments: file,
      safeTxHash: safeTxHash(SAFE_141, 84532, tx),
      service: client([toService(tx)]),
    });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.comparison?.matched).toHaveLength(2);
    expect(r.comparison?.mismatches.map((m) => m.kind).sort()).toEqual(['amount', 'extra']);
  });

  it('MISMATCH: an unrecognized item inside the MultiSend', async () => {
    const tx = bundleTx(
      MULTISEND_141,
      [...file.map(paymentToItem), { to: bob, value: 0n, data: '0xdeadbeef' }],
      7n,
    );
    const r = await verifySafe({
      ...base,
      payments: file,
      safeTxHash: safeTxHash(SAFE_141, 84532, tx),
      service: client([toService(tx)]),
    });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.problems.join('\n')).toMatch(/unrecognized instruction/);
  });

  it('MISMATCH: the service lies about the data (it does not re-hash to the hash owners see)', async () => {
    const real = bundleTx(MULTISEND_141, file.map(paymentToItem), 7n);
    const lie = bundleTx(MULTISEND_141, file.slice(0, 2).map(paymentToItem), 7n);
    const r = await verifySafe({
      ...base,
      payments: file,
      safeTxHash: safeTxHash(SAFE_141, 84532, real),
      service: client([toService(lie, { safeTxHash: safeTxHash(SAFE_141, 84532, real) })]),
    });
    expect(r.verdict).toBe('MISMATCH');
    expect(r.problems.join('\n')).toMatch(/service data cannot be trusted/);
  });

  it('asks for the hash when several proposals share a nonce', async () => {
    const a = bundleTx(MULTISEND_141, file.map(paymentToItem), 7n);
    const b = bundleTx(MULTISEND_141, file.slice(0, 1).map(paymentToItem), 7n);
    await expect(
      verifySafe({
        ...base,
        payments: file,
        nonce: 7n,
        service: client([toService(a), toService(b)]),
      }),
    ).rejects.toThrow(/pass the one you are voting on/);
  });
});
