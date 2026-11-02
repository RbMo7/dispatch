import {
  runSafeStartupChecks,
  SafeStartupError,
  type SafeStartupDeps,
} from '../chain-handler/base/safe/startup-checks.js';
import {
  MultisigStartupError,
  runMultisigStartupChecks,
  type MultisigStartupDeps,
} from '../chain-handler/solana/multisig/startup-checks.js';
import type { MultisigStartup } from './check.js';

/** The worker's Squads startup checks, unchanged; what would stop the worker comes back as data. */
export async function squadsStartup(deps: MultisigStartupDeps): Promise<MultisigStartup> {
  try {
    return { failures: [], ...(await runMultisigStartupChecks(deps)) };
  } catch (cause) {
    if (cause instanceof MultisigStartupError) return { failures: cause.failures, warnings: [] };
    throw cause;
  }
}

/** The worker's Safe startup checks, unchanged; what would stop the worker comes back as data. */
export async function safeStartup(deps: SafeStartupDeps): Promise<MultisigStartup> {
  try {
    return { failures: [], ...(await runSafeStartupChecks(deps)) };
  } catch (cause) {
    if (cause instanceof SafeStartupError) return { failures: cause.failures, warnings: [] };
    throw cause;
  }
}
