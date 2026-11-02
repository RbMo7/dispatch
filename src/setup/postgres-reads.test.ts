import { randomBytes, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../config.js';
import { dispatches, transactions } from '../db/schema.js';
import { postgresReads } from './postgres-reads.js';

/** A database of this file's own, so no other Postgres-tier file's truncation races these rows. */
async function createDatabase(migrated: boolean): Promise<{ url: string; drop(): Promise<void> }> {
  const name = `dispatch_setup_${randomBytes(4).toString('hex')}`;
  const admin = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  await admin.unsafe(`CREATE DATABASE "${name}"`);
  const url = new URL(config.databaseUrl);
  url.pathname = `/${name}`;
  if (migrated) {
    const client = postgres(url.href, { max: 1, onnotice: () => {} });
    await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
    await client.end();
  }
  return {
    url: url.href,
    drop: async () => {
      await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
      await admin.end();
    },
  };
}

describe('postgresReads (real Postgres)', () => {
  let database: Awaited<ReturnType<typeof createDatabase>>;
  let reads: ReturnType<typeof postgresReads>;

  beforeAll(async () => {
    database = await createDatabase(true);
    reads = postgresReads(database.url, 5_000);
  });

  afterAll(async () => {
    await reads.close();
    await database.drop();
  });

  it('reaches the database and finds every migration applied', async () => {
    await expect(reads.ping()).resolves.toBeUndefined();
    expect(await reads.pendingMigrations()).toEqual([]);
  });

  it('finds every migration pending in a database never migrated', async () => {
    const fresh = await createDatabase(false);
    const freshReads = postgresReads(fresh.url, 5_000);
    try {
      const pending = await freshReads.pendingMigrations();

      expect(pending[0]).toBe('0000_windy_sleepwalker');
      expect(pending).toContain('0018_signer_keys');
    } finally {
      await freshReads.close();
      await fresh.drop();
    }
  });

  it('counts the Managed Dispatch Transactions sent on a chain since a time, latest first', async () => {
    const client = postgres(database.url, { max: 1, onnotice: () => {} });
    const db = drizzle(client);
    const [dispatch] = await db
      .insert(dispatches)
      .values({ chain: 'solana', idempotencyKey: randomUUID(), items: [] })
      .returning({ id: dispatches.id });
    const sent = (hash: string | null, broadcastAt: string, chain = 'solana', id = dispatch!.id) =>
      ({ dispatchId: id, callIndex: 0, chain, hash, broadcastAt: new Date(broadcastAt) }) as const;
    await db
      .insert(transactions)
      .values([
        sent('older', '2026-11-01T10:00:00Z'),
        sent('newer', '2026-11-01T11:00:00Z'),
        sent('before the window', '2026-10-30T00:00:00Z'),
        sent(null, '2026-11-01T11:30:00Z'),
        sent('on base', '2026-11-01T11:00:00Z', 'base'),
        sent('a relay dispatch', '2026-11-01T11:00:00Z', 'solana', randomUUID()),
      ]);
    await client.end();

    expect(await reads.recentTransactions('solana', new Date('2026-10-31T12:00:00Z'))).toEqual({
      count: 2,
      latestHashes: ['newer', 'older'],
    });
  });
});
