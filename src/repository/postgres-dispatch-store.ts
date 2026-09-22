import { eq, sql } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { attempts, dispatches, transactions } from '../db/schema.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch, DispatchStatus } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { Transaction, TransactionStatus } from '../domain/transaction.js';
import type {
  DispatchStore,
  NewDispatchInput,
  NewFailedCallInput,
  NewTransactionInput,
} from './dispatch-store.js';

type DispatchRow = typeof dispatches.$inferSelect;
type TransactionRow = typeof transactions.$inferSelect;

function toDispatch(row: DispatchRow): Dispatch {
  return {
    id: row.id,
    chain: row.chain as Chain,
    idempotencyKey: row.idempotencyKey,
    items: row.items,
    status: row.status as DispatchStatus,
    retryPolicy: row.retryPolicy,
  };
}

function toTransaction(row: TransactionRow): Transaction {
  return {
    id: row.id,
    dispatchId: row.dispatchId,
    callIndex: row.callIndex,
    chain: row.chain as Chain,
    hash: row.hash,
    signedBytes: row.signedBytes,
    status: row.status as TransactionStatus,
    error: row.error ?? null,
    broadcastAt: row.broadcastAt,
  };
}

/**
 * The real persistence behind DispatchStore (ADR-0008/ADR-0011) — plain
 * constructor injection (ADR-0014), never creates its own connection.
 */
export class PostgresDispatchStore implements DispatchStore {
  constructor(private readonly db: Database) {}

  async createDispatch<C extends Chain>(input: NewDispatchInput<C>): Promise<Dispatch<C>> {
    const inserted = await this.db
      .insert(dispatches)
      .values({
        chain: input.chain,
        idempotencyKey: input.idempotencyKey,
        items: input.items,
        retryPolicy: input.retryPolicy,
      })
      .onConflictDoNothing({ target: dispatches.idempotencyKey })
      .returning();

    const row =
      inserted[0] ??
      (await this.db.query.dispatches.findFirst({
        where: eq(dispatches.idempotencyKey, input.idempotencyKey),
      }));

    if (!row) {
      throw new Error(
        `Failed to create or find Dispatch for idempotencyKey ${input.idempotencyKey}`,
      );
    }

    return toDispatch(row) as Dispatch<C>;
  }

  async getDispatch(id: string): Promise<Dispatch | null> {
    const row = await this.db.query.dispatches.findFirst({ where: eq(dispatches.id, id) });
    return row ? toDispatch(row) : null;
  }

  async listTransactions(dispatchId: string): Promise<Transaction[]> {
    const rows = await this.db.query.transactions.findMany({
      where: eq(transactions.dispatchId, dispatchId),
      orderBy: transactions.callIndex,
    });
    return rows.map(toTransaction);
  }

  async claimQueued(limit: number): Promise<Dispatch[]> {
    // Concurrency-safe outbox claim: lock and skip rows another worker is
    // already claiming, per ADR-0009's shared-outbox pattern.
    const rows = await this.db.execute<DispatchRow>(sql`
      UPDATE ${dispatches}
      SET status = 'broadcasting'
      WHERE id IN (
        SELECT id FROM ${dispatches}
        WHERE status = 'queued'
        ORDER BY created_at
        LIMIT ${limit}
        FOR UPDATE SKIP LOCKED
      )
      RETURNING *
    `);

    return [...rows].map(toDispatch);
  }

  async listPendingTransactions(limit: number): Promise<Transaction[]> {
    const rows = await this.db.query.transactions.findMany({
      where: eq(transactions.status, 'PENDING'),
      orderBy: transactions.broadcastAt,
      limit,
    });
    return rows.map(toTransaction);
  }

  async createTransaction(input: NewTransactionInput): Promise<Transaction> {
    const [row] = await this.db
      .insert(transactions)
      .values({
        dispatchId: input.dispatchId,
        callIndex: input.callIndex,
        chain: input.chain,
        signedBytes: input.signedBytes,
        hash: input.hash,
        broadcastAt: new Date(),
      })
      .returning();

    if (!row) {
      throw new Error('Failed to create Transaction');
    }

    return toTransaction(row);
  }

  async recordCallFailure(input: NewFailedCallInput): Promise<Transaction> {
    const [row] = await this.db
      .insert(transactions)
      .values({
        dispatchId: input.dispatchId,
        callIndex: input.callIndex,
        chain: input.chain,
        status: 'FAILED',
        error: input.error,
      })
      .returning();

    if (!row) {
      throw new Error('Failed to record Call failure');
    }

    return toTransaction(row);
  }

  async recordBroadcast(transactionId: string, hash: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const row = await tx.query.transactions.findFirst({
        where: eq(transactions.id, transactionId),
      });
      if (!row) {
        throw new Error(`Unknown transaction: ${transactionId}`);
      }
      if (row.hash !== hash) {
        throw new Error(
          `recordBroadcast hash mismatch for ${transactionId}: a re-broadcast must be of the ` +
            `Transaction's exact signed bytes (CONTEXT.md), so its hash can't change. Changed ` +
            `bytes are a new Transaction, not a new Attempt of this one.`,
        );
      }
      await tx.insert(attempts).values({ transactionId });
    });
  }

  async markAbandoned(transactionId: string): Promise<void> {
    await this.db
      .update(transactions)
      .set({ status: 'ABANDONED' })
      .where(eq(transactions.id, transactionId));
  }

  async markFailed(transactionId: string, error: DispatchError): Promise<void> {
    await this.db
      .update(transactions)
      .set({ status: 'FAILED', error })
      .where(eq(transactions.id, transactionId));
  }

  async markConfirmed(transactionId: string): Promise<void> {
    await this.db
      .update(transactions)
      .set({ status: 'CONFIRMED' })
      .where(eq(transactions.id, transactionId));
  }
}
