import type { Chain } from '../domain/chain.js';
import {
  fail,
  type Area,
  type Check,
  type CheckContext,
  type CheckResult,
  type Place,
} from './check.js';
import { CHAIN_NAMES, errorText } from './wording.js';

export const DEFAULT_CHECK_TIMEOUT_MS = 10_000;

/** One check as it will run: an engine check once, a chain check once per chain it applies to. */
export type PlannedCheck = {
  id: string;
  area: Area;
  title: string;
  chain?: Chain;
  run: () => Promise<CheckResult>;
};

export type CheckOutcome = Omit<PlannedCheck, 'run'> & { result: CheckResult };

export function planChecks(
  checks: readonly Check[],
  context: CheckContext,
  { place, only }: { place: Place; only?: Area },
): PlannedCheck[] {
  return checks
    .filter((check) => check.runsIn.includes(place) && (only === undefined || check.area === only))
    .flatMap((check): PlannedCheck[] => {
      const header = { id: check.id, area: check.area, title: check.title };
      if (check.scope === 'engine') {
        return [{ ...header, run: async () => check.run(context) }];
      }
      return context.settings.chains
        .filter((setup) => check.appliesTo(setup))
        .map((setup) => ({
          ...header,
          id: `${check.id}:${setup.chain}`,
          title: `${check.title} (${CHAIN_NAMES[setup.chain]})`,
          chain: setup.chain,
          run: async () => check.run(context, setup),
        }));
    });
}

const RERUN =
  'check that what it reads (the database, an RPC or the Signer) answers, then run it again';

/**
 * Runs every planned check at once. Each is bounded by `timeoutMs`, so the
 * whole run is too, and a check that throws or hangs fails on its own
 * without stopping the rest. Outcomes come back in plan order.
 */
export async function runPlanned(
  planned: readonly PlannedCheck[],
  {
    timeoutMs = DEFAULT_CHECK_TIMEOUT_MS,
    onSettled,
  }: { timeoutMs?: number; onSettled?: (outcome: CheckOutcome) => void } = {},
): Promise<CheckOutcome[]> {
  return Promise.all(
    planned.map(async ({ run, ...header }) => {
      const result = await withTimeout(run, timeoutMs);
      const outcome = { ...header, result };
      onSettled?.(outcome);
      return outcome;
    }),
  );
}

async function withTimeout(
  run: () => Promise<CheckResult>,
  timeoutMs: number,
): Promise<CheckResult> {
  let timer: NodeJS.Timeout | undefined;
  const timeout = new Promise<CheckResult>((resolve) => {
    timer = setTimeout(
      () => resolve(fail(`did not finish within ${timeoutMs / 1000}s`, { step: RERUN })),
      timeoutMs,
    );
  });
  try {
    return await Promise.race([
      run().catch((cause: unknown) =>
        fail(`the check itself failed: ${errorText(cause)}`, { step: RERUN }),
      ),
      timeout,
    ]);
  } finally {
    clearTimeout(timer);
  }
}
