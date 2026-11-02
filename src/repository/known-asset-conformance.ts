import { describe, expect, it } from 'vitest';

import { NATIVE_ASSETS, type ConfigAsset, type NewKnownAsset } from '../domain/known-asset.js';
import type { DispatchStore } from './dispatch-store.js';

const USDC: ConfigAsset<'base'> = {
  chain: 'base',
  kind: 'erc20',
  address: '0x036CbD53842c5426634e7929541eC2318f3dCF7e',
  symbol: 'USDC',
  name: 'USDC',
  decimals: 6,
};
const EURC: NewKnownAsset<'base'> = {
  chain: 'base',
  kind: 'erc20',
  address: '0x808456652fdb597867f38412077A9182bf77359F',
  symbol: 'EURC',
  name: 'EURC',
  decimals: 6,
};
const operator = { tokenKind: 'operator' as const, reason: 'paying a new partner' };

/** ADR-0061: the Known Asset registry's storage, the same on every DispatchStore. */
export function runKnownAssetConformanceSuite(makeStore: () => DispatchStore): void {
  describe('Known Assets (ADR-0061)', () => {
    const configured = [NATIVE_ASSETS.base, USDC];
    const summary = async (store: DispatchStore) =>
      (await store.listKnownAssets())
        .map((a) => `${a.symbol}:${a.source}:${a.enabled ? 'on' : 'off'}`)
        .sort();

    it('seeds the configured assets as read-only rows, and a second seed changes nothing', async () => {
      const store = makeStore();
      expect((await store.seedConfigAssets(configured)).ok).toBe(true);
      const first = await store.listKnownAssets();
      expect((await store.seedConfigAssets(configured)).ok).toBe(true);
      expect(await store.listKnownAssets()).toEqual(expect.arrayContaining(first));
      expect(await summary(store)).toEqual(['ETH:config:on', 'USDC:config:on']);
    });

    it('disables a config row the configuration no longer lists, and enables it again when it does', async () => {
      const store = makeStore();
      await store.seedConfigAssets(configured);
      await store.seedConfigAssets([NATIVE_ASSETS.base]);
      expect(await summary(store)).toEqual(['ETH:config:on', 'USDC:config:off']);
      await store.seedConfigAssets(configured);
      expect(await summary(store)).toEqual(['ETH:config:on', 'USDC:config:on']);
    });

    it('adds a console row and records the operator action', async () => {
      const store = makeStore();
      const added = await store.addKnownAsset(EURC, operator);
      if (typeof added === 'string') throw new Error(added);
      expect(added).toMatchObject({
        ...EURC,
        source: 'console',
        addedBy: 'operator',
        enabled: true,
      });
      const [action] = await store.listOperatorActions({ after: null, limit: 10 });
      expect(action?.action).toMatchObject({
        action: 'asset_add',
        targetId: added.id,
        ...operator,
      });
    });

    it('refuses an address already known, and a symbol an enabled row holds in any case', async () => {
      const store = makeStore();
      await store.seedConfigAssets(configured);
      expect(await store.addKnownAsset({ ...EURC, address: USDC.address }, operator)).toBe(
        'address_taken',
      );
      expect(await store.addKnownAsset({ ...EURC, symbol: 'usdc' }, operator)).toBe('symbol_taken');
      expect(await store.addKnownAsset({ ...EURC, symbol: 'eth' }, operator)).toBe('symbol_taken');
    });

    it('disables and enables a console row, records each change once, and refuses a config row', async () => {
      const store = makeStore();
      await store.seedConfigAssets(configured);
      const added = await store.addKnownAsset(EURC, operator);
      if (typeof added === 'string') throw new Error(added);

      const off = await store.setKnownAssetEnabled(added.id, false, operator);
      expect(off).toMatchObject({ changed: true, asset: { enabled: false } });
      expect(await store.setKnownAssetEnabled(added.id, false, operator)).toMatchObject({
        changed: false,
      });
      expect(await store.setKnownAssetEnabled(added.id, true, operator)).toMatchObject({
        changed: true,
        asset: { enabled: true },
      });
      const actions = await store.listOperatorActions({ after: null, limit: 10 });
      expect(actions.map(({ action }) => action.action).sort()).toEqual([
        'asset_add',
        'asset_disable',
        'asset_enable',
      ]);

      const usdc = (await store.listKnownAssets()).find((a) => a.symbol === 'USDC')!;
      expect(await store.setKnownAssetEnabled(usdc.id, false, operator)).toBe('config_row');
      expect(
        await store.setKnownAssetEnabled('00000000-0000-4000-8000-000000000000', false, operator),
      ).toBe('not_found');
    });

    it('lets a disabled row give its symbol to another, and refuses to enable it while that one holds it', async () => {
      const store = makeStore();
      const old = await store.addKnownAsset(EURC, operator);
      if (typeof old === 'string') throw new Error(old);
      await store.setKnownAssetEnabled(old.id, false, operator);
      const next = await store.addKnownAsset(
        { ...EURC, address: '0x0000000000000000000000000000000000000E0C' },
        operator,
      );
      expect(typeof next).toBe('object');
      expect(await store.setKnownAssetEnabled(old.id, true, operator)).toBe('symbol_taken');
    });

    it('refuses to seed a configured symbol an enabled console row already uses', async () => {
      const store = makeStore();
      await store.addKnownAsset({ ...EURC, symbol: 'USDC' }, operator);
      const seeded = await store.seedConfigAssets(configured);
      expect(seeded.ok).toBe(false);
      expect(seeded.ok ? '' : seeded.error).toMatch(/USDC on base .* already uses that symbol/);
    });

    it('turns a console row at a configured address into a config row', async () => {
      const store = makeStore();
      await store.addKnownAsset({ ...EURC, address: USDC.address, symbol: 'USDC' }, operator);
      await store.seedConfigAssets(configured);
      expect(await summary(store)).toEqual(['ETH:config:on', 'USDC:config:on']);
    });
  });
}
