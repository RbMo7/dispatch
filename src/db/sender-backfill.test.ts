import { randomBytes } from 'node:crypto';
import { cpSync, mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { drizzle } from 'drizzle-orm/postgres-js';
import { migrate } from 'drizzle-orm/postgres-js/migrator';
import postgres from 'postgres';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import pino from 'pino';

import { StubChainHandler } from '../chain-handler/stub-chain-handler.js';
import { FakeApproval } from '../chain-handler/test-support/fake-approval.js';
import { config } from '../config.js';
import { Coordinator } from '../coordinator/coordinator.js';
import type { SenderAddress, SenderRef } from '../domain/sender.js';
import { PostgresDispatchStore } from '../repository/postgres-dispatch-store.js';
import * as schema from './schema.js';

const SENDER_MIGRATION = '0019_sender_address';
const SOLANA: SenderRef = { chain: 'solana', address: 'SolanaSender111' as SenderAddress };
const BASE: SenderRef = { chain: 'base', address: '0xBaseSender' as SenderAddress };

/** The migrations folder as it stood just before named Senders. */
function migrationsBeforeSenders(): string {
  const dir = mkdtempSync(path.join(tmpdir(), 'migrations-'));
  cpSync('drizzle', dir, { recursive: true });
  const journalPath = path.join(dir, 'meta', '_journal.json');
  const journal = JSON.parse(readFileSync(journalPath, 'utf8')) as { entries: { tag: string }[] };
  const at = journal.entries.findIndex((entry) => entry.tag === SENDER_MIGRATION);
  if (at < 0) throw new Error(`${SENDER_MIGRATION} is not in the journal`);
  journal.entries = journal.entries.slice(0, at);
  writeFileSync(journalPath, JSON.stringify(journal));
  return dir;
}

/**
 * ADR-0060: the upgrade path on a database that already holds Dispatches,
 * queued and in flight. The migration only adds the column; the engine
 * assigns each chain's existing rows to its default Sender at startup.
 */
describe('named Senders on a database from before them (Postgres)', () => {
  const name = `dispatch_backfill_${randomBytes(4).toString('hex')}`;
  const admin = postgres(config.databaseUrl, { max: 1, onnotice: () => {} });
  let client: postgres.Sql;
  const seeded: Record<string, string> = {};

  beforeAll(async () => {
    await admin.unsafe(`CREATE DATABASE "${name}"`);
    const url = new URL(config.databaseUrl);
    url.pathname = `/${name}`;
    client = postgres(url.href, { max: 1, onnotice: () => {} });
    await migrate(drizzle(client), { migrationsFolder: migrationsBeforeSenders() });

    // Rows written by the engine before the upgrade: no sender_address column exists yet.
    const item = JSON.stringify([
      { call: { programId: 'p', accounts: [], data: '' }, payment: null },
    ]);
    const [queued] = await client`
      INSERT INTO dispatches (chain, idempotency_key, items) VALUES ('solana', 'old-queued', ${item}::jsonb)
      RETURNING id`;
    const [inFlight] = await client`
      INSERT INTO dispatches (chain, idempotency_key, items, status, claimed_at)
      VALUES ('solana', 'old-in-flight', ${item}::jsonb, 'broadcasting', now()) RETURNING id`;
    const [onBase] = await client`
      INSERT INTO dispatches (chain, idempotency_key, items) VALUES ('base', 'old-base', ${item}::jsonb)
      RETURNING id`;
    await client`
      INSERT INTO transactions (dispatch_id, call_index, chain, signed_bytes, hash, broadcast_at)
      VALUES (${inFlight!.id as string}, 0, 'solana', 'bytes', 'hash-in-flight', now())`;
    seeded.queued = queued!.id as string;
    seeded.inFlight = inFlight!.id as string;
    seeded.onBase = onBase!.id as string;

    await migrate(drizzle(client), { migrationsFolder: 'drizzle' });
  }, 60_000);

  afterAll(async () => {
    await client?.end();
    await admin.unsafe(`DROP DATABASE IF EXISTS "${name}" WITH (FORCE)`);
    await admin.end();
  });

  it('adds sender_address, empty for every existing row, and the claim index', async () => {
    const rows = await client`SELECT id, sender_address FROM dispatches ORDER BY created_at`;
    expect(rows.map((r) => r.sender_address as unknown)).toEqual([null, null, null]);
    const [index] = await client`
      SELECT indexdef FROM pg_indexes WHERE indexname = 'dispatches_chain_sender_status_idx'`;
    expect(index?.indexdef).toContain('(chain, sender_address, status)');
  });

  it("assigns each chain's rows, queued and in flight, to its default Sender, which then claims them", async () => {
    const store = new PostgresDispatchStore(drizzle(client, { schema }));

    expect(await store.assignUnassignedDispatches(SOLANA)).toBe(2);
    expect(await store.assignUnassignedDispatches(BASE)).toBe(1);
    expect(await store.assignUnassignedDispatches(SOLANA)).toBe(0);

    expect(await store.getDispatch(seeded.inFlight!)).toMatchObject({
      status: 'broadcasting',
      senderAddress: SOLANA.address,
    });
    expect((await store.listTransactions(seeded.inFlight!)).map((t) => t.status)).toEqual([
      'PENDING',
    ]);
    expect((await store.getDispatch(seeded.onBase!))?.senderAddress).toBe(BASE.address);

    const claimed = await store.claimQueuedFor(SOLANA, 10);
    expect(claimed.map((d) => d.id)).toEqual([seeded.queued]);
  });
  it("restores a Multisig Sender's unsettled propose bytes at worker start", async () => {
    const store = new PostgresDispatchStore(drizzle(client, { schema }));
    const handler = new StubChainHandler();
    const approval = new FakeApproval<'base'>();
    const restored: string[][] = [];
    Object.assign(handler, {
      approval,
      restoreInFlight: (signed: string[]) => {
        restored.push(signed);
        return Promise.resolve();
      },
    });
    const safe: SenderRef = { chain: 'base', address: '0xSafe' as SenderAddress };
    const coordinator = new Coordinator({
      store,
      chainHandlers: new Map([['base', handler]]),
      senders: [{ ref: safe, handler, isDefault: false }],
      abandonmentTimeoutMs: new Map([['base', 600_000]]),
      logger: pino({ level: 'silent' }),
    });
    await store.createDispatch({
      chain: 'base',
      idempotencyKey: 'multisig-restore',
      items: [{ call: { to: '0xabc', data: '0x', value: '0' }, payment: null }],
      retryPolicy: false,
      senderAddress: safe.address,
    });
    approval.submitImpl = () =>
      Promise.resolve({ ok: false, error: { code: 'RPC_UNAVAILABLE', message: 'down' } });
    await coordinator.processQueuedDispatchesFor(safe, 10);

    // Postgres's timestamptz stops short of JavaScript's latest Date: the open-ended read must still work.
    await coordinator.restoreReservations();

    expect(restored).toEqual([['signed-prop-1']]);
  });
});
