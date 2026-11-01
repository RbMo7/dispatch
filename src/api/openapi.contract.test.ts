import { readFileSync } from 'node:fs';

import { Connection } from '@solana/web3.js';
import { Ajv2020 } from 'ajv/dist/2020.js';
import formats from 'ajv-formats';
import { beforeAll, describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { buildApp } from '../app.js';
import { BaseChainHandler } from '../chain-handler/base/base-chain-handler.js';
import { parseBaseKnownTokens } from '../chain-handler/base/known-tokens.js';
import { parseSolanaKnownTokens } from '../chain-handler/solana/known-tokens.js';
import { SolanaChainHandler } from '../chain-handler/solana/solana-chain-handler.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { CHAINS } from '../domain/chain.js';
import { err, ok } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import type { AssetDecimals } from './asset-decimals.js';
import { readSender, type SenderConfig, type SenderReads } from './senders.js';

/**
 * docs/openapi.yaml is the API's contract and the source of the reference pages. This drives the
 * real routes, with the real Base and Solana handlers, through every named example in it, and
 * checks each answer against the schema the spec gives for its status. A route that drifts from
 * the docs fails here.
 *
 * One name links a request to its answer: the request example `payBase` (its body, parameters and
 * headers) must produce the response example `payBase`, under the status that example sits in.
 * `unauthorized` is sent with a wrong token.
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
  security?: unknown[];
  parameters?: (Parameter | { $ref: string })[];
  requestBody?: { content: { 'application/json': MediaType } };
  responses: Record<string, { content?: { 'application/json': MediaType } } | { $ref: string }>;
};

const SPEC = parse(
  readFileSync(new URL('../../docs/openapi.yaml', import.meta.url), 'utf8'),
) as Json;
const TOKEN = 'contract-test-token';
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
  authenticated: boolean;
  responseExample: unknown;
};

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
            authenticated: op.security?.length !== 0 && name !== 'unauthorized',
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

const assetDecimals: AssetDecimals = (chain, asset) =>
  ({ base: { ETH: 18, USDC: 6 }, solana: { SOL: 9, USDC: 6 } })[chain][asset as 'USDC'];

const senderConfigs: SenderConfig[] = [
  {
    chain: 'base',
    network: 'base-sepolia',
    address: '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A',
    assets: ['ETH', 'USDC'],
    assetDecimals,
  },
  {
    chain: 'solana',
    network: 'devnet',
    address: 'Vault1111111111111111111111111111111111111',
    assets: ['SOL', 'USDC'],
    assetDecimals,
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
    network: { chainId: 31337 },
    address: '0x5afe000000000000000000000000000000005afe',
    assets: ['ETH'],
    assetDecimals,
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

async function buildContractApp() {
  const store = new InMemoryDispatchStore();
  const chainRegistry = await ChainRegistry.load(['base', 'solana'], {
    base: () =>
      BaseChainHandler.create({
        rpcUrl: 'http://base.invalid',
        chainId: 84532,
        senderAddress: '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A',
        knownTokens: parseBaseKnownTokens('USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6'),
        nonceHistoryStore: new InMemoryNonceHistoryStore(),
        bulkCallMaxBatchSize: 50,
        fetch: fakeBaseRpc,
      }),
    solana: () =>
      Promise.resolve(
        new SolanaChainHandler({
          connection: new Connection('http://solana.invalid'),
          senderAddress: '33zPSL7vhxoi6TU8DAeTJCrmcmEU7zsmhZGh7BrDjCXf',
          knownTokens: parseSolanaKnownTokens(
            'USDC:4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU:6',
          ),
        }),
      ),
  });
  const routes: string[] = [];
  const app = buildApp({
    store,
    chainRegistry,
    authToken: TOKEN,
    defaultRetryPolicy: false,
    assetDecimals,
    listSenders: () => Promise.all(senderConfigs.map((config) => readSender(config, senderReads))),
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
  /** The spec's example ids are real ones from a live engine; each maps to the id the test engine gave the same request. */
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
        ...(scenario.operationId === 'getHealth'
          ? {}
          : { authorization: `Bearer ${scenario.authenticated ? TOKEN : 'wrong-token'}` }),
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
    // Creates first, so the reads and cancels below find the Dispatches the examples name.
    const creates = all.filter((s) => s.operationId === 'createDispatch');
    // A 409 needs a claimed Dispatch, so it runs last, after everything else is claimed.
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
      const exampleId = (s.responseExample as { dispatchId?: string } | undefined)?.dispatchId;
      const realId = (body as { dispatchId?: string }).dispatchId;
      if (exampleId && realId) ids.set(exampleId, realId);
    };

    for (const s of creates) await check(s);
    for (const s of rest) await check(s);
    await store.claimQueued(CHAINS, 100);
    for (const s of tooLate) await check(s);

    expect(failures).toEqual([]);
    expect(tooLate).not.toHaveLength(0);
  });
});
