import { randomBytes, randomUUID } from 'node:crypto';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { config } from '../config.js';
import { dispatches, proposals, senderForeignNonces, transactions } from '../db/schema.js';
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

  it("counts only one Sender's Managed Dispatch Transactions on a chain since a time, latest first (#159)", async () => {
    const PAYOUTS = 'PayoutsSender1111111111111111111111111111111';
    const REFUNDS = 'RefundsSender1111111111111111111111111111111';
    const client = postgres(database.url, { max: 1, onnotice: () => {} });
    const db = drizzle(client);
    const dispatchFor = async (senderAddress: string | null) => {
      const [row] = await db
        .insert(dispatches)
        .values({ chain: 'solana', idempotencyKey: randomUUID(), items: [], senderAddress })
        .returning({ id: dispatches.id });
      return row!.id;
    };
    const payouts = await dispatchFor(PAYOUTS);
    const refunds = await dispatchFor(REFUNDS);
    const unnamed = await dispatchFor(null);
    const sent = (id: string, hash: string | null, broadcastAt: string, chain = 'solana') =>
      ({ dispatchId: id, callIndex: 0, chain, hash, broadcastAt: new Date(broadcastAt) }) as const;
    await db
      .insert(transactions)
      .values([
        sent(payouts, 'older', '2026-11-01T10:00:00Z'),
        sent(payouts, 'newer', '2026-11-01T11:00:00Z'),
        sent(payouts, 'before the window', '2026-10-30T00:00:00Z'),
        sent(payouts, null, '2026-11-01T11:30:00Z'),
        sent(payouts, 'on base', '2026-11-01T11:00:00Z', 'base'),
        sent(randomUUID(), 'a relay dispatch', '2026-11-01T11:00:00Z'),
        sent(refunds, 'a refund', '2026-11-01T10:30:00Z'),
        sent(unnamed, 'stored without a Sender', '2026-11-01T09:00:00Z'),
      ]);
    await client.end();
    const since = new Date('2026-10-31T12:00:00Z');

    expect(
      await reads.recentTransactions('solana', { address: PAYOUTS, isDefault: false }, since),
    ).toEqual({ count: 2, latestHashes: ['newer', 'older'] });
    expect(
      await reads.recentTransactions('solana', { address: REFUNDS, isDefault: false }, since),
    ).toEqual({ count: 1, latestHashes: ['a refund'] });
    // The default Sender takes over a Dispatch stored without one (ADR-0060).
    expect(
      await reads.recentTransactions('solana', { address: PAYOUTS, isDefault: true }, since),
    ).toEqual({ count: 3, latestHashes: ['newer', 'older', 'stored without a Sender'] });
  });

  it("adds a Multisig Sender's Proposal posts to its executed Transactions (#159)", async () => {
    const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
    const OTHER_SAFE = '0x0000000000000000000000000000000000000002';
    const client = postgres(database.url, { max: 1, onnotice: () => {} });
    const db = drizzle(client);
    const [dispatch] = await db
      .insert(dispatches)
      .values({ chain: 'base', idempotencyKey: randomUUID(), items: [], senderAddress: SAFE })
      .returning({ id: dispatches.id });
    const proposal = (senderAddress: string, proposeHash: string | null, createdAt: string) => ({
      dispatchId: dispatch!.id,
      chain: 'base',
      senderAddress,
      chainRef: {} as never,
      payload: '',
      proposalRef: randomUUID(),
      threshold: 2,
      deadlineAt: new Date('2026-11-08T00:00:00Z'),
      expected: {} as never,
      committed: {} as never,
      proposeHash,
      createdAt: new Date(createdAt),
    });
    await db
      .insert(proposals)
      .values([
        proposal(SAFE, '0xproposed', '2026-11-01T10:00:00Z'),
        proposal(SAFE, null, '2026-11-01T10:10:00Z'),
        proposal(SAFE, '0xproposed long ago', '2026-10-30T00:00:00Z'),
        proposal(OTHER_SAFE, '0xanother Safe', '2026-11-01T10:20:00Z'),
      ]);
    await db.insert(transactions).values({
      dispatchId: dispatch!.id,
      callIndex: 0,
      chain: 'base',
      hash: '0xexecuted',
      broadcastAt: new Date('2026-11-01T12:00:00Z'),
    });
    await client.end();

    expect(
      await reads.recentTransactions(
        'base',
        { address: SAFE, isDefault: false },
        new Date('2026-10-31T12:00:00Z'),
      ),
    ).toEqual({ count: 2, latestHashes: ['0xexecuted', '0xproposed'] });
  });

  it('reads the nonces the worker recorded another sender using, in a window (ADR-0064)', async () => {
    const sender = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A';
    const client = postgres(database.url, { max: 1, onnotice: () => {} });
    const seen = (nonce: number, at: string, senderAddress = sender) =>
      ({ chain: 'base', senderAddress, nonce, firstSeenAt: new Date(at) }) as const;
    await drizzle(client)
      .insert(senderForeignNonces)
      .values([
        seen(3, '2026-10-30T00:00:00Z'),
        seen(7, '2026-11-01T10:00:00Z'),
        seen(9, '2026-11-01T11:00:00Z'),
        seen(8, '2026-11-01T11:00:00Z', '0x0000000000000000000000000000000000000001'),
      ]);
    await client.end();

    expect(await reads.foreignActivity('base', sender, new Date('2026-10-31T12:00:00Z'))).toEqual({
      lastSeenAt: new Date('2026-11-01T11:00:00Z'),
      nonces: [7, 9],
      count: 2,
    });
    expect(
      await reads.foreignActivity('base', sender, new Date('2026-11-02T00:00:00Z')),
    ).toBeNull();
  });
});
