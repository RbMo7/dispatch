import { describe, expect, it, vi } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry, type RegisteredSender } from '../chain-registry/chain-registry.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import type { SenderAddress, SenderName } from '../domain/sender.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { cachedSenders, type SenderConfig, type SenderReads } from './senders.js';

const AUTH = { authorization: 'Bearer test-token' };
const PAYOUTS = '0xpayouts' as SenderAddress;
const REFUNDS = '0xrefunds' as SenderAddress;
const SOLANA_HOT = 'Hot1111111111111111111111111111111111111111' as SenderAddress;

function sender(
  chain: RegisteredSender['chain'],
  name: string,
  address: SenderAddress,
  isDefault: boolean,
): RegisteredSender {
  return { chain, name: name as SenderName, address, isDefault, handler: new StubChainHandler() };
}

function setup() {
  const store = new InMemoryDispatchStore();
  const senders = [
    sender('base', 'payouts', PAYOUTS, true),
    sender('base', 'refunds', REFUNDS, false),
    sender('solana', 'hot', SOLANA_HOT, false),
  ];
  const app = buildApp({
    store,
    chainRegistry: ChainRegistry.fromSenders(senders),
    authToken: 'test-token',
    defaultRetryPolicy: false,
    assetDecimals: () => undefined,
    listSenders: () => Promise.resolve([]),
  });
  let keys = 0;
  const post = (payload: Record<string, unknown>) =>
    app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...AUTH, 'idempotency-key': `key-${keys++}` },
      payload,
    });
  const get = (url: string) => app.inject({ method: 'GET', url, headers: AUTH });
  const payment = { type: 'payment', recipient: '0xabc', asset: 'ETH', amount: '1' };
  return { app, store, senders, post, get, payment };
}

describe('sender on POST /v1/dispatch (ADR-0060)', () => {
  it("pays from the chain's default Sender when the request names none", async () => {
    const { post, get, payment } = setup();

    const created = await post({ chain: 'base', items: [payment] });

    expect(created.statusCode).toBe(202);
    const { dispatchId } = created.json<{ dispatchId: string }>();
    expect((await get(`/v1/dispatch/${dispatchId}`)).json()).toMatchObject({
      sender: { name: 'payouts', address: PAYOUTS },
    });
  });

  it("pays from the Sender it names, translating its items with that Sender's handler", async () => {
    const { post, get, senders, payment } = setup();
    const refunds = vi.spyOn(senders[1]!.handler, 'paymentToCall');
    const payouts = vi.spyOn(senders[0]!.handler, 'paymentToCall');

    const created = await post({ chain: 'base', sender: 'refunds', items: [payment] });

    expect(created.statusCode).toBe(202);
    expect(refunds).toHaveBeenCalledTimes(1);
    expect(payouts).not.toHaveBeenCalled();
    const { dispatchId } = created.json<{ dispatchId: string }>();
    expect((await get(`/v1/dispatch/${dispatchId}`)).json()).toMatchObject({
      sender: { name: 'refunds', address: REFUNDS },
    });
  });

  it('refuses a Sender the chain does not have', async () => {
    const { post, store, payment } = setup();

    const response = await post({ chain: 'base', sender: 'hot', items: [payment] });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'UNKNOWN_SENDER',
      message: 'base has no Sender named "hot" (payouts, refunds)',
    });
    expect(await store.claimQueued(['base'], 10)).toEqual([]);
  });

  it('requires a Sender on a chain with no default', async () => {
    const { post, payment } = setup();

    const response = await post({ chain: 'solana', items: [payment] });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'SENDER_REQUIRED',
      message: 'solana has no default Sender: name one with "sender" (hot)',
    });
  });

  it('refuses a sender on a Relay Dispatch, which the engine never signs', async () => {
    const { post } = setup();

    const response = await post({
      chain: 'base',
      mode: 'relay',
      signedTransaction: 'signed',
      sender: 'payouts',
    });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error:
        'a relay dispatch has no Sender: it arrives already signed by its own wallet, so it takes no sender',
    });
  });

  it('keeps the Idempotency-Key rules: a repeat returns the original, whatever Sender it names', async () => {
    const { app, payment } = setup();
    const send = (senderName: string) =>
      app.inject({
        method: 'POST',
        url: '/v1/dispatch',
        headers: { ...AUTH, 'idempotency-key': 'same' },
        payload: { chain: 'base', sender: senderName, items: [payment] },
      });

    const first = await send('payouts');
    const repeat = await send('refunds');

    expect(repeat.json<{ dispatchId: string }>().dispatchId).toBe(
      first.json<{ dispatchId: string }>().dispatchId,
    );
  });
});

describe('sender on Dispatch reads (ADR-0060)', () => {
  it('shows a Sender no longer configured by its address, with no name', async () => {
    const { store, get } = setup();
    const dispatch = await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'removed',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
      senderAddress: '0xremoved' as SenderAddress,
    });

    expect((await get(`/v1/dispatch/${dispatch.id}`)).json()).toMatchObject({
      sender: { name: null, address: '0xremoved' },
    });
  });

  it("filters the list to one Sender's Dispatches, which leaves out every Relay Dispatch", async () => {
    const { post, get, payment } = setup();
    await post({ chain: 'base', items: [payment] });
    const refund = await post({ chain: 'base', sender: 'refunds', items: [payment] });
    await post({ chain: 'base', mode: 'relay', signedTransaction: 'signed' });

    const listed = await get('/v1/dispatches?sender=refunds');

    expect(listed.statusCode).toBe(200);
    const body = listed.json<{ dispatches: { dispatchId: string; sender: unknown }[] }>();
    expect(body.dispatches).toEqual([
      expect.objectContaining({
        dispatchId: refund.json<{ dispatchId: string }>().dispatchId,
        sender: { name: 'refunds', address: REFUNDS },
      }),
    ]);
    expect((await get('/v1/dispatches')).json<{ dispatches: unknown[] }>().dispatches).toHaveLength(
      3,
    );
  });

  it('refuses a list filter naming no configured Sender', async () => {
    const { get } = setup();

    const response = await get('/v1/dispatches?chain=solana&sender=payouts');

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      code: 'UNKNOWN_SENDER',
      message: 'no Sender named "payouts" on solana',
    });
  });
});

describe('GET /v1/senders with named Senders (ADR-0060)', () => {
  it('reports each Sender with its name and whether it is the default', async () => {
    const reads: SenderReads = {
      getBalance: (_chain, _address, asset) =>
        Promise.resolve({ ok: true, value: { asset, amount: '1' } }),
      getSignerKey: () => Promise.resolve(null),
      readThreshold: () => Promise.resolve({ ok: true, value: 1 }),
      listCommitted: () => Promise.resolve([]),
      now: () => new Date(0),
    };
    const config = (name: string, address: string, isDefault: boolean): SenderConfig => ({
      chain: 'base',
      name,
      isDefault,
      network: 'base-sepolia',
      address,
      assets: ['ETH'],
      assetDecimals: () => 18,
    });

    const views = await cachedSenders(
      [config('payouts', PAYOUTS, true), config('refunds', REFUNDS, false)],
      reads,
    )();

    expect(
      views.map(({ chain, name, default: isDefault, address }) => ({
        chain,
        name,
        isDefault,
        address,
      })),
    ).toEqual([
      { chain: 'base', name: 'payouts', isDefault: true, address: PAYOUTS },
      { chain: 'base', name: 'refunds', isDefault: false, address: REFUNDS },
    ]);
  });
});
