import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import { CHAINS } from '../domain/chain.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { PREVIEW_ROW_CAP } from './hold-check.js';

const CLIENT = { authorization: 'Bearer client-token' };
const OPERATOR = { authorization: 'Bearer operator-token' };
const ALICE = '0x52908400098527886E0F7030069857D2E4169EE7';
const BOB = '0x8617E340B3D01FA5F11F306F4090FD50E238070D';
const DAY = 24 * 60 * 60 * 1000;

/** A store clock that moves one second per read unless set, so no two events share a moment. */
async function buildTestApp() {
  let at = Date.now();
  const clock = { set: (time: number) => (at = time) };
  const store = new InMemoryDispatchStore(() => new Date((at += 1000)));
  const app = buildApp({
    store,
    chainRegistry: await ChainRegistry.load(['base'], {
      base: () => Promise.resolve(new StubChainHandler()),
    }),
    authToken: 'client-token',
    operatorToken: 'operator-token',
    defaultRetryPolicy: false,
    assetDecimals: (chain, asset) =>
      ({ base: { USDC: 6, ETH: 18 }, solana: { SOL: 9 } })[chain][asset as never],
    listSenders: () => Promise.resolve([]),
  });
  return { app, store, clock };
}

type Built = Awaited<ReturnType<typeof buildTestApp>>;
type Preview = {
  scanned: number;
  capped: boolean;
  wouldHold: number;
  examples: { dispatchId: string; createdAt: string; items: number[] }[];
};

const pay = (amount: string, recipient = ALICE) => ({
  type: 'payment',
  recipient,
  asset: 'USDC',
  amount,
});
const callTo = (to: string) => ({ type: 'call', to, data: '0x', value: '0' });

async function submit({ app }: Built, items: object[]): Promise<string> {
  const response = await app.inject({
    method: 'POST',
    url: '/v1/dispatch',
    headers: { ...CLIENT, 'idempotency-key': randomUUID() },
    payload: { chain: 'base', items },
  });
  return response.json<{ dispatchId: string }>().dispatchId;
}

const preview = async ({ app }: Built, rule: object, headers = OPERATOR) =>
  app.inject({ method: 'POST', url: '/v1/flag-rules/preview', headers, payload: rule });

/** Confirms every item of a Dispatch, releasing it first if it is held. */
async function confirm({ app, store }: Built, id: string) {
  await app.inject({
    method: 'POST',
    url: `/v1/dispatch/${id}/release`,
    headers: OPERATOR,
    payload: { reason: 'fixture' },
  });
  const [claimed] = await store.claimQueued(CHAINS, 10);
  const sent = await store.createTransactions(
    (claimed?.items ?? []).map((_, callIndex) => ({
      dispatchId: id,
      callIndex,
      chain: 'base' as const,
      signedBytes: 's',
      hash: `0x${id}${callIndex}`,
    })),
  );
  for (const t of sent) await store.markConfirmed(t.id);
}

const SCENARIOS: [string, object, (built: Built) => Promise<void>][] = [
  [
    'item_over',
    { chain: 'base', kind: 'item_over', asset: 'USDC', limit: '5' },
    async (b) => {
      await submit(b, [pay('5000000')]);
      await submit(b, [pay('5000001'), pay('1')]);
    },
  ],
  [
    'dispatch_total_over',
    { chain: 'base', kind: 'dispatch_total_over', asset: 'USDC', limit: '5' },
    async (b) => {
      await submit(b, [pay('2500000'), pay('2500000')]);
      await submit(b, [pay('2500000'), pay('2500001')]);
    },
  ],
  [
    'daily_volume_over',
    { chain: 'base', kind: 'daily_volume_over', asset: 'USDC', limit: '10' },
    async (b) => {
      const first = await submit(b, [pay('6000000')]);
      await submit(b, [pay('4000000')]);
      await submit(b, [pay('1')]);
      await b.app.inject({ method: 'POST', url: `/v1/dispatch/${first}/cancel`, headers: CLIENT });
      await submit(b, [pay('1')]);
    },
  ],
  [
    'first_time_recipient',
    { chain: 'base', kind: 'first_time_recipient' },
    async (b) => {
      const first = await submit(b, [pay('1')]);
      await confirm(b, first);
      await submit(b, [pay('1')]);
      await submit(b, [pay('1', BOB.toLowerCase()), pay('1')]);
    },
  ],
  [
    'recipient_not_allowlisted',
    { chain: 'base', kind: 'recipient_not_allowlisted', addresses: [ALICE] },
    async (b) => {
      await submit(b, [pay('1')]);
      await submit(b, [pay('1'), pay('1', BOB)]);
    },
  ],
  [
    'call_target_not_allowlisted',
    { chain: 'base', kind: 'call_target_not_allowlisted', addresses: [ALICE] },
    async (b) => {
      await submit(b, [callTo(ALICE)]);
      await submit(b, [pay('1', BOB), callTo(BOB)]);
    },
  ],
];

describe('POST /v1/flag-rules/preview (#119)', () => {
  it.each(SCENARIOS)(
    '%s: agrees with the live check on the same Dispatches',
    async (_, rule, scenario) => {
      const built = await buildTestApp();
      const created = await built.app.inject({
        method: 'POST',
        url: '/v1/flag-rules',
        headers: OPERATOR,
        payload: { name: 'live', ...rule },
      });
      const { ruleId } = created.json<{ ruleId: string }>();
      await scenario(built);
      await built.app.inject({
        method: 'DELETE',
        url: `/v1/flag-rules/${ruleId}`,
        headers: OPERATOR,
      });

      const listed = await built.store.listManagedDispatchesSince('base', new Date(0), 100);
      const live = [];
      for (const d of listed) {
        const hold = await built.store.getHold(d.id);
        if (hold) live.push({ dispatchId: d.id, items: hold.matched[0]?.items });
      }
      const response = await preview(built, rule);
      const body = response.json<Preview>();

      expect(response.statusCode).toBe(200);
      expect(live.length).toBeGreaterThan(0);
      expect(body.wouldHold).toBe(live.length);
      expect(body.examples.map(({ dispatchId, items }) => ({ dispatchId, items }))).toEqual(live);
      expect(body).toMatchObject({ scanned: listed.length, capped: false });
    },
  );

  it('looks back 30 days only', async () => {
    const built = await buildTestApp();
    built.clock.set(Date.now() - 31 * DAY);
    await submit(built, [pay('9000000')]);
    built.clock.set(Date.now());
    const recent = await submit(built, [pay('9000000')]);

    const body = (
      await preview(built, { chain: 'base', kind: 'item_over', asset: 'USDC', limit: '1' })
    ).json<Preview>();

    expect(body).toMatchObject({ scanned: 1, wouldHold: 1, examples: [{ dispatchId: recent }] });
  });

  it('reads at most its row cap, says so, and shows at most 10 examples', async () => {
    const built = await buildTestApp();
    for (let i = 0; i <= PREVIEW_ROW_CAP; i++) {
      await built.store.createDispatch({
        chain: 'base',
        idempotencyKey: randomUUID(),
        items: [
          {
            call: { to: '0xt', data: '0x', value: '0' },
            payment: { recipient: ALICE, asset: 'USDC', amount: '9000000' },
          },
        ],
        retryPolicy: false,
      });
    }

    const body = (
      await preview(built, { chain: 'base', kind: 'item_over', asset: 'USDC', limit: '1' })
    ).json<Preview>();

    expect(body).toMatchObject({
      scanned: PREVIEW_ROW_CAP,
      capped: true,
      wouldHold: PREVIEW_ROW_CAP,
    });
    expect(body.examples).toHaveLength(10);
  });

  it('saves nothing, needs no name, and refuses a bad rule or AUTH_TOKEN', async () => {
    const built = await buildTestApp();
    const rule = { chain: 'base', kind: 'item_over', asset: 'USDC', limit: '1' };

    const [ok, bad, client] = await Promise.all([
      preview(built, rule),
      preview(built, { ...rule, limit: 'lots' }),
      preview(built, rule, CLIENT),
    ]);

    expect(ok.statusCode).toBe(200);
    expect(bad.statusCode).toBe(400);
    expect(bad.json<{ error: string }>().error).toMatch(/^limit:/);
    expect(client.statusCode).toBe(403);
    expect(await built.store.listFlagRules()).toEqual([]);
  });
});
