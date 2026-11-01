import pino from 'pino';
import { privateKeyToAccount, generatePrivateKey } from 'viem/accounts';
import { describe, expect, it } from 'vitest';

import { BaseChainHandler } from '../chain-handler/base/base-chain-handler.js';
import {
  FAKE_CHAIN_ID,
  FakeBaseChain,
  KeySigner,
} from '../chain-handler/base/test-support/fake-base-chain.js';
import type { DispatchItem } from '../domain/call.js';
import type { SenderAddress } from '../domain/sender.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import { Coordinator } from './coordinator.js';

const STUCK_AFTER_MS = 60_000;
const silent = pino({ level: 'silent' });

function payment(amount: number): { recipient: string; item: DispatchItem<'base'> } {
  const recipient = privateKeyToAccount(generatePrivateKey()).address;
  return {
    recipient,
    item: {
      call: { to: recipient, data: '0x', value: String(amount) },
      payment: { recipient, asset: 'ETH', amount: String(amount) },
    },
  };
}

/** One engine on the fake chain: the real BaseChainHandler and Coordinator over an in-memory store. */
async function engine() {
  const chain = new FakeBaseChain();
  const signer = new KeySigner();
  let clock = new Date('2026-11-01T00:00:00Z');
  const handler = await BaseChainHandler.create({
    rpcUrl: 'http://rpc.invalid',
    chainId: FAKE_CHAIN_ID,
    senderAddress: signer.address,
    signerClient: signer,
    nonceHistoryStore: new InMemoryNonceHistoryStore(),
    fetch: chain.fetch,
    logger: silent,
  });
  const store = new InMemoryDispatchStore(() => clock);
  const warnings: string[] = [];
  const coordinator = new Coordinator({
    store,
    chainHandlers: new Map([['base', handler]]),
    senderAddresses: new Map([['base', signer.address]]),
    abandonmentTimeoutMs: new Map([['base', 15 * 60_000]]),
    stuckHandling: new Map([['base', { stuckAfterMs: STUCK_AFTER_MS, maxFeeBumps: 5 }]]),
    now: () => clock,
    logger: pino(
      { level: 'warn' },
      { write: (line: string) => warnings.push((JSON.parse(line) as { msg: string }).msg) },
    ),
  });
  const submit = async (items: DispatchItem<'base'>[]) =>
    store.createDispatch({
      chain: 'base',
      idempotencyKey: crypto.randomUUID(),
      items,
      retryPolicy: false,
    });
  const statuses = async (dispatchId: string) => {
    const rows = await store.listTransactions(dispatchId);
    const items = [...new Set(rows.map((t) => t.callIndex))].sort();
    return items.map((i) => {
      const live = rows.filter(
        (t) => t.callIndex === i && t.status !== 'DROPPED' && t.status !== 'REPLACED',
      );
      return live.map((t) => t.status).join(',');
    });
  };
  const advance = (ms: number) => {
    clock = new Date(clock.getTime() + ms);
  };
  const sender = { chain: 'base' as const, address: signer.address as SenderAddress };
  return {
    chain,
    signer,
    sender,
    handler,
    store,
    coordinator,
    submit,
    statuses,
    advance,
    warnings,
  };
}

describe('a Base nonce another sender took (ADR-0064)', () => {
  it('an outside writer advances the nonce mid-batch: every payment confirms once', async () => {
    const { chain, signer, handler, store, coordinator, submit, statuses } = await engine();
    const payments = [1001, 1002, 1003, 1004, 1005].map(payment);
    let sends = 0;
    chain.beforeSend = () => {
      if (++sends === 2) chain.outsiderSends(signer.address, 2);
    };
    const dispatch = await submit(payments.map((p) => p.item));

    await coordinator.processQueuedDispatches(10);
    await coordinator.pollPendingTransactions(50);

    expect(await statuses(dispatch.id)).toEqual(Array(5).fill('CONFIRMED'));
    for (const { recipient } of payments) expect(chain.paidTo(recipient)).toHaveLength(1);
    expect(handler.peekNextNonce()).toBe(chain.nonceOf(signer.address));
    const dropped = (await store.listTransactions(dispatch.id)).filter(
      (t) => t.status === 'DROPPED',
    );
    expect(dropped).toHaveLength(1);
    expect(dropped[0]?.error).toMatchObject({
      code: 'NONCE_ALREADY_USED',
      message: 'Nonce 1 was taken by another sender. Sent again with nonce 3.',
      chainDetail: { reason: 'nonce_taken', nonce: 1, resentNonce: 3 },
    });
  });

  it('a pooled transaction whose nonce another sender then used is sent again only after a second refusal', async () => {
    const { chain, signer, coordinator, submit, statuses, advance } = await engine();
    const { recipient, item } = payment(2001);
    chain.mineOnSend = false;
    const dispatch = await submit([item]);
    await coordinator.processQueuedDispatches(10);
    chain.outsiderSends(signer.address);
    chain.mineOnSend = true;

    advance(STUCK_AFTER_MS);
    await coordinator.pollPendingTransactions(50);
    expect(await statuses(dispatch.id)).toEqual(['PENDING']);
    expect(chain.paidTo(recipient)).toHaveLength(0);

    advance(STUCK_AFTER_MS);
    await coordinator.pollPendingTransactions(50);
    await coordinator.pollPendingTransactions(50);
    expect(await statuses(dispatch.id)).toEqual(['CONFIRMED']);
    expect(chain.paidTo(recipient)).toHaveLength(1);
  });

  it('keeps waiting while the receipt cannot be read', async () => {
    const { chain, signer, coordinator, submit, statuses } = await engine();
    const { recipient, item } = payment(3001);
    chain.beforeSend = () => chain.outsiderSends(signer.address);
    chain.failReceipts = true;
    const dispatch = await submit([item]);

    await coordinator.processQueuedDispatches(10);

    expect(await statuses(dispatch.id)).toEqual(['PENDING']);
    expect(chain.paidTo(recipient)).toHaveLength(0);
  });

  it('fails the payment once another sender has taken its nonce on every resend', async () => {
    const { chain, signer, store, coordinator, submit, statuses } = await engine();
    const { recipient, item } = payment(4001);
    chain.beforeSend = () => chain.outsiderSends(signer.address);
    const dispatch = await submit([item]);

    await coordinator.processQueuedDispatches(10);

    expect(await statuses(dispatch.id)).toEqual(['FAILED']);
    expect(chain.paidTo(recipient)).toHaveLength(0);
    const rows = await store.listTransactions(dispatch.id);
    expect(rows.filter((t) => t.status === 'DROPPED')).toHaveLength(3);
    expect(rows.find((t) => t.status === 'FAILED')?.error).toMatchObject({
      code: 'NONCE_ALREADY_USED',
      chainDetail: { reason: 'nonce_taken', resends: 3 },
    });
  });
});

describe("detecting another sender in a Sender's wallet (ADR-0064)", () => {
  const another = /^another sender used this Sender's wallet/;

  it('records the nonces an outside writer used while the engine sent nothing, and warns once', async () => {
    const { chain, signer, sender, store, coordinator, warnings } = await engine();
    chain.outsiderSends(signer.address, 3);

    await coordinator.pollPendingTransactions(50);
    await coordinator.pollPendingTransactions(50);

    expect(await store.foreignActivity(sender, new Date(0))).toMatchObject({
      nonces: [0, 2],
      count: 3,
    });
    expect(warnings.filter((w) => another.test(w))).toEqual([
      "another sender used this Sender's wallet: nonces 0 to 2 were not sent by this engine. Only this engine may send from a Sender",
    ]);
  });

  it('tells its own nonces, confirmed or in flight, from the ones another sender used', async () => {
    const { chain, signer, sender, store, coordinator, submit, statuses, warnings } =
      await engine();
    await submit([payment(5001).item, payment(5002).item]);
    await coordinator.processQueuedDispatches(10);
    chain.outsiderSends(signer.address, 2);
    chain.mineOnSend = false;
    const inFlight = await submit([payment(5003).item]);
    await coordinator.processQueuedDispatches(10);

    await coordinator.pollPendingTransactions(50);
    expect(await statuses(inFlight.id)).toEqual(['PENDING']);
    chain.mineAll();
    await coordinator.pollPendingTransactions(50);

    expect(await statuses(inFlight.id)).toEqual(['CONFIRMED']);
    expect(await store.foreignActivity(sender, new Date(0))).toMatchObject({
      nonces: [2, 3],
      count: 2,
    });
    expect(warnings.filter((w) => another.test(w))).toEqual([
      "another sender used this Sender's wallet: nonce 2 was not sent by this engine. Only this engine may send from a Sender",
      "another sender used this Sender's wallet: nonce 3 was not sent by this engine. Only this engine may send from a Sender",
    ]);
  });

  it('reports nothing when only this engine sends', async () => {
    const { sender, store, coordinator, submit, warnings } = await engine();
    await submit([payment(6001).item, payment(6002).item]);
    await coordinator.processQueuedDispatches(10);

    await coordinator.pollPendingTransactions(50);

    expect(await store.foreignActivity(sender, new Date(0))).toBeNull();
    expect(warnings.filter((w) => another.test(w))).toEqual([]);
  });
});
