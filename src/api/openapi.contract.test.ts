import { readFileSync } from 'node:fs';

import { Connection } from '@solana/web3.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { buildApp } from '../app.js';
import { BaseChainHandler } from '../chain-handler/base/base-chain-handler.js';
import { SolanaChainHandler } from '../chain-handler/solana/solana-chain-handler.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { CHAINS } from '../domain/chain.js';
import { err, ok } from '../domain/result.js';
import type { SenderAddress, SenderName } from '../domain/sender.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import { AssetRegistry } from '../asset-registry/asset-registry.js';
import { configuredAssets, registryFromConfig } from '../asset-registry/configured-assets.js';
import type { ReadToken, TokenRead } from '../chain-handler/chain-handler.js';
import { readSender, type SenderConfig, type SenderReads } from './senders.js';
import { setupReader } from './setup-routes.js';

/**
 * docs/openapi.yaml is the API's contract and the source of the reference pages. This drives the
 * real routes, with the real Base and Solana handlers, through every named example in it, and
 * checks each answer against the schema the spec gives for its status. A route that drifts from
 * the docs fails here.
 *
 * One name links a request to its answer: the request example `payBase` (its body, parameters and
 * headers) must produce the response example `payBase`, under the status that example sits in.
 * `unauthorized` is sent with a wrong token, and `notOperator` with the API token to a route that
 * only the operator token may use.
 */

type Json = Record<string, unknown>;
type Example = { summary?: string; value: string | number | boolean | Json | unknown[] };
type MediaType = { schema?: Json; examples?: Record<string, Example> };
type Parameter = {
  name: string;
  in: 'header' | 'path' | 'query';
  required?: boolean;
  examples?: Record<string, Example>;
};
type Operation = {
  operationId: string;
  security?: Record<string, unknown>[];
  parameters?: (Parameter | { $ref: string })[];
  requestBody?: { content: { 'application/json': MediaType } };
  responses: Record<string, { content?: { 'application/json': MediaType } } | { $ref: string }>;
};

const SPEC = parse(
  readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8'),
) as Json;
const TOKEN = 'contract-test-token';
const OPERATOR_TOKEN = 'contract-test-operator-token';
const METHODS = ['get', 'post', 'put', 'patch', 'delete'] as const;
const MULTICALL3 = '0xca11bde05977b3631167028862be2a173976ca11';

function resolve<T>(node: T | { $ref: string }): T {
  if (typeof node !== 'object' || node === null || !('$ref' in node)) return node;
  const target = node.$ref
    .replace(/^#\//, '')
    .split('/')
    .reduce<unknown>((at, key) => (at as Json)[key.replace(/~1/g, '/').replace(/~0/g, '~')], SPEC);
  return target as T;
}

function pointer(...keys: string[]): string {
  return `openapi.json#/${keys.map((key) => key.replace(/~/g, '~0').replace(/\//g, '~1')).join('/')}`;
}

type Scenario = {
  operationId: string;
  name: string;
  method: (typeof METHODS)[number];
  path: string;
  status: string;
  responsePointer: string;
  pathParams: Record<string, string>;
  query: Record<string, string>;
  headers: Record<string, string>;
  body: unknown;
  token: 'api' | 'operator' | 'wrong' | 'none';
  responseExample: unknown;
};

/** Operator-only routes list the operator token as their one security scheme. */
function tokenFor(op: Operation, name: string): Scenario['token'] {
  if (op.security?.length === 0) return 'none';
  if (name === 'unauthorized') return 'wrong';
  const operatorOnly = op.security?.every((scheme) => 'operatorToken' in scheme) ?? false;
  return operatorOnly && name !== 'notOperator' ? 'operator' : 'api';
}

function scenarios(): Scenario[] {
  const out: Scenario[] = [];
  for (const [path, item] of Object.entries(SPEC.paths as Record<string, Json>)) {
    for (const method of METHODS) {
      const op = item[method] as Operation | undefined;
      if (!op) continue;
      const parameters = (op.parameters ?? []).map((p) => resolve<Parameter>(p));
      for (const [status, rawResponse] of Object.entries(op.responses)) {
        const response = resolve(rawResponse);
        const media = response.content?.['application/json'];
        for (const [name, example] of Object.entries(media?.examples ?? {})) {
          const valueOf = (location: Parameter['in']) =>
            Object.fromEntries(
              parameters.flatMap((p) => {
                const value = p.in === location ? p.examples?.[name]?.value : undefined;
                return value === undefined ? [] : [[p.name, `${value as string | number}`]];
              }),
            );
          out.push({
            operationId: op.operationId,
            name,
            method,
            path,
            status,
            responsePointer:
              '$ref' in rawResponse
                ? `openapi.json${rawResponse.$ref}/content/application~1json/schema`
                : pointer(
                    'paths',
                    path,
                    method,
                    'responses',
                    status,
                    'content',
                    'application/json',
                    'schema',
                  ),
            pathParams: valueOf('path'),
            query: valueOf('query'),
            headers: valueOf('header'),
            body: op.requestBody?.content['application/json'].examples?.[name]?.value,
            token: tokenFor(op, name),
            responseExample: example.value,
          });
        }
      }
    }
  }
  return out;
}

/** Answers the few JSON-RPC calls the Base handler makes before it sends anything. */
const fakeBaseRpc: typeof fetch = (_input, init) => {
  const { id, method, params } = JSON.parse(init?.body as string) as {
    id: number;
    method: string;
    params?: unknown[];
  };
  const results: Record<string, unknown> = {
    eth_chainId: '0x14a34',
    eth_getTransactionCount: '0x0',
    eth_getCode: String(params?.[0]).toLowerCase() === MULTICALL3 ? '0x6080604052' : '0x',
  };
  return Promise.resolve(Response.json({ jsonrpc: '2.0', id, result: results[method] }));
};

const assets = registryFromConfig({
  base: 'USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6',
  solana: 'USDC:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:6',
});

const senderConfigs: SenderConfig[] = [
  {
    chain: 'base',
    name: 'payouts',
    isDefault: true,
    network: 'base-sepolia',
    address: '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A',
    assets,
  },
  {
    chain: 'solana',
    name: 'payouts',
    isDefault: true,
    network: 'devnet',
    address: 'Vault1111111111111111111111111111111111111',
    assets,
    approval: {
      mode: 'squads',
      multisigAddress: 'Msig1111111111111111111111111111111111111',
      engineKey: 'Member11111111111111111111111111111111111',
      holders: { sender: 'vault', proposer: 'memberKey' },
      rewatchWindowMs: 1_000,
    },
  },
  {
    chain: 'base',
    name: 'treasury',
    isDefault: false,
    network: { chainId: 31337 },
    address: '0x5afe000000000000000000000000000000005afe',
    assets: registryFromConfig(),
    approval: {
      mode: 'safe',
      multisigAddress: '0x5afe000000000000000000000000000000005afe',
      engineKey: '0xe0ec000000000000000000000000000000000e0e',
      holders: { sender: 'safe', proposer: 'executor' },
      rewatchWindowMs: 1_000,
    },
  },
];

/** One Sender of each mode, with every kind of read the route can report: pins, a failed read, none yet. */
const senderReads: SenderReads = {
  getBalance: (_chain, address, asset) =>
    Promise.resolve(
      asset === 'USDC' && address.startsWith('Vault')
        ? err({ code: 'RPC_UNAVAILABLE', message: 'timed out' })
        : ok({ asset, amount: '9175636623' }),
    ),
  getSignerKey: (chain, address) =>
    Promise.resolve(
      chain === 'solana'
        ? null
        : address.startsWith('0xe0ec')
          ? {
              chain,
              address,
              read: { error: 'the Signer could not be reached' },
              readAt: new Date(),
            }
          : {
              chain,
              address,
              read: { pins: { address, curve: 'secp256k1', chainIds: [84532] } },
              readAt: new Date(),
            },
    ),
  readThreshold: (chain) =>
    Promise.resolve(chain === 'solana' ? ok(2) : err({ code: 'RPC_UNAVAILABLE', message: 'down' })),
  listCommitted: () => Promise.resolve([{ asset: 'SOL', amount: '2039280' }]),
  now: () => new Date('2026-11-01T02:09:20.649Z'),
};

/** The worker's last run found the Signer down; the API's own check passed on this request. */
const WORKER_RAN_AT = new Date('2026-11-01T10:05:00.000Z');
const readSetup = setupReader({
  enabledChains: ['base', 'solana'],
  listRecorded: () =>
    Promise.resolve([
      {
        id: 'signer.reachable',
        area: 'signer',
        title: 'Reachable',
        result: {
          status: 'fail',
          finding: 'no Signer answered at SIGNER_URL (signer:8421)',
          fix: { command: 'docker compose up -d signer' },
        },
        ranAt: WORKER_RAN_AT,
      },
      {
        id: 'sender.fees:solana',
        area: 'sender',
        title: 'Fee balance (Solana)',
        chain: 'solana',
        result: {
          status: 'pass',
          finding: '2.1500 SOL covers the 0.0034 SOL paid in fees in the last 24 hours',
        },
        ranAt: WORKER_RAN_AT,
      },
    ]),
  runApiChecks: () =>
    Promise.resolve([
      {
        id: 'database.migrated',
        area: 'database',
        title: 'Migrated',
        result: { status: 'pass', finding: 'every migration is applied' },
      },
    ]),
  now: () => new Date('2026-11-01T10:07:12.000Z'),
});

/** The chain's answers for the addresses the Assets examples name, as a live engine read them. */
const onChain: Record<string, TokenRead> = {
  '0xB6501Ccdcd1c2aA6C63AF2975f38fE5B58c73027': {
    chain: 'base',
    kind: 'erc20',
    address: '0xB6501Ccdcd1c2aA6C63AF2975f38fE5B58c73027',
    symbol: 'LUSD',
    name: 'Live Dollar',
    decimals: 6,
    supply: '1000000000000',
  },
  '4Z2yz3LXTxu8SgTfaLmwjyabgD6PxaZKK97U6RuwMCdJ': {
    chain: 'solana',
    kind: 'token-2022',
    address: '4Z2yz3LXTxu8SgTfaLmwjyabgD6PxaZKK97U6RuwMCdJ',
    symbol: 'LEUR',
    name: 'Live Euro',
    decimals: 6,
    supply: '1000000000',
  },
  DmzLGKjKuYb9Sa2aQ6D7nv51ixj8akwDzujYA8wC1Ne4: {
    chain: 'solana',
    kind: 'spl',
    address: 'DmzLGKjKuYb9Sa2aQ6D7nv51ixj8akwDzujYA8wC1Ne4',
    symbol: '',
    name: '',
    decimals: 6,
    supply: '1000000000',
  },
  '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU': {
    chain: 'solana',
    kind: 'spl',
    address: '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU',
    symbol: '',
    name: '',
    decimals: 6,
    supply: '1000000000',
  },
};
const readToken: ReadToken = (address) =>
  Promise.resolve(
    onChain[address]
      ? ok(onChain[address])
      : err({ code: 'NOT_A_TOKEN', message: `${address} has no contract code on this chain` }),
  );

async function buildContractApp() {
  const store = new InMemoryDispatchStore();
  await store.seedConfigAssets(
    configuredAssets({ base: 'USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6', solana: '' }),
  );
  const known = new AssetRegistry(() => store.listKnownAssets());
  await known.refresh();
  const baseHandler = (senderAddress: string) =>
    BaseChainHandler.create({
      rpcUrl: 'http://base.invalid',
      chainId: 84532,
      senderAddress,
      assets: known.forChain('base'),
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
      bulkCallMaxBatchSize: 50,
      fetch: fakeBaseRpc,
    });
  const sender = (chain: 'base' | 'solana', name: string, address: string, isDefault: boolean) => ({
    chain,
    name: name as SenderName,
    address: address as SenderAddress,
    isDefault,
  });
  // Two named Senders on Base, `payouts` the default, and one on Solana.
  const chainRegistry = ChainRegistry.fromSenders([
    {
      ...sender('base', 'payouts', '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A', true),
      handler: await baseHandler('0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A'),
    },
    {
      ...sender('base', 'treasury', SAFE_SENDER, false),
      handler: await baseHandler(SAFE_SENDER),
      approverLabels: { [OWNER_A.toLowerCase()]: 'Priya, finance' },
    },
    {
      ...sender('solana', 'payouts', '33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf', true),
      handler: new SolanaChainHandler({
        connection: new Connection('http://solana.invalid'),
        senderAddress: '33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf',
        assets: known.forChain('solana'),
      }),
    },
  ]);
  const routes: string[] = [];
  const app = buildApp({
    store,
    chainRegistry,
    authToken: TOKEN,
    operatorToken: OPERATOR_TOKEN,
    defaultRetryPolicy: false,
    assets: known,
    readToken: { base: readToken, solana: readToken },
    listSenders: () => Promise.all(senderConfigs.map((config) => readSender(config, senderReads))),
    readSetup,
  });
  app.addHook('onRoute', ({ method, url }) => {
    for (const m of [method].flat()) {
      if (m !== 'HEAD' && url.startsWith('/v1/'))
        routes.push(`${m} ${url.replace(/:(\w+)/g, '{$1}')}`);
    }
  });
  await app.ready();
  return { app, store, routes };
}

const SAFE_SENDER = '0x5afe000000000000000000000000000000005afe';
const OWNER_A = '0x1f4a8b2c3d9e0f7a6b5c4d3e2f1a0b9c8d7e6f5a';
const OWNER_B = '0x2e5b9c3d4e0f1a8b7c6d5e4f3a2b1c0d9e8f7a6b';

const ajv = new Ajv2020({ strict: false, allErrors: true });
// ajv-formats is CommonJS, so under NodeNext its plugin is the default export's own default.
formats.default(ajv);
ajv.addSchema({ ...SPEC, $id: 'openapi.json' });

function validate(schemaPointer: string, value: unknown): string[] {
  const check = ajv.getSchema(schemaPointer) ?? ajv.compile({ $ref: schemaPointer });
  return check(value)
    ? []
    : (check.errors ?? []).map((e) => `${e.instancePath} ${e.message ?? ''}`);
}

describe('docs/openapi.yaml against the real routes', () => {
  const all = scenarios();
  let app: Awaited<ReturnType<typeof buildContractApp>>['app'];
  let store: InMemoryDispatchStore;
  let servedV1Routes: string[];
  /** The spec's example Dispatch and Flag Rule ids are real ones from a live engine; each maps to the id the test engine gave the same request. */
  const ids = new Map<string, string>();

  async function send(scenario: Scenario) {
    const path = scenario.path.replace(/\{(\w+)\}/g, (_, key: string) => {
      const value = scenario.pathParams[key] ?? '';
      return scenario.status === '404' ? value : (ids.get(value) ?? value);
    });
    const query = new URLSearchParams(scenario.query).toString();
    return app.inject({
      method: scenario.method.toUpperCase() as 'GET',
      url: query ? `${path}?${query}` : path,
      headers: {
        ...scenario.headers,
        ...(scenario.token === 'none'
          ? {}
          : {
              authorization: `Bearer ${{ api: TOKEN, operator: OPERATOR_TOKEN, wrong: 'wrong-token' }[scenario.token]}`,
            }),
      },
      ...(scenario.status === '413'
        ? { payload: oversizedBody() }
        : scenario.body === undefined
          ? {}
          : { payload: scenario.body as Json }),
    });
  }

  /** A 413 example has no request body in the spec: a body over 1 MiB would bury the page. */
  function oversizedBody(): Json {
    const item = {
      type: 'payment',
      recipient: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
      asset: 'ETH',
      amount: '1',
    };
    return { chain: 'base', items: Array.from({ length: 12_000 }, () => item) };
  }

  beforeAll(async () => {
    ({ app, store, routes: servedV1Routes } = await buildContractApp());
    expect(servedV1Routes).not.toHaveLength(0);
  });

  it('documents every /v1 route the API serves, and serves every route it documents', () => {
    const documented = Object.entries(SPEC.paths as Record<string, Json>).flatMap(([path, item]) =>
      METHODS.filter((method) => item[method]).map((method) => `${method.toUpperCase()} ${path}`),
    );
    for (const route of documented) {
      const [method, path] = route.split(' ') as ['GET', string];
      expect(app.hasRoute({ method, url: path.replace(/\{(\w+)\}/g, ':$1') }), route).toBe(true);
    }
    expect(documented).toEqual(expect.arrayContaining(servedV1Routes));
  });

  it('gives every response with a body at least one example, and every request example an answer', () => {
    const named = new Set(all.map((s) => `${s.operationId}:${s.name}`));
    for (const [path, item] of Object.entries(SPEC.paths as Record<string, Json>)) {
      for (const method of METHODS) {
        const op = item[method] as Operation | undefined;
        if (!op) continue;
        for (const [status, raw] of Object.entries(op.responses)) {
          const examples = resolve(raw).content?.['application/json'].examples ?? {};
          expect(Object.keys(examples), `${method} ${path} ${status}`).not.toHaveLength(0);
        }
        for (const name of Object.keys(
          op.requestBody?.content['application/json'].examples ?? {},
        )) {
          expect(named, `${op.operationId} request example ${name}`).toContain(
            `${op.operationId}:${name}`,
          );
        }
      }
    }
  });

  it('matches each response example to its own schema', () => {
    for (const s of all) {
      expect(validate(s.responsePointer, s.responseExample), `${s.operationId} ${s.name}`).toEqual(
        [],
      );
    }
  });

  it('accepts each request example that succeeds under the request schema', () => {
    for (const s of all.filter((s) => s.body !== undefined && s.status.startsWith('2'))) {
      const schema = pointer(
        'paths',
        s.path,
        s.method,
        'requestBody',
        'content',
        'application/json',
        'schema',
      );
      expect(validate(schema, s.body), `${s.operationId} ${s.name}`).toEqual([]);
    }
  });

  it('answers every example with its documented status and a body that matches the schema', async () => {
    // Creates first, so the reads and cancels below find the Dispatches the examples name. Flag
    // Rules before Dispatches, so the held example has a rule to match.
    const creates = ['createFlagRule', 'addAsset', 'createDispatch'].flatMap((id) =>
      all.filter((s) => s.operationId === id),
    );
    // A 409 needs a claimed Dispatch or a deleted rule, so it runs last, after everything else is claimed.
    const tooLate = all.filter((s) => s.status === '409');
    const rest = all.filter((s) => !creates.includes(s) && !tooLate.includes(s));

    const failures: string[] = [];
    const check = async (s: Scenario) => {
      const response = await send(s);
      const body: unknown = response.json();
      const problems = validate(s.responsePointer, body);
      if (String(response.statusCode) !== s.status || problems.length > 0) {
        failures.push(
          `${s.operationId} ${s.name}: ${response.statusCode} (documented ${s.status}) ${problems.join('; ')} ${response.body}`,
        );
      }
      type Ids =
        { dispatchId?: string; ruleId?: string; id?: string; assets?: AssetIds[] } | undefined;
      type AssetIds = { id: string; chain: string; address: string };
      const example = s.responseExample as Ids;
      const real = body as Ids;
      for (const key of ['dispatchId', 'ruleId', 'id'] as const) {
        const exampleId = example?.[key];
        const realId = real?.[key];
        if (exampleId && realId) ids.set(exampleId, realId);
      }
      // A listed asset maps by what it is, since the test engine gave it its own id.
      for (const listed of example?.assets ?? []) {
        const same = real?.assets?.find(
          (a) => a.chain === listed.chain && a.address === listed.address,
        );
        if (same) ids.set(listed.id, same.id);
      }
    };

    for (const s of creates) await check(s);
    for (const s of rest) await check(s);
    await store.claimQueued(CHAINS, 100);
    for (const s of tooLate) await check(s);

    expect(failures).toEqual([]);
    expect(tooLate).not.toHaveLength(0);
  });

  it("answers a Multisig Sender's item with its Approvers, their labels and the approvals remaining", async () => {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'approvers-contract',
      items: [{ call: { to: OWNER_B, data: '0x', value: '1' }, payment: null }],
      retryPolicy: false,
      senderAddress: SAFE_SENDER as SenderAddress,
    });
    await store.claimQueued(CHAINS, 100);
    const [call] = await store.noteUnproposed([
      { dispatchId: dispatch.id, callIndex: 0, chain: 'base' },
    ]);
    const chainRef = {
      kind: 'safe',
      safe: SAFE_SENDER,
      safeTxHash: `0x${'ab'.repeat(32)}`,
      nonce: 3,
    } as const;
    const proposal = await store.createProposal({
      dispatchId: dispatch.id,
      chain: 'base',
      senderAddress: SAFE_SENDER,
      chainRef,
      payload: 'payload',
      proposalRef: chainRef.safeTxHash,
      sequence: 3,
      threshold: 2,
      deadlineAt: new Date('2026-11-04T12:00:00.000Z'),
      executeAfter: null,
      proposeSignedBytes: null,
      proposeHash: null,
      expected: { recipients: 1, totals: [{ asset: 'ETH', amount: '1' }] },
      committed: { sender: [], proposer: [] },
      transactionIds: [call!.id],
    });
    await store.updateProposal(proposal.id, {
      phase: 'open',
      approvals: 1,
      approvers: [
        { address: OWNER_A, decision: 'approved' },
        { address: OWNER_B, decision: 'pending' },
      ],
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatch.id}`,
      headers: { authorization: `Bearer ${TOKEN}` },
    });
    const body = response.json<{ items: { approval: unknown }[] }>();

    expect(
      validate(
        pointer(
          'paths',
          '/v1/dispatch/{id}',
          'get',
          'responses',
          '200',
          'content',
          'application/json',
          'schema',
        ),
        body,
      ),
    ).toEqual([]);
    expect(body.items[0]?.approval).toMatchObject({
      approvals: 1,
      threshold: 2,
      remaining: 1,
      approvers: [
        { address: OWNER_A, label: 'Priya, finance', decision: 'approved' },
        { address: OWNER_B, decision: 'pending' },
      ],
    });
    expect(body.items[0]?.approval).not.toHaveProperty(['approvers', 1, 'label']);
  });
});
