import { existsSync } from 'node:fs';

import { configFrom, type Env } from '../config.js';
import { ENGINE_WEB_ROOT } from '../web-static.js';
import type { CheckContext, DatabaseReads } from './check.js';
import { CHECKS } from './checks.js';
import { planChecks, runPlanned, type CheckOutcome } from './run.js';
import { readSettings } from './settings.js';

function notInTheApi(): never {
  throw new Error('the API process does not make this read');
}

/**
 * The API process's own checks, run on each `GET /v1/setup`. Its context has
 * no Signer (ADR-0059) and makes no chain read: those checks are the worker's.
 */
export function apiSetupChecks(
  env: Env,
  database: DatabaseReads,
  { consoleBuilt = () => existsSync(ENGINE_WEB_ROOT) }: { consoleBuilt?: () => boolean } = {},
): () => Promise<CheckOutcome[]> {
  const config = configFrom(env);
  const context: CheckContext = {
    env,
    config,
    settings: readSettings(config),
    database,
    chain: notInTheApi,
    multisigStartup: notInTheApi,
    apiEnvironment: notInTheApi,
    consoleBuilt,
    now: () => new Date(),
  };
  return () => runPlanned(planChecks(CHECKS, context, { place: 'api' }));
}
