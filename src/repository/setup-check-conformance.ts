import { describe, expect, it } from 'vitest';

import type { DispatchStore, SetupCheckRecord } from './dispatch-store.js';

const FIRST_RUN = new Date('2026-11-01T10:00:00.000Z');
const SECOND_RUN = new Date('2026-11-01T10:05:00.000Z');

const reachable: SetupCheckRecord = {
  id: 'signer.reachable',
  area: 'signer',
  title: 'Reachable',
  result: { status: 'pass', finding: 'answered at signer:8421' },
  ranAt: FIRST_RUN,
};
const fees: SetupCheckRecord = {
  id: 'sender.fees:solana',
  area: 'sender',
  title: 'Fee balance (Solana)',
  chain: 'solana',
  result: {
    status: 'warn',
    finding: '0.0021 SOL covers less than the 0.0034 SOL paid in fees in the last 24 hours',
    fix: { step: 'send SOL to 3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe' },
  },
  ranAt: FIRST_RUN,
};
const pinned: SetupCheckRecord = {
  id: 'signer.pinned:base',
  area: 'signer',
  title: 'Pinned (Base)',
  chain: 'base',
  result: {
    status: 'fail',
    finding: 'the executor key is not pinned to its Safe',
    fix: { setting: 'allowedSafe', value: '0x84Ac281B68de095f6227050F56C74d93d294e609' },
  },
  ranAt: FIRST_RUN,
};

const byId = (records: SetupCheckRecord[]) => [...records].sort((a, b) => a.id.localeCompare(b.id));

export function runSetupCheckConformanceSuite(makeStore: () => DispatchStore): void {
  describe('setup checks (#137)', () => {
    it('has nothing before the worker first records a run', async () => {
      const store = makeStore();

      expect(await store.listSetupChecks()).toEqual([]);
    });

    it('reads back every check of a run, with its fix and chain', async () => {
      const store = makeStore();

      await store.recordSetupChecks([reachable, fees, pinned]);

      expect(byId(await store.listSetupChecks())).toEqual(byId([reachable, fees, pinned]));
    });

    it("keeps only the latest run: a check's new result replaces its old one, and a check the run no longer has is dropped", async () => {
      const store = makeStore();
      const recovered: SetupCheckRecord = {
        ...pinned,
        result: { status: 'pass', finding: 'pinned to its Safe' },
        ranAt: SECOND_RUN,
      };

      await store.recordSetupChecks([reachable, fees, pinned]);
      await store.recordSetupChecks([{ ...reachable, ranAt: SECOND_RUN }, recovered]);

      expect(byId(await store.listSetupChecks())).toEqual(
        byId([{ ...reachable, ranAt: SECOND_RUN }, recovered]),
      );
    });

    it('ends in the same state however often the same run is recorded', async () => {
      const store = makeStore();

      await store.recordSetupChecks([reachable, fees]);
      await store.recordSetupChecks([reachable, fees]);

      expect(byId(await store.listSetupChecks())).toEqual(byId([reachable, fees]));
    });
  });
}
