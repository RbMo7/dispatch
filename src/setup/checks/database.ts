import { fail, pass, warn, type Check, type Fix } from '../check.js';
import { errorText, hostOf, notCheckedFinding } from '../wording.js';
import { plural } from './configuration.js';

const MIGRATE: Fix = { command: 'pnpm db:migrate' };

function databaseName(url: string): string {
  try {
    const { pathname } = new URL(url);
    return `${hostOf(url)}${pathname}`;
  } catch {
    return hostOf(url);
  }
}

/** A refused connection means no Postgres is running there; anything else is the URL or its credentials. */
function connectionFix(cause: unknown): Fix {
  return /ECONNREFUSED/.test(errorText(cause))
    ? { command: 'docker compose up -d postgres' }
    : { setting: 'DATABASE_URL', value: 'the URL of a Postgres the engine can sign in to' };
}

export const databaseReachable: Check = {
  id: 'database.reachable',
  area: 'database',
  title: 'Reachable',
  // The worker records its results in this database, so it could never record this failing; the API checks it on every read.
  runsIn: ['cli', 'api'],
  scope: 'engine',
  run: async ({ config, database }) => {
    const where = databaseName(config.databaseUrl);
    try {
      await database.ping();
      return pass(`answered at ${where}`);
    } catch (cause) {
      return fail(
        `could not reach the database at ${where} (DATABASE_URL): ${errorText(cause)}`,
        connectionFix(cause),
      );
    }
  },
};

export const databaseMigrated: Check = {
  id: 'database.migrated',
  area: 'database',
  title: 'Migrated',
  runsIn: ['cli', 'api'],
  scope: 'engine',
  run: async ({ database }) => {
    let pending: string[];
    try {
      pending = await database.pendingMigrations();
    } catch (cause) {
      return warn(
        notCheckedFinding(`the database did not answer: ${errorText(cause)}`),
        connectionFix(cause),
      );
    }
    if (pending.length === 0) return pass('every migration is applied');
    const named =
      pending.length <= 3 ? pending.join(', ') : `${pending[0]} to ${pending[pending.length - 1]}`;
    return fail(`${plural(pending.length, 'migration')} not applied: ${named}`, MIGRATE);
  },
};
