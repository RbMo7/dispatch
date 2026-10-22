import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { hashMessage, type Address, type Hex } from 'viem';
import { privateKeyToAccount, sign } from 'viem/accounts';

import type { SafeApprovalClient } from '../base/safe/safe-approval.js';

/**
 * Offline stand-ins for the two things a Safe read depends on: the node (owners,
 * threshold, nonce, `approvedHashes`, `eth_call`, fees) and the Safe Transaction
 * Service (a real local HTTP server, so the real REST client runs). Used by the
 * #84/#85 tests; not a fixture for any live chain.
 */

export const SAFE: Address = '0x84Ac281B68de095f6227050F56C74d93d294e609';

const key = (n: number): Hex => `0x${n.toString(16).padStart(64, '0')}`;
export const ownerKeys = [key(0xa1), key(0xb2), key(0xc3)] as const;
export const owners = ownerKeys.map((k) => privateKeyToAccount(k));
export const executor = privateKeyToAccount(key(0xe1));
export const outsider = privateKeyToAccount(key(0xf4));

/** The owners in ascending address order, the order the Safe wants signatures in. */
export const ownersAscending = [...owners].sort((a, b) =>
  a.address.toLowerCase() < b.address.toLowerCase() ? -1 : 1,
);

/** A raw-digest signature over `hash` as the service returns it: r || s || v, v 27 or 28. */
export async function ecdsaSignature(privateKey: Hex, hash: Hex): Promise<Hex> {
  const signature = await sign({ hash, privateKey, to: 'hex' });
  const v = Number.parseInt(signature.slice(-2), 16);
  const fixed = v < 27 ? v + 27 : v;
  return `${signature.slice(0, -2)}${fixed.toString(16)}` as Hex;
}

/** The `eth_sign` flavour: signed over the prefixed hash, v bumped by 4 (31 or 32). */
export async function ethSignSignature(privateKey: Hex, hash: Hex): Promise<Hex> {
  const signature = await ecdsaSignature(privateKey, hashMessage({ raw: hash }));
  const v = Number.parseInt(signature.slice(-2), 16);
  return `${signature.slice(0, -2)}${(v + 4).toString(16)}` as Hex;
}

export type FakeNodeState = {
  owners: Address[];
  threshold: number;
  nonce: bigint;
  version: string;
  /** Lowercased owner addresses that called `approveHash` for the proposal under test. */
  approved: Set<string>;
  /** What `getBlockNumber` answers next, in order; the last value repeats. */
  blocks: bigint[];
  /** What `eth_call` does: answer with this data (default `true`), or reject. */
  callResult: Hex | Error;
  /** What `eth_estimateGas` answers, or rejects with. */
  estimate: bigint | Error;
  baseFeePerGas: bigint;
  l1Fee: bigint;
};

const TRUE: Hex = `0x${'0'.repeat(63)}1`;
const FALSE: Hex = `0x${'0'.repeat(64)}`;
export const RETURNS_TRUE = TRUE;
export const RETURNS_FALSE = FALSE;

export function fakeNode(overrides: Partial<FakeNodeState> = {}) {
  const state: FakeNodeState = {
    owners: owners.map((o) => o.address),
    threshold: 2,
    nonce: 12n,
    version: '1.4.1',
    approved: new Set(),
    blocks: [900n],
    callResult: TRUE,
    estimate: 1_000_000n,
    baseFeePerGas: 1_000_000n,
    l1Fee: 1_000n,
    ...overrides,
  };
  const log = {
    /** The `blockNumber` each Safe read was pinned to. */
    pinned: [] as (bigint | undefined)[],
    calls: [] as { account: unknown; to: unknown; data: Hex }[],
    estimates: [] as { account: unknown; to: unknown; data: Hex }[],
    l1FeeArgs: [] as Hex[],
    blockNumberReads: 0,
  };
  const client = {
    getChainId: () => Promise.resolve(84532),
    getBlockNumber: () => {
      log.blockNumberReads++;
      const next = state.blocks.length > 1 ? state.blocks.shift() : state.blocks[0];
      return Promise.resolve(next as bigint);
    },
    getCode: () => Promise.resolve('0x6080' as Hex),
    getStorageAt: () => Promise.resolve('0x0' as Hex),
    getBlock: () => Promise.resolve({ baseFeePerGas: state.baseFeePerGas }),
    call: (request: { account: unknown; to: unknown; data: Hex }) => {
      log.calls.push(request);
      return state.callResult instanceof Error
        ? Promise.reject(state.callResult)
        : Promise.resolve({ data: state.callResult });
    },
    estimateGas: (request: { account: unknown; to: unknown; data: Hex }) => {
      log.estimates.push(request);
      return state.estimate instanceof Error
        ? Promise.reject(state.estimate)
        : Promise.resolve(state.estimate);
    },
    readContract: (a: { functionName: string; args?: unknown[]; blockNumber?: bigint }) => {
      if (a.functionName === 'getL1Fee') {
        log.l1FeeArgs.push(a.args?.[0] as Hex);
        return Promise.resolve(state.l1Fee);
      }
      log.pinned.push(a.blockNumber);
      switch (a.functionName) {
        case 'VERSION':
          return Promise.resolve(state.version);
        case 'getOwners':
          return Promise.resolve([...state.owners]);
        case 'getThreshold':
          return Promise.resolve(BigInt(state.threshold));
        case 'nonce':
          return Promise.resolve(state.nonce);
        case 'approvedHashes':
          return Promise.resolve(state.approved.has(String(a.args?.[0]).toLowerCase()) ? 1n : 0n);
        default:
          return Promise.resolve([[], '0x0000000000000000000000000000000000000001']);
      }
    },
  };
  return { state, log, client: client as unknown as SafeApprovalClient };
}

export type Route = { status: number; body?: unknown };

export type FakeService = {
  url: string;
  /** Path (with query), as requested, to its answer. A missing route answers 404. */
  routes: Map<string, Route>;
  hits: { path: string; authorization: string | undefined }[];
  close(): Promise<void>;
};

export async function startFakeService(): Promise<FakeService> {
  const routes = new Map<string, Route>();
  const hits: FakeService['hits'] = [];
  const server: Server = createServer((req, res) => {
    const path = req.url ?? '';
    const header = req.headers.authorization;
    hits.push({ path, authorization: header });
    const route = routes.get(path) ?? { status: 404, body: { detail: 'Not found.' } };
    res.writeHead(route.status, { 'content-type': 'application/json' });
    res.end(route.body === undefined ? '' : JSON.stringify(route.body));
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  const { port } = server.address() as AddressInfo;
  return {
    url: `http://127.0.0.1:${port}`,
    routes,
    hits,
    close: () => new Promise<void>((resolve) => server.close(() => resolve())),
  };
}

export type ServiceConfirmationFixture = {
  owner: Address;
  signature: Hex;
  signatureType?: string;
};

/** `GET /api/v2/multisig-transactions/{hash}/`, in the shape the service documents. */
export function serviceTransaction(input: {
  safeTxHash: Hex;
  nonce: number;
  isExecuted?: boolean;
  transactionHash?: Hex | null;
  confirmations?: ServiceConfirmationFixture[];
}) {
  return {
    safeTxHash: input.safeTxHash,
    // As the live service sends it: a decimal string.
    nonce: String(input.nonce),
    isExecuted: input.isExecuted ?? false,
    transactionHash: input.transactionHash ?? null,
    confirmations: (input.confirmations ?? []).map((c) => ({
      owner: c.owner,
      signature: c.signature,
      signatureType: c.signatureType ?? 'EOA',
    })),
  };
}

export const byHashPath = (hash: string) => `/api/v2/multisig-transactions/${hash}/`;
export const atNoncePath = (nonce: number) =>
  `/api/v2/safes/${SAFE}/multisig-transactions/?nonce=${nonce}`;
