import type { Check } from './check.js';
import { network, rpcReachable } from './checks/chain.js';
import { enabledChains, environmentParses, tokens } from './checks/configuration.js';
import { consoleBuilt } from './checks/console.js';
import { databaseMigrated, databaseReachable } from './checks/database.js';

/** Every setup check, in report order: `doctor` runs the `cli` ones, the worker the `worker` ones. */
export const CHECKS: readonly Check[] = [
  environmentParses,
  tokens,
  enabledChains,
  databaseReachable,
  databaseMigrated,
  rpcReachable,
  network,
  consoleBuilt,
];
