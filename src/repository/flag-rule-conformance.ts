import { randomUUID } from 'node:crypto';

import { describe, expect, it } from 'vitest';

import type { FlagRuleSpec } from '../domain/flag-rule.js';
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
  });
}
