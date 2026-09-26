import { beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import type { BulkCallPlan, BulkCallRequest } from '../chain-handler/chain-handler.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import type { DispatchItem } from '../domain/call.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';

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
    expect(await store.claimQueued(10)).toEqual([]);
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
      items: [{ status: 'queued', transactionHash: null, error: null }],
    });
  });

  it('reports confirmed once every item is confirmed', async () => {
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(10);
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
      items: [{ status: 'confirmed', transactionHash: 'hash-1', error: null }],
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
      await store.claimQueued(10);
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
    await store.claimQueued(10);
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
      { status: 'confirmed', transactionHash: 'hash-1', error: null },
      {
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
    await store.claimQueued(10);
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
    await store.claimQueued(10);
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
      await store.claimQueuedRelayDispatches(10);
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
      await store.claimQueuedRelayDispatches(10);
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
      await store.claimQueuedRelayDispatches(10);
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
