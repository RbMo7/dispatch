import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { recoverAddress, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import type { DispatchError } from '../../../domain/errors.js';
import { err, ok, type Result } from '../../../domain/result.js';
import type { SafeSignRequest } from '../../../signer/client.js';
import { safeTransactionHash } from '../../../signer/safe-transaction.js';
import {
  MULTI_SEND_CALL_ONLY,
  SAFE_PROPOSAL_ORIGIN,
  SafeApproval,
  encodeMultiSendCall,
  type SafeApprovalClient,
  type SafeApprovalDeps,
} from './safe-approval.js';
import type { BaseSafeConfig } from './safe-config.js';
import { SafeTxServiceClient } from './tx-service-client.js';

const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const KEY = '0x59c6995e998f97a5a0044966f0945389dc9e86dae88c7a8412f4603b6b78690d' as const;
const executor = privateKeyToAccount(KEY);
const API_KEY = 'sk_live_super_secret_key';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const C = '0x3333333333333333333333333333333333333333';

// transfer(address,uint256): selector a9059cbb, then the recipient and amount as 32-byte words.
const erc20 = (to: string, amount: bigint): string =>
  `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`;

const nativeCall = (to: string, value: string) => ({ to, value, data: '0x' });
const usdcCall = (to: string, amount: bigint) => ({
  to: USDC,
  value: '0',
  data: erc20(to, amount),
});

/** Independently computed (viem, .scratch/safe-multisig-base/spike-vectors/lib.mjs): 0.5 ETH to A, 5 USDC to B, 7 wei to C, 250 USDC units to A, Safe nonce 12. */
const BUNDLE_VECTOR = {
  data: '0x8d80ff0a000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000001dc00111111111111111111111111111111111111111100000000000000000000000000000000000000000000000006f05b59d3b20000000000000000000000000000000000000000000000000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000222222222222222222222222222222222222222200000000000000000000000000000000000000000000000000000000004c4b400033333333333333333333333333333333333333330000000000000000000000000000000000000000000000000000000000000007000000000000000000000000000000000000000000000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000000000fa00000000',
  hash: '0x27fb7d5435b14b95246b765dbe174522b3732b8b73303ce9688504bc18f0465b',
};
const BUNDLE_CALLS = [
  nativeCall(A, '500000000000000000'),
  usdcCall(B, 5_000_000n),
  nativeCall(C, '7'),
  usdcCall(A, 250n),
];

/** The #79 spike's v2 vector (vectors.json): 1 wei to A and a 5 USDC transfer to A, nonce 7. */
const SPIKE_V2 = {
  data: '0x8d80ff0a000000000000000000000000000000000000000000000000000000000000002000000000000000000000000000000000000000000000000000000000000000ee0011111111111111111111111111111111111111110000000000000000000000000000000000000000000000000000000000000001000000000000000000000000000000000000000000000000000000000000000000036cbd53842c5426634e7929541ec2318f3dcf7e00000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000000044a9059cbb000000000000000000000000111111111111111111111111111111111111111100000000000000000000000000000000000000000000000000000000004c4b40000000000000000000000000000000000000',
  hash: '0x4ad3beb568f992d2a87b4ab1dcb66bef600254d0b1c428aa15ff842fde28860b',
};

const config: BaseSafeConfig = {
  safeAddress: SAFE,
  executorAddress: executor.address,
  txServiceUrl: 'http://unused',
  apiKey: API_KEY,
  approvalDeadlineMs: 1,
  approvalRewatchWindowMs: 1,
  bundleLimit: 3,
};
const big = { ...config, bundleLimit: 50 };

type Read = { method: string; blockNumber?: bigint | undefined };

function fakeChain(
  opts: { nonce?: bigint; threshold?: bigint; version?: string; code?: Hex } = {},
) {
  const reads: Read[] = [];
  let latest = 900n;
  const client = {
    getChainId: () => Promise.resolve(84532),
    getBlockNumber: () => Promise.resolve(latest++),
    getCode: (a: { blockNumber?: bigint }) => {
      reads.push({ method: 'getCode', blockNumber: a.blockNumber });
      return Promise.resolve(opts.code ?? '0x6080');
    },
    getStorageAt: (a: { blockNumber?: bigint }) => {
      reads.push({ method: 'getStorageAt', blockNumber: a.blockNumber });
      return Promise.resolve('0x0');
    },
    getBlock: () => Promise.resolve({ baseFeePerGas: 1_000_000n }),
    call: () => Promise.reject(new Error('not expected')),
    estimateGas: () => Promise.reject(new Error('not expected')),
    readContract: (a: { functionName: string; blockNumber?: bigint }) => {
      // The L1 data fee read is the oracle's, not the Safe's: not a pinned Safe read.
      if (a.functionName === 'getL1Fee') return Promise.resolve(1_000n);
      reads.push({ method: a.functionName, blockNumber: a.blockNumber });
      switch (a.functionName) {
        case 'VERSION':
          return Promise.resolve(opts.version ?? '1.4.1');
        case 'getOwners':
          return Promise.resolve([A, B]);
        case 'getThreshold':
          return Promise.resolve(opts.threshold ?? 2n);
        case 'nonce':
          return Promise.resolve(opts.nonce ?? 12n);
        default:
          return Promise.resolve([[], '0x0000000000000000000000000000000000000001']);
      }
    },
  };
  return { client: client as unknown as SafeApprovalClient, reads };
}

/** A Signer that really signs the digest (v 27 or 28, as the real one answers), so the body's signature is checkable. */
function realSigner(): { signer: SafeApprovalDeps['signer']; requests: SafeSignRequest[] } {
  const requests: SafeSignRequest[] = [];
  return {
    requests,
    signer: {
      signSafeTransaction: async (request) => {
        requests.push(request);
        const signature = await sign({
          hash: safeTransactionHash(request.safeTransaction),
          privateKey: KEY,
          to: 'hex',
        });
        const v = Number.parseInt(signature.slice(-2), 16);
        const fixed = v < 27 ? v + 27 : v;
        return ok(`${signature.slice(0, -2)}${fixed.toString(16)}` as Hex);
      },
    },
  };
}

const neverCalled: SafeApprovalDeps['service'] = {
  proposeTransaction: () => Promise.reject(new Error('not expected')),
  getMultisigTransaction: () => Promise.reject(new Error('not expected')),
  listTransactionsAtNonce: () => Promise.reject(new Error('not expected')),
};

function approval(
  chain = fakeChain(),
  extra: Partial<SafeApprovalDeps> & { config?: BaseSafeConfig } = {},
) {
  const { signer, requests } = realSigner();
  const deps: SafeApprovalDeps = {
    config,
    chainId: 84532,
    client: chain.client,
    signer,
    service: neverCalled,
    knownTokens: { USDC: { contractAddress: USDC, decimals: 6 } },
    prepare: () => Promise.reject(new Error('not expected')),
    ...extra,
  };
  return { subject: new SafeApproval(deps), deps, requests, chain };
}

function expectOk<T>(result: Result<T, DispatchError>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

describe('SafeApproval constants', () => {
  it('declares the Safe flavor of the capability', () => {
    const { subject } = approval();
    expect(subject.proposerAddress).toBe(executor.address);
    expect(subject.openProposalLimit).toBe(1);
    expect(subject.watchIntervalMs).toBe(60_000);
  });

  it('refuses a bundle limit outside 1..300', () => {
    const { deps } = approval();
    for (const bundleLimit of [0, 301, 1.5]) {
      expect(() => new SafeApproval({ ...deps, config: { ...config, bundleLimit } })).toThrow(
        /bundle limit/,
      );
    }
  });
});

describe('planBundles', () => {
  it('splits at the bundle limit, every index once and in order', () => {
    const { subject } = approval();
    const calls = Array.from({ length: 7 }, (_, i) => nativeCall(A, String(i + 1)));
    expect(expectOk(subject.planBundles(calls))).toEqual([[0, 1, 2], [3, 4, 5], [6]]);
  });

  it('puts a small Dispatch in one bundle and an empty one in none', () => {
    const { subject } = approval();
    expect(expectOk(subject.planBundles(BUNDLE_CALLS.slice(0, 3)))).toEqual([[0, 1, 2]]);
    expect(expectOk(subject.planBundles([]))).toEqual([]);
  });

  it.each([
    ['a raw contract call', { to: A, value: '0', data: '0xdeadbeef' }, /not a configured token/],
    [
      'a call to an unknown token',
      { to: B, value: '0', data: erc20(A, 1n) },
      /not a configured token/,
    ],
    ['a token call carrying ETH', { to: USDC, value: '1', data: erc20(A, 1n) }, /no ETH value/],
    [
      'a token function other than transfer',
      { to: USDC, value: '0', data: `0x095ea7b3${'00'.repeat(64)}` },
      /not an ERC-20 transfer/,
    ],
    [
      'a transfer with trailing bytes',
      { to: USDC, value: '0', data: `${erc20(A, 1n)}00` },
      /not canonical|not an ERC-20/,
    ],
  ])('refuses %s, failing the whole Dispatch', (_name, call, message) => {
    const result = approval().subject.planBundles([nativeCall(A, '1'), call]);
    expect(result).toMatchObject({ ok: false, error: { code: 'CHAIN_REJECTED' } });
    expect(result.ok ? '' : result.error.message).toMatch(message);
  });

  it('refuses a malformed call the way the Base handler does', () => {
    const result = approval().subject.planBundles([nativeCall('nope', '1')]);
    expect(result).toMatchObject({ ok: false, error: { code: 'INVALID_RECIPIENT' } });
  });
});

describe('encodeMultiSendCall', () => {
  it('matches the spike encoding for native and ERC-20 items', () => {
    const data = encodeMultiSendCall([
      { to: A, value: 1n, data: '0x' },
      { to: USDC, value: 0n, data: erc20(A, 5_000_000n) as Hex },
    ]);
    expect(data).toBe(SPIKE_V2.data);
  });
});

describe('buildProposal', () => {
  it('builds the MultiSendCallOnly delegatecall whose bytes and hash match the independent vector', async () => {
    const { subject } = approval(fakeChain({ nonce: 12n }), { config: big });
    const built = expectOk(await subject.buildProposal({ calls: BUNDLE_CALLS, sender: SAFE }));

    expect(JSON.parse(built.payload)).toEqual({
      safe: SAFE,
      chainId: 84532,
      to: MULTI_SEND_CALL_ONLY['1.4.1'],
      value: '0',
      data: BUNDLE_VECTOR.data,
      operation: 1,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      gasToken: '0x0000000000000000000000000000000000000000',
      refundReceiver: '0x0000000000000000000000000000000000000000',
      nonce: '12',
      safeTxHash: BUNDLE_VECTOR.hash,
    });
    expect(built.proposalRef).toBe(BUNDLE_VECTOR.hash);
    expect(built.sequence).toBe(12);
    expect(built.chainRef).toEqual({
      kind: 'safe',
      safe: SAFE,
      safeTxHash: BUNDLE_VECTOR.hash,
      nonce: 12,
    });
    expect(built.threshold).toBe(2);
    expect(built.executeAfter).toBeNull();
  });

  it('reproduces the spike v2 vector (nonce 7)', async () => {
    const { subject } = approval(fakeChain({ nonce: 7n }));
    const built = expectOk(
      await subject.buildProposal({
        calls: [nativeCall(A, '1'), usdcCall(A, 5_000_000n)],
        sender: SAFE,
      }),
    );
    expect(built.proposalRef).toBe(SPIKE_V2.hash);
    expect(JSON.parse(built.payload)).toMatchObject({ data: SPIKE_V2.data, nonce: '7' });
  });

  it('describes this bundle in `expected` and `committed`', async () => {
    const { subject } = approval(fakeChain(), { config: big });
    const built = expectOk(await subject.buildProposal({ calls: BUNDLE_CALLS, sender: SAFE }));
    const totals = [
      { asset: 'ETH', amount: '500000000000000007' },
      { asset: 'USDC', amount: '5000250' },
    ];
    // Four payments to three distinct recipients (A is paid twice).
    expect(built.expected).toEqual({ recipients: 3, totals });
    // The payments leave the Safe; the execute's gas (a positive amount, priced in #85) leaves the executor.
    expect(built.committed.sender).toEqual(totals);
    expect(built.committed.proposer).toEqual([
      { asset: 'ETH', amount: expect.stringMatching(/^[1-9]\d*$/) as string },
    ]);
  });

  it('reads the nonce and threshold from the chain, every read at one pinned block', async () => {
    const chain = fakeChain({ nonce: 41n, threshold: 3n });
    const built = expectOk(
      await approval(chain).subject.buildProposal({ calls: [nativeCall(A, '1')], sender: SAFE }),
    );
    expect(built.sequence).toBe(41);
    expect(built.threshold).toBe(3);
    expect(new Set(chain.reads.map((read) => read.blockNumber))).toEqual(new Set([900n]));
    expect(chain.reads.map((read) => read.method)).toEqual(
      expect.arrayContaining(['nonce', 'getThreshold', 'VERSION']),
    );
  });

  it('targets the 1.3.0 MultiSendCallOnly for a 1.3.0 Safe', async () => {
    const built = expectOk(
      await approval(fakeChain({ version: '1.3.0' })).subject.buildProposal({
        calls: [nativeCall(A, '1')],
        sender: SAFE,
      }),
    );
    expect(JSON.parse(built.payload)).toMatchObject({ to: MULTI_SEND_CALL_ONLY['1.3.0'] });
  });

  it('refuses another sender, an oversized or empty bundle, and an unsupported Safe', async () => {
    const { subject } = approval();
    const build = (calls: ReturnType<typeof nativeCall>[], sender = SAFE) =>
      subject.buildProposal({ calls, sender });
    expect(await build([nativeCall(A, '1')], A)).toMatchObject({ ok: false });
    expect(await build([])).toMatchObject({ ok: false });
    expect(await build(Array.from({ length: 4 }, () => nativeCall(A, '1')))).toMatchObject({
      ok: false,
    });
    expect(
      await approval(fakeChain({ version: '1.2.0' })).subject.buildProposal({
        calls: [nativeCall(A, '1')],
        sender: SAFE,
      }),
    ).toMatchObject({ ok: false, error: { code: 'CHAIN_REJECTED' } });
    const noCode = await approval(fakeChain({ code: '0x' })).subject.buildProposal({
      calls: [nativeCall(A, '1')],
      sender: SAFE,
    });
    expect(noCode.ok ? '' : noCode.error.message).toMatch(/not a Safe/);
  });

  it('reports an unreachable node as RPC_UNAVAILABLE', async () => {
    const down = {
      getChainId: () => Promise.reject(new Error('connect ECONNREFUSED')),
      getBlockNumber: () => Promise.reject(new Error('connect ECONNREFUSED')),
    } as unknown as SafeApprovalClient;
    const result = await approval(fakeChain(), { client: down }).subject.buildProposal({
      calls: [nativeCall(A, '1')],
      sender: SAFE,
    });
    expect(result).toMatchObject({ ok: false, error: { code: 'RPC_UNAVAILABLE' } });
  });
});

describe('signProposal', () => {
  async function built() {
    const ctx = approval(fakeChain({ nonce: 12n }), { config: big });
    const proposal = expectOk(
      await ctx.subject.buildProposal({ calls: BUNDLE_CALLS, sender: SAFE }),
    );
    return { ...ctx, proposal };
  }

  it('asks the Signer for the delegate signature as the executor and returns the exact POST body', async () => {
    const { subject, requests, proposal } = await built();
    const signed = expectOk(await subject.signProposal(proposal));

    expect(requests).toHaveLength(1);
    expect(requests[0]).toMatchObject({
      chain: 'base',
      address: executor.address,
      safeTransaction: { safe: SAFE, chainId: 84532, operation: 1, nonce: '12', value: '0' },
    });
    expect(signed.hash).toBe(BUNDLE_VECTOR.hash);

    const body = JSON.parse(signed.signedBytes) as Record<string, unknown> & { signature: Hex };
    expect(Object.keys(body).sort()).toEqual(
      [
        'baseGas',
        'contractTransactionHash',
        'data',
        'gasPrice',
        'gasToken',
        'nonce',
        'operation',
        'origin',
        'refundReceiver',
        'safeTxGas',
        'sender',
        'signature',
        'to',
        'value',
      ].sort(),
    );
    expect(body).toMatchObject({
      to: MULTI_SEND_CALL_ONLY['1.4.1'],
      value: '0',
      data: BUNDLE_VECTOR.data,
      operation: 1,
      safeTxGas: '0',
      baseGas: '0',
      gasPrice: '0',
      nonce: 12,
      sender: executor.address,
      contractTransactionHash: BUNDLE_VECTOR.hash,
      origin: SAFE_PROPOSAL_ORIGIN,
    });
    expect(
      await recoverAddress({ hash: BUNDLE_VECTOR.hash as Hex, signature: body.signature }),
    ).toBe(executor.address);
  });

  it.each(['SIGNER_REFUSED', 'SIGNER_UNREACHABLE'] as const)(
    'passes a %s from the Signer through unchanged',
    async (code) => {
      const { proposal } = await built();
      const failing = approval(fakeChain(), {
        signer: {
          signSafeTransaction: () => Promise.resolve(err({ code, message: 'policy says no' })),
        },
      }).subject;
      expect(await failing.signProposal(proposal)).toEqual({
        ok: false,
        error: { code, message: 'policy says no' },
      });
    },
  );

  it('refuses a payload that does not hash to its safeTxHash, never reaching the Signer', async () => {
    const { subject, requests, proposal } = await built();
    const tampered = { ...(JSON.parse(proposal.payload) as object), value: '1' };
    expect(
      await subject.signProposal({ ...proposal, payload: JSON.stringify(tampered) }),
    ).toMatchObject({ ok: false, error: { code: 'CHAIN_REJECTED' } });
    expect(await subject.signProposal({ ...proposal, payload: 'not json' })).toMatchObject({
      ok: false,
    });
    expect(requests).toHaveLength(0);
  });
});

type Seen = { method: string; url: string; authorization: string | undefined; body: string };
let server: Server | undefined;
afterEach(() => server?.close());

/** A local fake Safe Transaction Service answering the nth request with `statuses[n]` (201 when it runs out). */
async function startService(statuses: number[], responseBody = '') {
  const seen: Seen[] = [];
  server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      seen.push({
        method: req.method ?? '',
        url: req.url ?? '',
        authorization: req.headers.authorization,
        body: Buffer.concat(chunks).toString(),
      });
      res.writeHead(statuses[seen.length - 1] ?? 201, { 'content-type': 'application/json' });
      res.end(responseBody);
    });
  });
  await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return { baseUrl: `http://127.0.0.1:${port}/tx-service/basesep`, seen };
}

describe('submitProposal', () => {
  async function signedFor(baseUrl: string, keyed = true) {
    const ctx = approval(fakeChain({ nonce: 12n }), {
      config: big,
      service: new SafeTxServiceClient({ baseUrl, apiKey: keyed ? API_KEY : undefined }),
    });
    const proposal = expectOk(
      await ctx.subject.buildProposal({ calls: BUNDLE_CALLS, sender: SAFE }),
    );
    return { subject: ctx.subject, signed: expectOk(await ctx.subject.signProposal(proposal)) };
  }

  it('POSTs the signed body to the Safe path with the bearer key, and treats an empty 201 as success', async () => {
    const { baseUrl, seen } = await startService([201]);
    const { subject, signed } = await signedFor(baseUrl);
    expect(await subject.submitProposal(signed)).toEqual({ ok: true, value: undefined });
    expect(seen).toHaveLength(1);
    expect(seen[0]?.method).toBe('POST');
    expect(seen[0]?.url).toBe(`/tx-service/basesep/api/v2/safes/${SAFE}/multisig-transactions/`);
    expect(seen[0]?.authorization).toBe(`Bearer ${API_KEY}`);
    expect(JSON.parse(seen[0]?.body ?? '')).toEqual(JSON.parse(signed.signedBytes));
  });

  it('sends no Authorization header without a key', async () => {
    const { baseUrl, seen } = await startService([201]);
    const { subject, signed } = await signedFor(baseUrl, false);
    await subject.submitProposal(signed);
    expect(seen[0]?.authorization).toBeUndefined();
  });

  it('is idempotent: posting the same bytes again succeeds again with the identical body', async () => {
    const { baseUrl, seen } = await startService([201, 201], '{}');
    const { subject, signed } = await signedFor(baseUrl);
    expect((await subject.submitProposal(signed)).ok).toBe(true);
    expect((await subject.submitProposal(signed)).ok).toBe(true);
    expect(seen[1]?.body).toBe(seen[0]?.body);
  });

  it.each([
    [401, 'CHAIN_REJECTED', /API key/],
    [422, 'CHAIN_REJECTED', /not a registered delegate/],
    [400, 'CHAIN_REJECTED', /refused the proposal/],
    [429, 'RPC_UNAVAILABLE', /429/],
    [500, 'RPC_UNAVAILABLE', /500/],
    [503, 'RPC_UNAVAILABLE', /503/],
  ] as const)('maps HTTP %i to %s, never leaking the API key', async (status, code, message) => {
    const { baseUrl } = await startService([status], JSON.stringify({ detail: 'nope' }));
    const { subject, signed } = await signedFor(baseUrl);
    const result = await subject.submitProposal(signed);
    expect(result).toMatchObject({ ok: false, error: { code } });
    const error = result.ok ? undefined : result.error;
    expect(error?.message).toMatch(message);
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it('reports an unreachable service as RPC_UNAVAILABLE', async () => {
    const { subject, signed } = await signedFor('http://127.0.0.1:1/tx-service/basesep');
    expect(await subject.submitProposal(signed)).toMatchObject({
      ok: false,
      error: { code: 'RPC_UNAVAILABLE' },
    });
  });

  it('refuses bytes that are not a signed proposal for that hash', async () => {
    const { subject, signed } = await signedFor('http://127.0.0.1:1');
    expect(await subject.submitProposal({ ...signed, signedBytes: 'nope' })).toMatchObject({
      ok: false,
    });
    expect(await subject.submitProposal({ ...signed, hash: '0xabc' })).toMatchObject({ ok: false });
  });
});
