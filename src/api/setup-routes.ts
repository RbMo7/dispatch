import type { FastifyPluginAsync } from 'fastify';

import type { Chain } from '../domain/chain.js';
import type { SetupCheckRecord } from '../repository/dispatch-store.js';
import type { Area, CheckResult } from '../setup/check.js';
import { CHECKS } from '../setup/checks.js';
import { summarize, type Summary } from '../setup/report.js';
import type { CheckOutcome } from '../setup/run.js';
import { checkAuth } from './dispatch-routes.js';

export type SetupCheckView = {
  id: string;
  area: Area;
  title: string;
  chain?: Chain;
  /** The worker's checks are as it last recorded them; the API's run on this request. */
  ranIn: 'worker' | 'api';
  ranAt: string;
} & CheckResult;

export type SetupView = {
  /** `unreadable` when the database did not answer, which the API's own database check then reports. */
  worker: { status: 'not_run_yet' } | { status: 'ran'; ranAt: string } | { status: 'unreadable' };
  summary: Summary;
  checks: SetupCheckView[];
};

export type SetupReads = {
  /** A recorded check for a chain the engine no longer enables is left out. */
  enabledChains: readonly Chain[];
  listRecorded: () => Promise<SetupCheckRecord[]>;
  runApiChecks: () => Promise<CheckOutcome[]>;
  now: () => Date;
};

const REGISTRY_ORDER = new Map(CHECKS.map((check, index) => [check.id, index]));

/** `GET /v1/setup` (#137): the worker's latest recorded run, plus the API's own checks run now. */
export function setupReader(reads: SetupReads): () => Promise<SetupView> {
  return async () => {
    const [recorded, apiOutcomes] = await Promise.all([
      reads.listRecorded().catch(() => undefined),
      reads.runApiChecks(),
    ]);
    const ranAt = reads.now();
    const fromWorker = (recorded ?? []).filter(
      ({ chain }) => chain === undefined || reads.enabledChains.includes(chain),
    );
    const checks: (CheckOutcome & { ranIn: SetupCheckView['ranIn']; ranAt: Date })[] = [
      ...fromWorker.map((record) => ({ ...record, ranIn: 'worker' as const })),
      ...apiOutcomes.map((outcome) => ({ ...outcome, ranIn: 'api' as const, ranAt })),
    ].sort((a, b) => compare(a, b, reads.enabledChains));
    const lastRun = recorded?.[0]?.ranAt;

    return {
      worker:
        recorded === undefined
          ? { status: 'unreadable' }
          : lastRun === undefined
            ? { status: 'not_run_yet' }
            : { status: 'ran', ranAt: lastRun.toISOString() },
      summary: summarize(checks),
      checks: checks.map(({ id, area, title, chain, ranIn, ranAt, result }) => ({
        id,
        area,
        title,
        ...(chain ? { chain } : {}),
        ranIn,
        ranAt: ranAt.toISOString(),
        ...result,
      })),
    };
  };
}

/** Report order: the registry's, then the enabled chains' own order, as `doctor` prints them. */
function compare(a: CheckOutcome, b: CheckOutcome, enabledChains: readonly Chain[]): number {
  const position = ({ id }: CheckOutcome) => REGISTRY_ORDER.get(id.split(':')[0]!) ?? CHECKS.length;
  const chain = ({ chain }: CheckOutcome) => (chain ? enabledChains.indexOf(chain) : -1);
  return position(a) - position(b) || chain(a) - chain(b);
}

export type SetupRouteDeps = {
  authToken: string;
  readSetup: () => Promise<SetupView>;
};

export const registerSetupRoutes: FastifyPluginAsync<SetupRouteDeps> = (app, deps) => {
  app.get('/v1/setup', { onRequest: checkAuth(deps.authToken) }, () => deps.readSetup());
  return Promise.resolve();
};
