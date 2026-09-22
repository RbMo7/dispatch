import { beforeEach, describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';

const AUTH_HEADERS = { authorization: 'Bearer test-token' };

type PostResponseBody = { dispatchId: string; status: string };
type ErrorResponseBody = { error?: string; code?: string; message?: string };
type GetResponseBody = {
  dispatchId: string;
  status: string;
  items: { status: string; transactionHash: string | null; error: unknown }[];
};

async function buildTestApp(options?: { defaultRetryPolicy?: boolean }) {
  const store = new InMemoryDispatchStore();
  const chainRegistry = await ChainRegistry.load(['evm'], {
    evm: () => Promise.resolve(new StubChainHandler()),
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
      payload: { chain: 'evm', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
    });

    expect(response.statusCode).toBe(401);
  });

  it('rejects a request missing the Idempotency-Key header', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: AUTH_HEADERS,
      payload: { chain: 'evm', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
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
      payload: { chain: 'evm', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
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
        chain: 'evm',
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

  it('rejects a payment whose translation fails, with the structured DispatchError', async () => {
    const { app } = await buildTestApp();

    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH_HEADERS, 'idempotency-key': 'key-1' },
      payload: {
        chain: 'evm',
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
      payload: { chain: 'evm', items: [{ type: 'mystery' }] },
    });

    expect(response.statusCode).toBe(400);
  });

  it('resubmitting the same Idempotency-Key returns the original Dispatch, not a new one', async () => {
    const { app } = await buildTestApp();
    const payload = {
      chain: 'evm',
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
      payload: { chain: 'evm', items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }] },
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
        chain: 'evm',
        retryPolicy: false,
        items: [{ type: 'call', to: '0xabc', data: '0x', value: '0' }],
      },
    });

    const dispatch = await store.getDispatch(response.json<PostResponseBody>().dispatchId);
    expect(dispatch?.retryPolicy).toBe(false);
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
      chain: 'evm',
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
      status: 'queued',
      items: [{ status: 'queued', transactionHash: null, error: null }],
    });
  });

  it('reports confirmed once every item is confirmed', async () => {
    const dispatch = await store.createDispatch({
      chain: 'evm',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(10);
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'evm',
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
      status: 'confirmed',
      items: [{ status: 'confirmed', transactionHash: 'hash-1', error: null }],
    });
  });

  it('reports partial when some items confirm and others fail or are abandoned', async () => {
    const dispatch = await store.createDispatch({
      chain: 'evm',
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
      chain: 'evm',
      signedBytes: 'bytes',
      hash: 'hash-1',
    });
    await store.markConfirmed(confirmed.id);
    await store.recordCallFailure({
      dispatchId: dispatch.id,
      callIndex: 1,
      chain: 'evm',
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
      chain: 'evm',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(10);
    await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'evm',
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
      chain: 'evm',
      idempotencyKey: 'key-1',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
    });
    await store.claimQueued(10);
    const transaction = await store.createTransaction({
      dispatchId: dispatch.id,
      callIndex: 0,
      chain: 'evm',
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
});
