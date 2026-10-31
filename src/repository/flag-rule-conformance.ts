import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { DispatchItem } from '../domain/call.js';
import { CHAINS } from '../domain/chain.js';
import type { FlagRuleSpec, RuleMatch } from '../domain/flag-rule.js';
import type { OperatorActor } from '../domain/operator-action.js';
import type { DispatchStore } from './dispatch-store.js';

const operator: OperatorActor = { tokenKind: 'operator', reason: null };

const bigUsdc: FlagRuleSpec = {
  name: 'Big USDC',
  chain: 'base',
  enabled: true,
  definition: { kind: 'item_over', asset: 'USDC', limit: '5000', limitUnits: 5_000_000_000n },
};

async function actionsOn(store: DispatchStore, targetId: string) {
  const listed = await store.listOperatorActions({ after: null, limit: 100 });
  return listed
    .filter((l) => l.action.targetId === targetId)
    .map((l) => l.action.action)
    .sort();
}

export function runFlagRuleConformanceSuite(makeStore: () => DispatchStore): void {
  describe('Flag Rules (ADR-0058)', () => {
    it('creates version 1, readable by id and listed', async () => {
      const store = makeStore();

      const rule = await store.createFlagRule(bigUsdc, operator);

      expect(rule.current).toMatchObject({ ...bigUsdc, ruleId: rule.id, version: 1 });
      expect(await store.getFlagRule(rule.id)).toEqual(rule);
      expect((await store.listFlagRules()).map((r) => r.id)).toEqual([rule.id]);
    });

    it('an edit writes the next version and keeps every earlier one as it was', async () => {
      const store = makeStore();
      const rule = await store.createFlagRule(bigUsdc, operator);
      const raised: FlagRuleSpec = {
        ...bigUsdc,
        definition: { kind: 'item_over', asset: 'USDC', limit: '9000', limitUnits: 9_000_000_000n },
      };

      await store.updateFlagRule(rule.id, raised, operator);
      const edited = await store.updateFlagRule(rule.id, { ...raised, enabled: false }, operator);

      const read = await store.getFlagRule(rule.id);
      expect(edited).toEqual(read);
      expect(read?.current).toMatchObject({ version: 3, enabled: false });
      expect(read?.versions.map((v) => [v.version, v.definition, v.enabled])).toEqual([
        [1, bigUsdc.definition, true],
        [2, raised.definition, true],
        [3, raised.definition, false],
      ]);
    });

    it('a delete hides the rule from the list but keeps it and its history, and refuses edits', async () => {
      const store = makeStore();
      const rule = await store.createFlagRule(bigUsdc, operator);
      await store.updateFlagRule(rule.id, { ...bigUsdc, name: 'Renamed' }, operator);

      const outcome = await store.deleteFlagRule(rule.id, operator);

      expect(outcome).toMatchObject({
        deleted: true,
        rule: { deletedAt: expect.any(Date) as Date },
      });
      expect(await store.listFlagRules()).toEqual([]);
      expect((await store.getFlagRule(rule.id))?.versions).toHaveLength(2);
      expect(await store.updateFlagRule(rule.id, bigUsdc, operator)).toBe('deleted');
      expect(await store.deleteFlagRule(rule.id, operator)).toMatchObject({ deleted: false });
    });

    it('records one operator action per write, none for a repeat delete', async () => {
      const store = makeStore();
      const rule = await store.createFlagRule(bigUsdc, { tokenKind: 'operator', reason: 'launch' });
      await store.updateFlagRule(rule.id, bigUsdc, operator);
      await store.deleteFlagRule(rule.id, operator);
      await store.deleteFlagRule(rule.id, operator);

      expect(await actionsOn(store, rule.id)).toEqual([
        'flag_rule_create',
        'flag_rule_delete',
        'flag_rule_update',
      ]);
    });

    it('reports an unknown id', async () => {
      const store = makeStore();
      const id = randomUUID();

      expect(await store.getFlagRule(id)).toBeNull();
      expect(await store.updateFlagRule(id, bigUsdc, operator)).toBe('not_found');
      expect(await store.deleteFlagRule(id, operator)).toBe('not_found');
    });

    it('lists the current version of each enabled, undeleted rule on a chain', async () => {
      const store = makeStore();
      const edited = await store.createFlagRule(bigUsdc, operator);
      await store.updateFlagRule(edited.id, { ...bigUsdc, name: 'v2' }, operator);
      const disabled = await store.createFlagRule(bigUsdc, operator);
      await store.updateFlagRule(disabled.id, { ...bigUsdc, enabled: false }, operator);
      const deleted = await store.createFlagRule(bigUsdc, operator);
      await store.deleteFlagRule(deleted.id, operator);
      await store.createFlagRule({ ...bigUsdc, chain: 'solana' }, operator);

      const enabled = await store.listEnabledFlagRules('base');

      expect(enabled.map((v) => [v.ruleId, v.version, v.name])).toEqual([[edited.id, 2, 'v2']]);
    });
  });

  describe('holds and the facts Flag Rules read (ADR-0058)', () => {
    const payTo = (recipient: string, amount: string, asset = 'USDC'): DispatchItem<'base'> => ({
      call: { to: '0xtoken', data: '0x', value: '0' },
      payment: { recipient, asset, amount },
    });
    const submit = (store: DispatchStore, items: DispatchItem<'base'>[], hold?: RuleMatch[]) =>
      store.createDispatch({
        chain: 'base',
        idempotencyKey: randomUUID(),
        items,
        retryPolicy: false,
        ...(hold ? { hold } : {}),
      });

    it('stores a Dispatch with matches as held, keeps why, and never claims it', async () => {
      const store = makeStore();
      const rule = await store.createFlagRule(bigUsdc, operator);
      const held = await submit(
        store,
        [payTo('0xa', '1'), payTo('0xb', '9000000000')],
        [{ rule: rule.current, items: [1] }],
      );
      const queued = await submit(store, [payTo('0xa', '1')]);

      expect(held.status).toBe('held');
      expect(await store.getHold(held.id)).toEqual({
        dispatchId: held.id,
        matched: [{ rule: rule.current, items: [1] }],
        heldAt: expect.any(Date) as Date,
      });
      expect(await store.getHold(queued.id)).toBeNull();
      expect((await store.claimQueued(CHAINS, 10)).map((d) => d.id)).toEqual([queued.id]);
      expect((await store.getDispatch(held.id))?.status).toBe('held');
    });

    it('a hold keeps the version it matched after the rule is edited or deleted', async () => {
      const store = makeStore();
      const rule = await store.createFlagRule(bigUsdc, operator);
      const held = await submit(
        store,
        [payTo('0xa', '9000000000')],
        [{ rule: rule.current, items: [0] }],
      );

      await store.updateFlagRule(rule.id, { ...bigUsdc, name: 'Renamed' }, operator);
      await store.deleteFlagRule(rule.id, operator);

      expect((await store.getHold(held.id))?.matched[0]?.rule).toEqual(rule.current);
      expect((await store.getDispatch(held.id))?.status).toBe('held');
    });

    it('returns the held Dispatch for its Idempotency-Key, ignoring a different hold', async () => {
      const store = makeStore();
      const rule = await store.createFlagRule(bigUsdc, operator);
      const key = randomUUID();
      const input = { chain: 'base' as const, idempotencyKey: key, retryPolicy: false };
      const held = await store.createDispatch({
        ...input,
        items: [payTo('0xa', '1')],
        hold: [{ rule: rule.current, items: [0] }],
      });

      const again = await store.createDispatch({ ...input, items: [payTo('0xa', '1')] });

      expect(again).toMatchObject({ id: held.id, status: 'held' });
    });

    it('reports when each recipient was first paid with a confirmed payment, ignoring case on Base', async () => {
      const store = makeStore();
      const dispatch = await submit(store, [
        payTo('0xAAAA', '1'),
        payTo('0xbbbb', '1'),
        payTo('0xcccc', '1'),
      ]);
      await store.claimQueued(CHAINS, 10);
      const [confirmed, pending] = await store.createTransactions([
        { dispatchId: dispatch.id, callIndex: 0, chain: 'base', signedBytes: 's0', hash: 'h0' },
        { dispatchId: dispatch.id, callIndex: 1, chain: 'base', signedBytes: 's1', hash: 'h1' },
      ]);
      await store.markConfirmed(confirmed?.id ?? '');
      await store.recordCallFailure({
        dispatchId: dispatch.id,
        callIndex: 2,
        chain: 'base',
        error: { code: 'CHAIN_REJECTED', message: 'no' },
      });

      const first = await store.firstConfirmedPayments('base', ['0xaaaa', '0xbbbb', '0xcccc']);

      expect(pending?.status).toBe('PENDING');
      expect([...first.keys()]).toEqual(['0xaaaa']);
      expect(first.get('0xaaaa')).toBeInstanceOf(Date);
      expect(await store.firstConfirmedPayments('solana', ['0xaaaa'])).toEqual(new Map());
    });

    it('sums accepted payments of each asset since a time, held included, cancelled not', async () => {
      const store = makeStore();
      const rule = await store.createFlagRule(bigUsdc, operator);
      await submit(store, [payTo('0xa', '100'), payTo('0xa', '1', 'ETH')]);
      await submit(store, [payTo('0xa', '20')], [{ rule: rule.current, items: [0] }]);
      const cancelled = await submit(store, [payTo('0xa', '3')]);
      await store.cancelDispatch(cancelled.id, operator);

      const totals = await store.acceptedVolume('base', ['USDC', 'SOL'], new Date(0));

      expect(totals).toEqual(new Map([['USDC', 120n]]));
      expect(await store.acceptedVolume('base', ['USDC'], new Date(Date.now() + 60_000))).toEqual(
        new Map(),
      );
    });
  });
}
