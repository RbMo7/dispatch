import { randomUUID } from 'node:crypto';

import { beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import type { BulkCallPlan, BulkCallRequest } from '../chain-handler/chain-handler.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import { FakeApproval } from '../chain-handler/test-support/fake-approval.js';
import type { DispatchItem } from '../domain/call.js';
import { CHAINS } from '../domain/chain.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { MAX_SCANNED_ROWS } from './dispatch-list.js';

const AUTH_HEADERS = { authorization: 'Bearer test-token' };

type PostResponseBody = { dispatchId: string; status: string };
type ErrorResponseBody = { error?: string; code?: string; message?: string };
type GetResponseBody = {
  dispatchId: string;
  mode: string;
  status: string;
  items: { status: string; transactionHash: string | null; error: unknown }[];
};
type RelayGetResponseBody = {
  dispatchId: string;
  mode: string;
  status: string;
  transactionHash: string | null;
  error: unknown;
};

async function buildTestApp(options?: {
  defaultRetryPolicy?: boolean;
  handler?: StubChainHandler;
}) {
  const store = new InMemoryDispatchStore();
  const chainRegistry = await ChainRegistry.load(['base'], {
    base: () => Promise.resolve(options?.handler ?? new StubChainHandler()),
  });
  const app = buildApp({
    store,
    chainRegistry,
    authToken: 'test-token',
    defaultRetryPolicy: options?.defaultRetryPolicy ?? false,
    assetDecimals: (chain, asset) =>
      ({ base: { USDC: 6, ETH: 18 }, solana: { SOL: 9 } })[chain][asset as never],
    listSenders: () => Promise.resolve([]),
  });
  return { app, store };
}

describe('POST /v1/dispatch', () => {
  it('rejects a request without a valid bearer token', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { 'idempotency-key': 'key-1' },
      payload: { chain: 'base', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a request missing the Idempotency-Key header', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: AUTH_HEADERS,
      payload: { chain: 'base', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>()).toEqual({
      error: 'Idempotency-Key header is required',
    });
  });

  it('rejects a chain that is not enabled with a structured CHAIN_NOT_ENABLED error', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: {
        chain: 'solana',
        items: [{ type: 'call', programId: 'p', accounts: [], data: 'ZA==' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>()).toEqual({
      code: 'CHAIN_NOT_ENABLED',
      message: 'chain not enabled: solana',
    });
  });

  it("refuses a call item the Chain Handler's validateCall rejects with 400, never queuing it (mainnet review)", async () => {
    const handler = new StubChainHandler();
    handler.validateCall = () =>
      Promise.resolve(err({ code: 'CHAIN_REJECTED', message: 'malformed call' }));
    const { app, store } = await buildTestApp({ handler });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'bad-call' },
      payload: { chain: 'base', items: [{ type: 'call', to: 42 }] },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>()).toMatchObject({ code: 'CHAIN_REJECTED' });
    expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
  });

  it('accepts a call item as-is and returns 202 with the queued Dispatch', async () => {
    const { app, store } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: { chain: 'base', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
    });

    expect(response.statusCode).toBe(202);
    const body = response.json<PostResponseBody>();
    expect(body.status).toBe('queued');

    const dispatch = await store.getDispatch(body.dispatchId);
    expect(dispatch?.items).toEqual([
      { call: { to: '0xabc', data: '0x', value: '0' }, payment: null },
    ]);
  });

  it('translates a payment item into a Call via the Chain Handler', async () => {
    const { app, store } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: {
        chain: 'base',
        items: [{ type: 'payment', recipient: '0xrecipient', asset: 'USDC', amount: '10' }],
      },
    });

    expect(response.statusCode).toBe(202);
    const dispatch = await store.getDispatch(response.json<PostResponseBody>().dispatchId);
    expect(dispatch?.items).toEqual([
      {
        call: { to: '0xrecipient', data: '0x', value: '10' },
        payment: { recipient: '0xrecipient', asset: 'USDC', amount: '10' },
      },
    ]);
  });

  it('rejects a payment amount that is not a non-negative integer string', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: {
        chain: 'base',
        items: [{ type: 'payment', recipient: '0xrecipient', asset: 'USDC', amount: '10.5' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>().error).toMatch(/non-negative integer string/);
  });

  it('rejects a payment whose translation fails, with the structured DispatchError', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: {
        chain: 'base',
        items: [{ type: 'payment', recipient: 'not-an-address', asset: 'USDC', amount: '10' }],
      },
    });

    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>().code).toBe('INVALID_RECIPIENT');
  });

  it('rejects an item with an unknown type', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: { chain: 'base', items: [{ type: 'mystery' }] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('resubmitting the same Idempotency-Key returns the original Dispatch, not a new one', async () => {
    const { app } = await buildTestApp();
    const payload = {
      chain: 'base',
      items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }],
    };

    const first = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload,
    });
    const second = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload,
    });

    expect(second.json<PostResponseBody>().dispatchId).toBe(
      first.json<PostResponseBody>().dispatchId,
    );
  });

  it('defaults retryPolicy to the operator global default when omitted', async () => {
    const { app, store } = await buildTestApp({ defaultRetryPolicy: true });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: { chain: 'base', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
    });

    const dispatch = await store.getDispatch(response.json<PostResponseBody>().dispatchId);
    expect(dispatch?.retryPolicy).toBe(true);
  });

  it('honors an explicit retryPolicy over the operator global default', async () => {
    const { app, store } = await buildTestApp({ defaultRetryPolicy: true });

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: {
        chain: 'base',
        retryPolicy: false,
        items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }],
      },
    });

    const dispatch = await store.getDispatch(response.json<PostResponseBody>().dispatchId);
    expect(dispatch?.retryPolicy).toBe(false);
  });

  describe('mode: relay', () => {
    it('accepts a signed transaction and returns 202 with a queued RelayDispatch', async () => {
      const { app, store } = await buildTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-key-1' },
        payload: { chain: 'base', mode: 'relay', signedTransaction: 'externally-signed-bytes' },
      });

      expect(response.statusCode).toBe(202);
      const body = response.json<PostResponseBody>();
      expect(body.status).toBe('queued');

      const relayDispatch = await store.getRelayDispatch(body.dispatchId);
      expect(relayDispatch).toMatchObject({
        chain: 'base',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'externally-signed-bytes',
        status: 'queued',
        transactionId: null,
      });
    });

    it('rejects a relay dispatch missing signedTransaction', async () => {
      const { app } = await buildTestApp();

      const response = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-key-1' },
        payload: { chain: 'base', mode: 'relay' },
      });

      expect(response.statusCode).toBe(400);
      expect(response.json<ErrorResponseBody>().error).toMatch(/signedTransaction/);
    });

    it('rejects a relay dispatch that also sends items or retryPolicy, rather than silently ignoring them', async () => {
      const { app } = await buildTestApp();

      const withItems = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-key-1' },
        payload: {
          chain: 'base',
          mode: 'relay',
          signedTransaction: 'externally-signed-bytes',
          items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }],
        },
      });
      expect(withItems.statusCode).toBe(400);
      expect(withItems.json<ErrorResponseBody>().error).toMatch(/no items, no retryPolicy/);

      const withRetryPolicy = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-key-2' },
        payload: {
          chain: 'base',
          mode: 'relay',
          signedTransaction: 'externally-signed-bytes',
          retryPolicy: true,
        },
      });
      expect(withRetryPolicy.statusCode).toBe(400);
      expect(withRetryPolicy.json<ErrorResponseBody>().error).toMatch(/no items, no retryPolicy/);
    });

    it('rejects a malformed signed transaction with the structured DispatchError, and never persists it', async () => {
      const { app } = await buildTestApp();

      const rejected = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-key-1' },
        // StubChainHandler.validateSignedTransaction rejects this exact sentinel.
        payload: { chain: 'base', mode: 'relay', signedTransaction: 'force-failure' },
      });

      expect(rejected.statusCode).toBe(400);
      expect(rejected.json<ErrorResponseBody>().code).toBe('CHAIN_REJECTED');

      // If the rejected attempt had persisted a RelayDispatch under this same
      // idempotency key, this resubmission (now with a valid signed
      // transaction) would idempotently return that same, still-broken row
      // instead of actually succeeding.
      const accepted = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-key-1' },
        payload: { chain: 'base', mode: 'relay', signedTransaction: 'externally-signed-bytes' },
      });
      expect(accepted.statusCode).toBe(202);
      expect(accepted.json<PostResponseBody>().status).toBe('queued');
    });

    it('resubmitting the same Idempotency-Key returns the original RelayDispatch, not a new one', async () => {
      const { app } = await buildTestApp();
      const payload = {
        chain: 'base',
        mode: 'relay',
        signedTransaction: 'externally-signed-bytes',
      };

      const first = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-key-1' },
        payload,
      });
      const second = await app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-key-1' },
        payload,
      });

      expect(second.json<PostResponseBody>().dispatchId).toBe(
        first.json<PostResponseBody>().dispatchId,
      );
    });
  });
});

/** A stub for a chain with Bulk Call (#11): funds the second item from the aggregator, rejects the aggregator "0xbad". */
class BulkCapableStub extends StubChainHandler {
  validateBulkCall(
    request: BulkCallRequest,
    items: DispatchItem[],
  ): Promise<Result<BulkCallPlan, DispatchError>> {
    if (request.aggregator === '0xbad') {
      return Promise.resolve(err({ code: 'CHAIN_REJECTED', message: 'bad aggregator' }));
    }
    return Promise.resolve(
      ok({
        bulkCall: {
          aggregator: request.aggregator,
          maxBatchSize: request.maxBatchSize ?? 50,
          allowFailure: request.allowFailure ?? false,
        },
        fundedBy: items.map((_, i) => (i === 1 ? request.aggregator : null)),
      }),
    );
  }
}

describe('POST /v1/dispatch with bulkCall (#11)', () => {
  const items = [
    { type: 'call', to: '0xa', data: '0x', value: '1' },
    { type: 'call', to: '0xb', data: '0x', value: '0' },
  ];

  async function post(app: Awaited<ReturnType<typeof buildTestApp>>['app'], payload: object) {
    return app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': `bulk-${Math.random()}` },
      payload,
    });
  }

  it("persists the resolved bulkCall and each item's fundedBy from the Chain Handler's plan", async () => {
    const { app, store } = await buildTestApp({ handler: new BulkCapableStub() });

    const response = await post(app, { chain: 'base', items, bulkCall: { aggregator: '0xagg' } });

    expect(response.statusCode).toBe(202);
    const dispatch = await store.getDispatch(response.json<PostResponseBody>().dispatchId);
    expect(dispatch?.bulkCall).toEqual({
      aggregator: '0xagg',
      maxBatchSize: 50,
      allowFailure: false,
    });
    expect(dispatch?.items.map((i) => i.fundedBy ?? null)).toEqual([null, '0xagg']);
  });

  it('passes an explicit allowFailure: true through to the Chain Handler', async () => {
    const { app, store } = await buildTestApp({ handler: new BulkCapableStub() });

    const response = await post(app, {
      chain: 'base',
      items,
      bulkCall: { aggregator: '0xagg', allowFailure: true },
    });

    const dispatch = await store.getDispatch(response.json<PostResponseBody>().dispatchId);
    expect(dispatch?.bulkCall?.allowFailure).toBe(true);
  });

  it('rejects bulkCall with 400 on a chain whose handler has no Bulk Call', async () => {
    const { app } = await buildTestApp();
    const response = await post(app, { chain: 'base', items, bulkCall: { aggregator: '0xagg' } });
    expect(response.statusCode).toBe(400);
  });

  it("answers the Chain Handler's own rejection with 400 and persists nothing", async () => {
    const { app, store } = await buildTestApp({ handler: new BulkCapableStub() });
    const response = await post(app, { chain: 'base', items, bulkCall: { aggregator: '0xbad' } });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>().message).toBe('bad aggregator');
    expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
  });

  it('rejects bulkCall on a relay dispatch with 400', async () => {
    const { app } = await buildTestApp({ handler: new BulkCapableStub() });
    const response = await post(app, {
      chain: 'base',
      mode: 'relay',
      signedTransaction: 'stub-signed-transaction',
      bulkCall: { aggregator: '0xagg' },
    });
    expect(response.statusCode).toBe(400);
  });

  it('rejects a malformed bulkCall shape with 400', async () => {
    const { app } = await buildTestApp({ handler: new BulkCapableStub() });
    for (const bulkCall of [
      {},
      { aggregator: '' },
      { aggregator: '0xagg', maxBatchSize: 0 },
      { aggregator: '0xagg', maxBatchSize: 'many' },
    ]) {
      const response = await post(app, { chain: 'base', items, bulkCall });
      expect(response.statusCode).toBe(400);
    }
  });
});

/** A handler in multisig mode (ADR-0054): `approval` is present, and its planner refuses what the multisig cannot hold. */
class MultisigStub extends StubChainHandler {
  readonly approval = new FakeApproval<'base'>();
}

describe('POST /v1/dispatch for a Multisig Sender (#94)', () => {
  const transfer = { type: 'payment', recipient: '0xabc', asset: 'ETH', amount: '1' };
  const rawCall = { type: 'call', to: '0xa', data: '0x', value: '1' };

  async function setup() {
    const handler = new MultisigStub();
    handler.approval.planBundlesImpl = (calls) =>
      'data' in calls[0]! && calls[0].data !== '0x'
        ? err({ code: 'CHAIN_REJECTED', message: 'not a transfer the Safe can hold' })
        : ok([calls.map((_, i) => i)]);
    const { app, store } = await buildTestApp({ handler });
    const post = (payload: object, key = 'ms-1') =>
      app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH_HEADERS, 'idempotency-key': key },
        payload,
      });
    return { app, store, post };
  }

  it('still accepts transfers the multisig can hold', async () => {
    const { post } = await setup();
    const response = await post({ chain: 'base', items: [transfer, rawCall] });
    expect(response.statusCode).toBe(202);
  });

  it('rejects a call the multisig cannot hold with 400 naming the item, storing nothing and keeping the key free', async () => {
    const { store, post } = await setup();
    const bad = { type: 'call', to: '0xa', data: '0xdeadbeef', value: '0' };

    const response = await post({ chain: 'base', items: [transfer, bad] });

    expect(response.statusCode).toBe(400);
    const body = response.json<ErrorResponseBody>();
    expect(body.code).toBe('CHAIN_REJECTED');
    expect(body.message).toContain('items[1]');

    // Nothing was stored and the key is free: the same key now creates a Dispatch of its own.
    const retry = await post({ chain: 'base', items: [transfer] });
    expect(retry.statusCode).toBe(202);
    const stored = await store.getDispatch(retry.json<PostResponseBody>().dispatchId);
    expect(stored?.items).toHaveLength(1);
  });

  it('rejects bulkCall with 400', async () => {
    const { post } = await setup();
    const response = await post({
      chain: 'base',
      items: [transfer],
      bulkCall: { aggregator: '0xagg' },
    });
    expect(response.statusCode).toBe(400);
    expect(response.json<ErrorResponseBody>().message).toContain('multisig');
  });
});

describe('GET /v1/dispatch/:id', () => {
  let app: Awaited<ReturnType<typeof buildTestApp>>['app'];
  let store: Awaited<ReturnType<typeof buildTestApp>>['store'];

  beforeEach(async () => {
    ({ app, store } = await buildTestApp());
  });

  it('rejects a request without a valid bearer token', async () => {
    const response = await app.inject({ method: 'GET', url: '/v1/dispatch/some-id' });
    expect(response.statusCode).toBe(401);
  });

  it('returns 404 for an unknown Dispatch', async () => {
    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${randomUUID()}`,
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });

  it('returns 404 for an id that is not a UUID', async () => {
    const response = await app.inject({
      method: 'GET',
      url: '/v1/dispatch/missing',
      headers: AUTH_HEADERS,
    });
    expect(response.statusCode).toBe(404);
  });

  it('reports a freshly-created Dispatch as queued, with each item queued and no hash yet', async () => {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatch.id}`,
      headers: AUTH_HEADERS,
    });

    expect(response.json<GetResponseBody>()).toEqual({
      dispatchId: dispatch.id,
      mode: 'managed',
      status: 'queued',
      items: [{ type: 'call', to: '0xabc', status: 'queued', transactionHash: null, error: null }],
    });
  });

  it('reports what the caller asked for on each item, payment or call, on either chain', async () => {
    const base = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'base',
      items: [
        {
          call: { to: '0xusdc', data: '0xa9059cbb', value: '0' },
          payment: { recipient: '0xbob', asset: 'USDC', amount: '2500000' },
        },
        { call: { to: '0xcontract', data: '0x1234', value: '7' }, payment: null },
      ],
      retryPolicy: false,
    });
    const solana = await store.createDispatch({
      chain: 'solana',
      idempotencyKey: 'solana',
      items: [
        {
          call: { programId: '11111111111111111111111111111111', accounts: [], data: 'AgAAAA==' },
          payment: { recipient: 'Bob1111', asset: 'SOL', amount: '1000' },
        },
        { call: { programId: 'Memo1111', accounts: [], data: 'aGk=' }, payment: null },
      ],
      retryPolicy: false,
    });

    const itemsOf = async (id: string) =>
      (
        await app.inject({ method: 'GET', url: `/v1/dispatch/${id}`, headers: AUTH_HEADERS })
      ).json<GetResponseBody>().items;

    expect(await itemsOf(base.id)).toEqual([
      {
        type: 'payment',
        recipient: '0xbob',
        asset: 'USDC',
        decimals: 6,
        amount: '2500000',
        status: 'queued',
        transactionHash: null,
        error: null,
      },
      { type: 'call', to: '0xcontract', status: 'queued', transactionHash: null, error: null },
    ]);
    expect(await itemsOf(solana.id)).toEqual([
      {
        type: 'payment',
        recipient: 'Bob1111',
        asset: 'SOL',
        decimals: 9,
        amount: '1000',
        status: 'queued',
        transactionHash: null,
        error: null,
      },
      { type: 'call', programId: 'Memo1111', status: 'queued', transactionHash: null, error: null },
    ]);
  });

  it('leaves decimals out of an item whose asset is no longer configured', async () => {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'retired',
      items: [
        {
          call: { to: '0xold', data: '0xa9059cbb', value: '0' },
          payment: { recipient: '0xbob', asset: 'OLD', amount: '5' },
        },
      ],
      retryPolicy: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatch.id}`,
      headers: AUTH_HEADERS,
    });

    expect(response.json<GetResponseBody>().items[0]).not.toHaveProperty('decimals');
  });

  it('reports confirmed once every item is confirmed', async () => {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(CHAINS, 10);
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'bytes',
      hash: 'hash-1',
    });
    await store.markConfirmed(transaction.id);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatch.id}`,
      headers: AUTH_HEADERS,
    });

    expect(response.json<GetResponseBody>()).toEqual({
      dispatchId: dispatch.id,
      mode: 'managed',
      status: 'confirmed',
      items: [
        { type: 'call', to: '0xabc', status: 'confirmed', transactionHash: 'hash-1', error: null },
      ],
    });
  });

  describe('a fee-bumped item (#9)', () => {
    async function bumpedDispatch() {
      const dispatch = await store.createDispatch({
        chain: 'base',
        idempotencyKey: 'key-1',
        items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
        retryPolicy: true,
      });
      await store.claimQueued(CHAINS, 10);
      const original = await store.createTransaction({
        dispatchId: dispatch.id,
        callIndex: 0,
        chain: 'base',
        signedBytes: 'bytes',
        hash: 'hash-original',
      });
      const replacement = await store.createReplacementTransaction(original.id, {
        signedBytes: 'bumped',
        hash: 'hash-bumped',
      });
      return { dispatch, original, replacement };
    }

    async function get(dispatchId: string) {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${dispatchId}`,
        headers: AUTH_HEADERS,
      });
      return response.json<GetResponseBody>();
    }

    it('reports the latest version while it is still pending', async () => {
      const { dispatch } = await bumpedDispatch();

      expect(await get(dispatch.id)).toMatchObject({
        status: 'broadcasting',
        items: [{ status: 'broadcasting', transactionHash: 'hash-bumped', error: null }],
      });
    });

    it('reports the version that landed, even when it is the original', async () => {
      const { dispatch, original, replacement } = await bumpedDispatch();
      await store.markConfirmed(original.id);
      await store.markDropped(replacement.id);

      expect(await get(dispatch.id)).toMatchObject({
        status: 'confirmed',
        items: [{ status: 'confirmed', transactionHash: 'hash-original', error: null }],
      });
    });
  });

  it('reports partial when some items confirm and others fail or are abandoned', async () => {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [
        { call: { to: '0xa', data: '0x', value: '0' }, payment: null },
        { call: { to: '0xb', data: '0x', value: '0' }, payment: null },
      ],
      retryPolicy: false,
    });
    await store.claimQueued(CHAINS, 10);
    const confirmed = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'bytes',
      hash: 'hash-1',
    });
    await store.markConfirmed(confirmed.id);
    await store.recordCallFailure({
      dispatchId: dispatch.id,
      callIndex: 1,
      chain: 'base',
      error: { code: 'INSUFFICIENT_FUNDS', message: 'short' },
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatch.id}`,
      headers: AUTH_HEADERS,
    });
    const body = response.json<GetResponseBody>();

    expect(body.status).toBe('partial');
    expect(body.items).toEqual([
      { type: 'call', to: '0xa', status: 'confirmed', transactionHash: 'hash-1', error: null },
      {
        type: 'call',
        to: '0xb',
        status: 'failed',
        transactionHash: null,
        error: { code: 'INSUFFICIENT_FUNDS', message: 'short' },
      },
    ]);
  });

  it('reports broadcasting while a transaction is still PENDING', async () => {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(CHAINS, 10);
    await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'bytes',
      hash: 'hash-1',
    });

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatch.id}`,
      headers: AUTH_HEADERS,
    });

    const body = response.json<GetResponseBody>();
    expect(body.status).toBe('broadcasting');
    expect(body.items[0]?.status).toBe('broadcasting');
  });

  it('surfaces an ABANDONED transaction distinctly at the item level', async () => {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(CHAINS, 10);
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'bytes',
      hash: 'hash-1',
    });
    await store.markAbandoned(transaction.id);

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatch.id}`,
      headers: AUTH_HEADERS,
    });

    const body = response.json<GetResponseBody>();
    expect(body.items[0]?.status).toBe('abandoned');
    expect(body.status).toBe('failed');
  });

  describe('a Relay Dispatch', () => {
    it('reports a freshly-created RelayDispatch as queued, with mode relay and no hash yet', async () => {
      const relayDispatch = await store.createRelayDispatch({
        chain: 'base',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'externally-signed-bytes',
      });

      const response = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${relayDispatch.id}`,
        headers: AUTH_HEADERS,
      });

      expect(response.json<RelayGetResponseBody>()).toEqual({
        dispatchId: relayDispatch.id,
        mode: 'relay',
        status: 'queued',
        transactionHash: null,
        error: null,
      });
    });

    it("reports broadcasting while the RelayDispatch's Transaction is still PENDING", async () => {
      const relayDispatch = await store.createRelayDispatch({
        chain: 'base',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'externally-signed-bytes',
      });
      await store.claimQueuedRelayDispatches(CHAINS, 10);
      const transaction = await store.createTransaction({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: 'base',
        signedBytes: 'externally-signed-bytes',
        hash: 'relay-hash-1',
      });
      await store.setRelayDispatchTransaction(relayDispatch.id, transaction.id);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${relayDispatch.id}`,
        headers: AUTH_HEADERS,
      });

      expect(response.json<RelayGetResponseBody>()).toEqual({
        dispatchId: relayDispatch.id,
        mode: 'relay',
        status: 'broadcasting',
        transactionHash: 'relay-hash-1',
        error: null,
      });
    });

    it("reports confirmed once the RelayDispatch's Transaction confirms — one transaction, not a fake single-item array", async () => {
      const relayDispatch = await store.createRelayDispatch({
        chain: 'base',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'externally-signed-bytes',
      });
      await store.claimQueuedRelayDispatches(CHAINS, 10);
      const transaction = await store.createTransaction({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: 'base',
        signedBytes: 'externally-signed-bytes',
        hash: 'relay-hash-1',
      });
      await store.setRelayDispatchTransaction(relayDispatch.id, transaction.id);
      await store.markConfirmed(transaction.id);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${relayDispatch.id}`,
        headers: AUTH_HEADERS,
      });

      const body = response.json<RelayGetResponseBody>();
      expect(body.status).toBe('confirmed');
      expect(body.transactionHash).toBe('relay-hash-1');
      expect('items' in body).toBe(false);
    });

    it('reports failed with the structured error once broadcast never produced a Transaction hash', async () => {
      const relayDispatch = await store.createRelayDispatch({
        chain: 'base',
        idempotencyKey: 'relay-key-1',
        signedTransaction: 'externally-signed-bytes',
      });
      await store.claimQueuedRelayDispatches(CHAINS, 10);
      const transaction = await store.recordCallFailure({
        dispatchId: relayDispatch.id,
        callIndex: 0,
        chain: 'base',
        error: { code: 'CHAIN_REJECTED', message: 'send failed' },
      });
      await store.setRelayDispatchTransaction(relayDispatch.id, transaction.id);

      const response = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${relayDispatch.id}`,
        headers: AUTH_HEADERS,
      });

      expect(response.json<RelayGetResponseBody>()).toEqual({
        dispatchId: relayDispatch.id,
        mode: 'relay',
        status: 'failed',
        transactionHash: null,
        error: { code: 'CHAIN_REJECTED', message: 'send failed' },
      });
    });
  });
});

describe('GET /v1/dispatch/:id for a multisig Dispatch (ADR-0054)', () => {
  type ApprovalGetBody = {
    status: string;
    items: {
      status: string;
      transactionHash: string | null;
      error: { code: string } | null;
      approval?: Record<string, unknown>;
    }[];
  };

  const squadsRef = {
    kind: 'squads',
    multisig: 'ms',
    proposal: 'prop',
    transactionIndex: 4,
  } as const;
  const expected = { recipients: 2, totals: [{ asset: 'USDC', amount: '30' }] };

  async function setup(itemCount = 2) {
    const { app, store } = await buildTestApp();
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: Array.from({ length: itemCount }, () => ({
        call: { to: '0xabc', data: '0x', value: '0' },
        payment: null,
      })),
      retryPolicy: false,
    });
    await store.claimQueued(CHAINS, 10);
    const calls = await store.noteUnproposed(
      Array.from({ length: itemCount }, (_, callIndex) => ({
        dispatchId: dispatch.id,
        callIndex,
        chain: 'base' as const,
      })),
    );
    const get = async () => {
      const response = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${dispatch.id}`,
        headers: AUTH_HEADERS,
      });
      return response.json<ApprovalGetBody>();
    };
    const propose = (transactionIds: string[], proposalRef: string) =>
      store.createProposal({
        dispatchId: dispatch.id,
        chain: 'base',
        senderAddress: '0xsafe',
        chainRef: squadsRef,
        payload: 'payload',
        proposalRef,
        sequence: 4,
        threshold: 3,
        deadlineAt: new Date('2026-10-24T12:00:00.000Z'),
        executeAfter: null,
        proposeSignedBytes: null,
        proposeHash: null,
        expected,
        committed: { sender: [], proposer: [] },
        transactionIds,
      });
    return { store, dispatch, calls, get, propose };
  }

  it('reports Calls not yet in a Proposal as queued, with no approval block, and the Dispatch as broadcasting', async () => {
    const { get } = await setup();

    expect(await get()).toEqual({
      status: 'broadcasting',
      dispatchId: expect.any(String) as string,
      mode: 'managed',
      items: [
        { type: 'call', to: '0xabc', status: 'queued', transactionHash: null, error: null },
        { type: 'call', to: '0xabc', status: 'queued', transactionHash: null, error: null },
      ],
    });
  });

  it('reports Calls inside a Proposal as awaiting_approval, with the approval block and no hash', async () => {
    const { get, calls, store, propose } = await setup();
    const proposal = await propose(
      calls.map((c) => c.id),
      'prop',
    );
    await store.updateProposal(proposal.id, { phase: 'open', approvals: 1 });

    const body = await get();

    expect(body.status).toBe('broadcasting');
    const approval = {
      state: 'awaiting',
      approvals: 1,
      threshold: 3,
      deadline: '2026-10-24T12:00:00.000Z',
      expected,
      chainRef: squadsRef,
    };
    expect(body.items).toEqual([
      ...[0, 1].map(() => ({
        type: 'call',
        to: '0xabc',
        status: 'awaiting_approval',
        transactionHash: null,
        error: null,
        approval,
      })),
    ]);
  });

  it('keeps the approval block once executed and confirmed, now with the executed hash', async () => {
    const { get, calls, store, propose } = await setup();
    const proposal = await propose(
      calls.map((c) => c.id),
      'prop',
    );
    await store.updateProposal(proposal.id, { phase: 'open', approvalState: 'approved' });
    await store.markProposalExecuting(proposal.id, 'bytes', 'exec-hash');
    expect((await get()).items.map((i) => i.status)).toEqual(['broadcasting', 'broadcasting']);

    await store.settleProposal(proposal.id, { status: 'CONFIRMED' });

    const body = await get();
    expect(body.status).toBe('confirmed');
    for (const item of body.items) {
      expect(item).toMatchObject({
        status: 'confirmed',
        transactionHash: 'exec-hash',
        approval: { state: 'approved', approvals: 0, threshold: 3 },
      });
    }
  });

  it('keeps the block after APPROVAL_REJECTED (failed) and APPROVAL_TIMEOUT (abandoned)', async () => {
    const { get, calls, store, propose } = await setup(1);
    const proposal = await propose([calls[0]?.id ?? ''], 'prop');

    await store.settleProposal(proposal.id, {
      status: 'FAILED',
      error: { code: 'APPROVAL_REJECTED', message: 'rejected' },
    });
    let body = await get();
    expect(body.status).toBe('failed');
    expect(body.items[0]).toMatchObject({
      status: 'failed',
      transactionHash: null,
      error: { code: 'APPROVAL_REJECTED' },
      approval: { state: 'awaiting' },
    });

    await store.settleProposal(proposal.id, {
      status: 'ABANDONED',
      error: { code: 'APPROVAL_TIMEOUT', message: 'no decision' },
    });
    await store.updateProposal(proposal.id, { approvalState: 'approved_after_deadline' });
    body = await get();
    expect(body.items[0]).toMatchObject({
      status: 'abandoned',
      transactionHash: null,
      error: { code: 'APPROVAL_TIMEOUT' },
      approval: { state: 'approved_after_deadline' },
    });
  });

  it('gives each Call the block of its own Proposal when a Dispatch has several', async () => {
    const { get, calls, store, propose } = await setup();
    const first = await propose([calls[0]?.id ?? ''], 'prop-a');
    const second = await propose([calls[1]?.id ?? ''], 'prop-b');
    await store.updateProposal(second.id, { approvals: 2, approvalState: 'approved' });

    const body = await get();

    expect(first.id).not.toBe(second.id);
    expect(body.items.map((i) => [i.status, i.approval?.state, i.approval?.approvals])).toEqual([
      ['awaiting_approval', 'awaiting', 0],
      ['awaiting_approval', 'approved', 2],
    ]);
  });

  it('serializes a Dispatch with no Proposals exactly as before, without even looking for them', async () => {
    const { app, store } = await buildTestApp();
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(CHAINS, 10);
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'bytes',
      hash: 'hash-1',
    });
    await store.markConfirmed(transaction.id);
    const lookups: string[] = [];
    store.listProposalsForDispatch = (id) => {
      lookups.push(id);
      return Promise.resolve([]);
    };

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatch.id}`,
      headers: AUTH_HEADERS,
    });

    expect(response.body).toBe(
      JSON.stringify({
        dispatchId: dispatch.id,
        mode: 'managed',
        status: 'confirmed',
        items: [
          {
            type: 'call',
            to: '0xabc',
            status: 'confirmed',
            transactionHash: 'hash-1',
            error: null,
          },
        ],
      }),
    );
    expect(lookups).toEqual([]);
  });
});

describe('POST /v1/dispatch/:id/cancel (ADR-0056)', () => {
  type App = Awaited<ReturnType<typeof buildTestApp>>['app'];
  const twoCalls = {
    chain: 'base',
    items: [
      { type: 'call', to: '0xabc', data: '0x', value: '0' },
      { type: 'call', to: '0xdef', data: '0x', value: '0' },
    ],
  };

  async function submit(app: App, key = 'key-1'): Promise<string> {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': key },
      payload: twoCalls,
    });
    return response.json<PostResponseBody>().dispatchId;
  }

  const cancel = (app: App, id: string) =>
    app.inject({ method: 'POST', url: `/v1/dispatch/${id}/cancel`, headers: AUTH_HEADERS });

  it('rejects a request without a valid bearer token', async () => {
    const { app } = await buildTestApp();
    const id = await submit(app);

    const response = await app.inject({ method: 'POST', url: `/v1/dispatch/${id}/cancel` });

    expect(response.statusCode).toBe(401);
  });

  it('cancels an unclaimed Dispatch: it and every item read cancelled, and it is never claimed', async () => {
    const { app, store } = await buildTestApp();
    const id = await submit(app);

    const response = await cancel(app, id);

    const cancelled = {
      dispatchId: id,
      mode: 'managed',
      status: 'cancelled',
      items: [
        { type: 'call', to: '0xabc', status: 'cancelled', transactionHash: null, error: null },
        { type: 'call', to: '0xdef', status: 'cancelled', transactionHash: null, error: null },
      ],
    };
    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual(cancelled);
    const read = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${id}`,
      headers: AUTH_HEADERS,
    });
    expect(read.json()).toEqual(cancelled);
    expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
  });

  it('answers a repeat cancel with 200 and the current state', async () => {
    const { app } = await buildTestApp();
    const id = await submit(app);
    await cancel(app, id);

    const response = await cancel(app, id);

    expect(response.statusCode).toBe(200);
    expect(response.json<GetResponseBody>().status).toBe('cancelled');
  });

  it('refuses a claimed Dispatch with 409 ALREADY_CLAIMED', async () => {
    const { app, store } = await buildTestApp();
    const id = await submit(app);
    await store.claimQueued(CHAINS, 10);

    const response = await cancel(app, id);

    expect(response.statusCode).toBe(409);
    expect(response.json<{ code: string }>().code).toBe('ALREADY_CLAIMED');
  });

  it('answers 401 before checking the query of an unauthenticated request', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({ method: 'GET', url: '/v1/dispatches?limit=500' });

    expect(response.statusCode).toBe(401);
  });

  it('answers 404 for an id that is not a UUID', async () => {
    const { app } = await buildTestApp();

    const response = await cancel(app, 'not-a-uuid');

    expect(response.statusCode).toBe(404);
  });

  it('answers 404 for an unknown id', async () => {
    const { app } = await buildTestApp();

    const response = await cancel(app, randomUUID());

    expect(response.statusCode).toBe(404);
  });

  it('cancels an unclaimed Relay Dispatch', async () => {
    const { app, store } = await buildTestApp();
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-1' },
      payload: { chain: 'base', mode: 'relay', signedTransaction: 'externally-signed-bytes' },
    });
    const id = submitted.json<PostResponseBody>().dispatchId;

    const response = await cancel(app, id);

    expect(response.statusCode).toBe(200);
    expect(response.json()).toEqual({
      dispatchId: id,
      mode: 'relay',
      status: 'cancelled',
      transactionHash: null,
      error: null,
    });
    expect(await store.claimQueuedRelayDispatches(CHAINS, 10)).toEqual([]);
  });

  it('returns a cancelled Dispatch for its Idempotency-Key, creating nothing new', async () => {
    const { app, store } = await buildTestApp();
    const id = await submit(app, 'key-1');
    await cancel(app, id);

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: twoCalls,
    });

    expect(response.statusCode).toBe(202);
    expect(response.json()).toEqual({ dispatchId: id, status: 'cancelled' });
    expect(await store.claimQueued(CHAINS, 10)).toEqual([]);
  });
});

describe('GET /v1/dispatch/:id?include=timeline (#109)', () => {
  type TimelineBody = { timeline?: { at: string; kind: string; hash?: string }[] };

  async function confirmedDispatch() {
    const { app, store } = await buildTestApp();
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(CHAINS, 10);
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'bytes',
      hash: 'hash-1',
    });
    await store.markConfirmed(transaction.id);
    return { app, store, id: dispatch.id };
  }

  it('adds the timeline, oldest first, with ISO timestamps', async () => {
    const { app, id } = await confirmedDispatch();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${id}?include=timeline`,
      headers: AUTH_HEADERS,
    });

    const body = response.json<GetResponseBody & TimelineBody>();
    expect(body.status).toBe('confirmed');
    expect(body.timeline?.map((e) => [e.kind, e.hash])).toEqual([
      ['created', undefined],
      ['claimed', undefined],
      ['written', 'hash-1'],
      ['confirmed', 'hash-1'],
    ]);
    expect(body.timeline?.every((e) => !Number.isNaN(Date.parse(e.at)))).toBe(true);
  });

  it('leaves the body without the flag exactly as it was', async () => {
    const { app, id } = await confirmedDispatch();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${id}`,
      headers: AUTH_HEADERS,
    });

    expect(response.body).toBe(
      JSON.stringify({
        dispatchId: id,
        mode: 'managed',
        status: 'confirmed',
        items: [
          {
            type: 'call',
            to: '0xabc',
            status: 'confirmed',
            transactionHash: 'hash-1',
            error: null,
          },
        ],
      }),
    );
  });

  it('adds the timeline to a Relay Dispatch', async () => {
    const { app } = await buildTestApp();
    const submitted = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'relay-1' },
      payload: { chain: 'base', mode: 'relay', signedTransaction: 'externally-signed-bytes' },
    });
    const id = submitted.json<PostResponseBody>().dispatchId;

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${id}?include=timeline`,
      headers: AUTH_HEADERS,
    });

    expect(response.json<RelayGetResponseBody & TimelineBody>()).toMatchObject({
      mode: 'relay',
      status: 'queued',
      timeline: [{ kind: 'created' }],
    });
  });

  it.each(['include=everything', 'include=timeline&include=timeline', 'include='])(
    'answers %s with the plain body, exactly as without it',
    async (query) => {
      const { app, id } = await confirmedDispatch();

      const plain = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${id}`,
        headers: AUTH_HEADERS,
      });
      const response = await app.inject({
        method: 'GET',
        url: `/v1/dispatch/${id}?${query}`,
        headers: AUTH_HEADERS,
      });

      expect(response.statusCode).toBe(200);
      expect(response.body).toBe(plain.body);
    },
  );
});

describe('GET /v1/dispatches (#110)', () => {
  type ListBody = {
    dispatches: Record<string, unknown>[];
    nextCursor: string | null;
  };

  it('rejects a request without a valid bearer token', async () => {
    const { app } = await buildTestApp();

    const missing = await app.inject({ method: 'GET', url: '/v1/dispatches' });
    const wrong = await app.inject({
      method: 'GET',
      url: '/v1/dispatches',
      headers: { authorization: 'Bearer nope' },
    });

    expect(missing.statusCode).toBe(401);
    expect(wrong.statusCode).toBe(401);
  });

  it.each([
    'limit=0',
    'limit=101',
    'limit=ten',
    'chain=ethereum',
    'mode=batch',
    'status=awaiting_approval',
    'from=yesterday',
    'to=2026-13-45',
    'cursor=not-a-cursor',
  ])('rejects %s with 400', async (query) => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'GET',
      url: `/v1/dispatches?${query}`,
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(400);
  });

  it('lists Managed and Relay rows newest first, each a summary with its count and totals', async () => {
    const { app, store } = await buildTestApp();
    const managed = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'managed',
      items: [
        {
          call: { to: '0xa', data: '0x', value: '0' },
          payment: { recipient: '0xa', asset: 'USDC', amount: '10' },
        },
        {
          call: { to: '0xb', data: '0x', value: '0' },
          payment: { recipient: '0xb', asset: 'USDC', amount: '15' },
        },
        {
          call: { to: '0xc', data: '0x', value: '1' },
          payment: { recipient: '0xc', asset: 'ETH', amount: '1' },
        },
        { call: { to: '0xd', data: '0x', value: '0' }, payment: null },
      ],
      retryPolicy: false,
    });
    await new Promise((resolve) => setTimeout(resolve, 2));
    const relay = await store.createRelayDispatch({
      chain: 'base',
      idempotencyKey: 'relay',
      signedTransaction: 'signed',
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/dispatches',
      headers: AUTH_HEADERS,
    });

    expect(response.statusCode).toBe(200);
    expect(response.json<ListBody>()).toEqual({
      dispatches: [
        {
          dispatchId: relay.id,
          mode: 'relay',
          chain: 'base',
          status: 'queued',
          transactionHash: null,
          error: null,
          createdAt: relay.createdAt.toISOString(),
          itemCount: 1,
          totals: [],
        },
        {
          dispatchId: managed.id,
          mode: 'managed',
          chain: 'base',
          status: 'queued',
          createdAt: managed.createdAt.toISOString(),
          itemCount: 4,
          totals: [
            { asset: 'USDC', decimals: 6, amount: '25' },
            { asset: 'ETH', decimals: 18, amount: '1' },
          ],
        },
      ],
      nextCursor: null,
    });
  });

  it('pages 25 rows by default and hands back a cursor for the rest', async () => {
    const { app, store } = await buildTestApp();
    for (let i = 0; i < 26; i++) {
      await store.createRelayDispatch({
        chain: 'base',
        idempotencyKey: `relay-${i}`,
        signedTransaction: 'signed',
      });
    }

    const first = (
      await app.inject({ method: 'GET', url: '/v1/dispatches', headers: AUTH_HEADERS })
    ).json<ListBody>();
    const second = (
      await app.inject({
        method: 'GET',
        url: `/v1/dispatches?cursor=${first.nextCursor ?? ''}`,
        headers: AUTH_HEADERS,
      })
    ).json<ListBody>();

    expect(first.dispatches).toHaveLength(25);
    expect(second.dispatches).toHaveLength(1);
    expect(second.nextCursor).toBeNull();
  });

  it('stops a filtered scan after MAX_SCANNED_ROWS rows and hands back a cursor to keep paging', async () => {
    const { app, store } = await buildTestApp();
    const confirmed = await store.createRelayDispatch({
      chain: 'base',
      idempotencyKey: 'confirmed',
      signedTransaction: 'signed',
    });
    await store.claimQueuedRelayDispatches(CHAINS, 1);
    const transaction = await store.createTransaction({
      dispatchId: confirmed.id,
      callIndex: 0,
      chain: 'base',
      signedBytes: 'signed',
      hash: 'hash-1',
    });
    await store.setRelayDispatchTransaction(confirmed.id, transaction.id);
    await store.markConfirmed(transaction.id);
    await new Promise((resolve) => setTimeout(resolve, 2));
    for (let i = 0; i < MAX_SCANNED_ROWS; i++) {
      await store.createRelayDispatch({
        chain: 'base',
        idempotencyKey: `claimed-${i}`,
        signedTransaction: 'signed',
      });
    }
    await store.claimQueuedRelayDispatches(CHAINS, MAX_SCANNED_ROWS);

    const first = (
      await app.inject({
        method: 'GET',
        url: '/v1/dispatches?status=confirmed',
        headers: AUTH_HEADERS,
      })
    ).json<ListBody>();
    const second = (
      await app.inject({
        method: 'GET',
        url: `/v1/dispatches?status=confirmed&cursor=${first.nextCursor ?? ''}`,
        headers: AUTH_HEADERS,
      })
    ).json<ListBody>();

    expect(first.dispatches).toEqual([]);
    expect(first.nextCursor).not.toBeNull();
    expect(second.dispatches.map((d) => d.dispatchId)).toEqual([confirmed.id]);
    expect(second.nextCursor).toBeNull();
  });

  it('filters on the cancelled status', async () => {
    const { app, store } = await buildTestApp();
    const cancelled = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'cancelled',
      items: [{ call: { to: '0xa', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.cancelDispatch(cancelled.id, { tokenKind: 'auth', reason: null });
    await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'queued',
      items: [{ call: { to: '0xa', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });

    const response = await app.inject({
      method: 'GET',
      url: '/v1/dispatches?status=cancelled',
      headers: AUTH_HEADERS,
    });

    expect(response.json<ListBody>().dispatches.map((d) => d.dispatchId)).toEqual([cancelled.id]);
  });
});
