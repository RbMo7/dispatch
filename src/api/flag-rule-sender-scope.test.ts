import { describe, expect, it } from 'vitest';

import { buildApp } from '../app.js';
import { ChainRegistry, type RegisteredSender } from '../chain-registry/chain-registry.js';
import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import type { SenderAddress, SenderName } from '../domain/sender.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { registryFromConfig } from '../asset-registry/configured-assets.js';

const CLIENT = { authorization: 'Bearer client-token' };
const OPERATOR = { authorization: 'Bearer operator-token' };
const ALICE = '0x52908400098527886E0F7030069857D2E4169EE7';
const PAYOUTS = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A' as SenderAddress;
const TREASURY = '0x5afE000000000000000000000000000000005AFE' as SenderAddress;

function sender(name: string, address: SenderAddress, isDefault: boolean): RegisteredSender {
  return {
    chain: 'base',
    name: name as SenderName,
    address,
    isDefault,
    handler: new StubChainHandler(),
  };
}

function setup(senders = [sender('payouts', PAYOUTS, true), sender('treasury', TREASURY, false)]) {
  const store = new InMemoryDispatchStore();
  const app = buildApp({
    store,
    chainRegistry: ChainRegistry.fromSenders(senders),
    authToken: 'client-token',
    operatorToken: 'operator-token',
    defaultRetryPolicy: false,
    assets: registryFromConfig({ base: 'USDC:0x036CbD53842c5426634e7929541eC2318f3dCF7e:6' }),
    readToken: {},
    listSenders: () => Promise.resolve([]),
    readSetup: () => Promise.reject(new Error('not read in this test')),
  });
  let keys = 0;
  const submit = async (payload: object) => {
    const response = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: { ...CLIENT, 'idempotency-key': `k${keys++}` },
      payload,
    });
    return response.json<{ dispatchId: string; status: string }>();
  };
  const createRule = (payload: object) =>
    app.inject({ method: 'POST', url: '/v1/flag-rules', headers: OPERATOR, payload });
  return { app, store, submit, createRule };
}

const bigUsdc = {
  name: 'Big USDC',
  chain: 'base',
  kind: 'item_over',
  asset: 'USDC',
  limit: '5000',
};
const pay = (amount: string) => ({ type: 'payment', recipient: ALICE, asset: 'USDC', amount });

describe('a Flag Rule scoped to one Sender (#149)', () => {
  it("holds only that Sender's Dispatches, while an unscoped rule holds every Sender's", async () => {
    const { submit, createRule } = setup();
    expect((await createRule({ ...bigUsdc, sender: 'treasury' })).statusCode).toBe(201);
    expect(
      (
        await createRule({
          name: 'Any huge',
          chain: 'base',
          kind: 'item_over',
          asset: 'USDC',
          limit: '9000',
        })
      ).statusCode,
    ).toBe(201);

    const statuses = {
      treasuryBig: (await submit({ chain: 'base', sender: 'treasury', items: [pay('6000000000')] }))
        .status,
      treasurySmall: (await submit({ chain: 'base', sender: 'treasury', items: [pay('1000000')] }))
        .status,
      payoutsBig: (await submit({ chain: 'base', sender: 'payouts', items: [pay('6000000000')] }))
        .status,
      payoutsHuge: (await submit({ chain: 'base', items: [pay('9500000000')] })).status,
    };

    expect(statuses).toEqual({
      treasuryBig: 'held',
      treasurySmall: 'queued',
      payoutsBig: 'queued',
      payoutsHuge: 'held',
    });
  });

  it('shows the scope by name and address on the rule and each version, null when unscoped', async () => {
    const { app, createRule } = setup();
    const created = await createRule(bigUsdc);
    const { ruleId } = created.json<{ ruleId: string }>();

    const edited = await app.inject({
      method: 'PUT',
      url: `/v1/flag-rules/${ruleId}`,
      headers: OPERATOR,
      payload: { ...bigUsdc, sender: 'treasury' },
    });

    expect(created.json()).toMatchObject({ sender: null });
    expect(edited.json()).toMatchObject({
      sender: { name: 'treasury', address: TREASURY },
      versions: [{ sender: null }, { sender: { name: 'treasury', address: TREASURY } }],
    });
  });

  it('refuses a Sender the chain does not have, naming the ones it does', async () => {
    const { createRule } = setup();

    const response = await createRule({ ...bigUsdc, sender: 'refunds' });

    expect(response.statusCode).toBe(400);
    expect(response.json()).toEqual({
      error: 'sender: base has no Sender named "refunds" (payouts, treasury)',
    });
  });

  it('keeps the scope of a Sender later removed from the config, by address with no name', async () => {
    const first = setup();
    await first.createRule({ ...bigUsdc, sender: 'treasury' });
    const rules = await first.store.listFlagRules();

    const later = setup([sender('payouts', PAYOUTS, true)]);
    const rule = rules[0];
    if (!rule) throw new Error('no rule');
    await later.store.createFlagRule(rule.current, { tokenKind: 'operator', reason: null });
    const listed = await later.app.inject({
      method: 'GET',
      url: '/v1/flag-rules',
      headers: CLIENT,
    });

    expect(listed.json()).toMatchObject({
      rules: [{ sender: { name: null, address: TREASURY } }],
    });
  });

  it("previews over only its Sender's Dispatches", async () => {
    const { app, submit } = setup();
    await submit({ chain: 'base', sender: 'treasury', items: [pay('6000000000')] });
    await submit({ chain: 'base', sender: 'payouts', items: [pay('6000000000')] });
    await submit({ chain: 'base', sender: 'payouts', items: [pay('7000000000')] });
    const preview = (payload: object) =>
      app
        .inject({ method: 'POST', url: '/v1/flag-rules/preview', headers: OPERATOR, payload })
        .then((r) => r.json<{ scanned: number; wouldHold: number }>());

    expect(await preview({ ...bigUsdc, sender: 'treasury' })).toMatchObject({
      scanned: 1,
      wouldHold: 1,
    });
    expect(await preview({ ...bigUsdc, sender: 'payouts' })).toMatchObject({
      scanned: 2,
      wouldHold: 2,
    });
    expect(await preview(bigUsdc)).toMatchObject({ scanned: 3, wouldHold: 3 });
  });

  it("counts a scoped daily volume rule against its own Sender's volume only", async () => {
    const { submit, createRule } = setup();
    const daily = {
      name: 'Daily',
      chain: 'base',
      kind: 'daily_volume_over',
      asset: 'USDC',
      limit: '100',
    };
    await createRule({ ...daily, sender: 'treasury' });
    await submit({ chain: 'base', sender: 'payouts', items: [pay('90000000')] });

    const treasuryFirst = await submit({
      chain: 'base',
      sender: 'treasury',
      items: [pay('20000000')],
    });
    const treasuryOver = await submit({
      chain: 'base',
      sender: 'treasury',
      items: [pay('81000000')],
    });

    expect([treasuryFirst.status, treasuryOver.status]).toEqual(['queued', 'held']);
  });
});
