import { describe, expect, it } from 'vitest';

import type { NewKnownContract } from '../domain/known-contract.js';
import type { DispatchStore } from './dispatch-store.js';

const VAULT: NewKnownContract<'base'> = {
  chain: 'base',
  address: '0x79bB95AEF7f032144A9A5C6933B8d13a98e6D793',
  label: 'FlowVault',
  abi: [{ type: 'function', name: 'deposit', inputs: [{ name: 'note', type: 'string' }] }],
};
const PAYROLL: NewKnownContract<'solana'> = {
  chain: 'solana',
  address: 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB',
  label: 'Payroll',
  idl: { name: 'payroll', instructions: [{ name: 'pay', accounts: [], args: [] }] },
};
const operator = { tokenKind: 'operator' as const, reason: 'explaining vault deposits' };

/** ADR-0063: the contract registry's storage, the same on every DispatchStore. */
export function runKnownContractConformanceSuite(makeStore: () => DispatchStore): void {
  describe('the contract registry (ADR-0063)', () => {
    it('adds a row per chain with its definition as given, and records the operator action', async () => {
      const store = makeStore();
      const vault = await store.addKnownContract(VAULT, operator);
      const payroll = await store.addKnownContract(PAYROLL, operator);
      if (typeof vault === 'string' || typeof payroll === 'string') throw new Error('refused');

      expect(vault).toMatchObject({
        ...VAULT,
        source: 'console',
        addedBy: 'operator',
        enabled: true,
      });
      expect(payroll).toMatchObject({ ...PAYROLL, enabled: true });
      expect(await store.listKnownContracts()).toEqual(expect.arrayContaining([vault, payroll]));
      const actions = await store.listOperatorActions({ after: null, limit: 10 });
      expect(actions.map(({ action }) => [action.action, action.targetId, action.reason])).toEqual(
        expect.arrayContaining([
          ['contract_add', vault.id, operator.reason],
          ['contract_add', payroll.id, operator.reason],
        ]),
      );
    });

    it('keeps one enabled row per address: a replacement needs the old one disabled first', async () => {
      const store = makeStore();
      const first = await store.addKnownContract(VAULT, operator);
      if (typeof first === 'string') throw new Error(first);
      expect(await store.addKnownContract({ ...VAULT, label: 'Vault v2' }, operator)).toBe(
        'address_taken',
      );

      const disabled = await store.setKnownContractEnabled(first.id, false, operator);
      expect(disabled).toMatchObject({ contract: { enabled: false }, changed: true });
      const second = await store.addKnownContract({ ...VAULT, label: 'Vault v2' }, operator);
      if (typeof second === 'string') throw new Error(second);

      expect(await store.setKnownContractEnabled(first.id, true, operator)).toBe('address_taken');
      expect((await store.listKnownContracts()).map((c) => [c.label, c.enabled]).sort()).toEqual([
        ['FlowVault', false],
        ['Vault v2', true],
      ]);
    });

    it('records a change once: setting what it already is changes nothing', async () => {
      const store = makeStore();
      const added = await store.addKnownContract(PAYROLL, operator);
      if (typeof added === 'string') throw new Error(added);
      expect(await store.setKnownContractEnabled(added.id, true, operator)).toMatchObject({
        changed: false,
      });
      await store.setKnownContractEnabled(added.id, false, operator);
      await store.setKnownContractEnabled(added.id, false, operator);
      const kinds = (await store.listOperatorActions({ after: null, limit: 10 }))
        .filter(({ action }) => action.targetId === added.id)
        .map(({ action }) => action.action);
      expect(kinds.sort()).toEqual(['contract_add', 'contract_disable']);
      expect(
        await store.setKnownContractEnabled(
          '00000000-0000-4000-8000-000000000000',
          false,
          operator,
        ),
      ).toBe('not_found');
    });
  });
}
