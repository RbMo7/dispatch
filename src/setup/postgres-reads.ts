import { readFileSync } from 'node:fs';

import { and, count, desc, eq, gte, isNotNull, max, min } from 'drizzle-orm';
import { drizzle } from 'drizzle-orm/postgres-js';
import postgres from 'postgres';

import { dispatches, knownAssets, senderForeignNonces, transactions } from '../db/schema.js';
import type { Chain } from '../domain/chain.js';
import type { KnownAsset } from '../domain/known-asset.js';
import type { DatabaseReads } from './check.js';

const JOURNAL_URL = new URL('../../drizzle/meta/_journal.json', import.meta.url);

/** How many of the latest Transactions the fee check reads a fee for. */
export const FEE_SAMPLE_SIZE = 20;

type Journal = { entries: { when: number; tag: string }[] };

/** Postgres's codes for a missing relation or schema: a database `drizzle-kit migrate` never ran on. */
const NEVER_MIGRATED = new Set(['42P01', '3F000']);

/**
 * The database reads the setup checks make, on a connection of their own so a
 * check can bound how long it waits. `close` ends it.
 */
export function postgresReads(
  url: string,
  timeoutMs: number,
): DatabaseReads & { close(): Promise<void> } {
  const client = postgres(url, {
    max: 2,
    connect_timeout: Math.max(1, Math.ceil(timeoutMs / 1000)),
    onnotice: () => {},
  });
  const db = drizzle(client);

  return {
    ping: async () => {
      await client`select 1`;
    },
    pendingMigrations: async () => {
      const journal = JSON.parse(readFileSync(JOURNAL_URL, 'utf8')) as Journal;
      const last = await lastAppliedMigration(client);
      // drizzle's migrator applies every migration newer than the last one it recorded, so this is what it would apply.
      return journal.entries
        .filter((entry) => last === undefined || entry.when > last)
        .map((entry) => entry.tag);
    },
    recentTransactions: (chain: Chain, since: Date) =>
      unwrapQueryError(async () => {
        // A Managed Dispatch's Transactions only: a Relay Dispatch's fee is paid by whoever signed it.
        const sent = and(
          eq(transactions.chain, chain),
          isNotNull(transactions.hash),
          gte(transactions.broadcastAt, since),
        );
        const [counted] = await db
          .select({ count: count() })
          .from(transactions)
          .innerJoin(dispatches, eq(dispatches.id, transactions.dispatchId))
          .where(sent);
        const latest = await db
          .select({ hash: transactions.hash })
          .from(transactions)
          .innerJoin(dispatches, eq(dispatches.id, transactions.dispatchId))
          .where(sent)
          .orderBy(desc(transactions.broadcastAt))
          .limit(FEE_SAMPLE_SIZE);
        return {
          count: counted?.count ?? 0,
          latestHashes: latest.flatMap(({ hash }) => (hash === null ? [] : [hash])),
        };
      }),
    knownAssets: () =>
      unwrapQueryError(async () => (await db.select().from(knownAssets)) as KnownAsset[]),
    foreignActivity: (chain, senderAddress, since) =>
      unwrapQueryError(async () => {
        const [row] = await db
          .select({
            lastSeenAt: max(senderForeignNonces.firstSeenAt),
            first: min(senderForeignNonces.nonce),
            last: max(senderForeignNonces.nonce),
            count: count(),
          })
          .from(senderForeignNonces)
          .where(
            and(
              eq(senderForeignNonces.chain, chain),
              eq(senderForeignNonces.senderAddress, senderAddress),
              gte(senderForeignNonces.firstSeenAt, since),
            ),
          );
        if (!row?.lastSeenAt || row.first === null || row.last === null) return null;
        return { lastSeenAt: row.lastSeenAt, nonces: [row.first, row.last], count: row.count };
      }),
    close: () => client.end({ timeout: 1 }),
  };
}

/** drizzle's error leads with the SQL it sent; the Postgres error it wraps says what went wrong. */
async function unwrapQueryError<T>(query: () => Promise<T>): Promise<T> {
  try {
    return await query();
  } catch (cause) {
    throw cause instanceof Error && cause.cause instanceof Error ? cause.cause : cause;
  }
}

async function lastAppliedMigration(client: postgres.Sql): Promise<number | undefined> {
  try {
    const [row] = await client<{ last: string | null }[]>`
      select max(created_at)::text as last from drizzle.__drizzle_migrations`;
    return row?.last == null ? undefined : Number(row.last);
  } catch (cause) {
    if (cause instanceof postgres.PostgresError && NEVER_MIGRATED.has(cause.code)) return undefined;
    throw cause;
  }
}
