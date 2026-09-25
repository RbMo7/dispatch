import {
  boolean,
  integer,
  jsonb,
  pgTable,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { DispatchItem } from '../domain/call.js';
import type { BulkCall } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';

export const dispatches = pgTable(
  'dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chain: text('chain').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    items: jsonb('items').notNull().$type<DispatchItem[]>(),
    status: text('status').notNull().default('queued'),
    retryPolicy: boolean('retry_policy').notNull().default(false),
    /** #11 (ADR-0038): the Bulk Call opt-in, null for the default mode. */
    bulkCall: jsonb('bulk_call').$type<BulkCall | null>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('dispatches_idempotency_key_idx').on(table.idempotencyKey)],
);

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  /**
   * Deliberately NOT a foreign key: this points at either `dispatches.id`
   * (a Managed Dispatch's Call) or `relay_dispatches.id` (ADR-0031's
   * RelayDispatch, always exactly one Transaction) — a single-table FK
   * can't express "one of two tables." This is the intentional
   * replacement for that referential-integrity check, not a gap left
   * open: `Coordinator.maybeAbandon` already resolves which owner a
   * Transaction belongs to (tries getDispatch, falls back to
   * getRelayDispatch, throws if neither matches — a genuinely orphaned
   * row still surfaces loudly). Nothing in this repo ever deletes a
   * Dispatch/RelayDispatch row, so there's no live risk the dropped FK's
   * old ON DELETE behavior was actually guarding against.
   */
  dispatchId: uuid('dispatch_id').notNull(),
  callIndex: integer('call_index').notNull(),
  chain: text('chain').notNull(),
  signedBytes: text('signed_bytes'),
  hash: text('hash'),
  status: text('status').notNull().default('PENDING'),
  error: jsonb('error').$type<DispatchError | null>(),
  broadcastAt: timestamp('broadcast_at', { withTimezone: true }),
  /** issue 10: when this Transaction was marked ABANDONED — what the low-frequency re-watch's bounded window measures elapsed time against. */
  abandonedAt: timestamp('abandoned_at', { withTimezone: true }),
  /** base-chain-handler issue 07: when this Transaction was last marked CONFIRMED — what the reorg safety net's bounded re-check window measures elapsed time against. */
  confirmedAt: timestamp('confirmed_at', { withTimezone: true }),
  /** #21: when the pending poll last picked this row up — what listPendingTransactions rotates on. */
  lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
  /** #9: when these exact signed bytes were last sent — what the stuck timer measures against. */
  lastBroadcastAt: timestamp('last_broadcast_at', { withTimezone: true }),
  /** #9: the fee-bumped predecessor this row replaced (same Call, same nonce). */
  replacesTransactionId: uuid('replaces_transaction_id'),
  /** #9: fee-bump attempts made for this Call so far, failed ones included. */
  feeBumpAttempts: integer('fee_bump_attempts').notNull().default(0),
});

export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id')
    .notNull()
    .references(() => transactions.id),
  broadcastAt: timestamp('broadcast_at', { withTimezone: true }).notNull().defaultNow(),
  error: jsonb('error').$type<DispatchError | null>(),
});

/**
 * base-chain-handler issue 02: a persisted per-(chain, Sender) nonce->hash
 * history, populated on every successful broadcast (issue 03) but consumed
 * by no logic yet — groundwork for the deferred EVM analogue of ADR-0030
 * (a future issue proving a lower-nonce transaction dead once a
 * higher-nonce one from the same Sender confirms), which needs this
 * history to survive a process restart. `(chain, sender_address, nonce)`
 * is unique: a nonce is only ever assigned once per Sender, even across a
 * fee-bump replacement (CONTEXT.md's Attempt-vs-Transaction split — a
 * fee-bump is a new Transaction, but never a new nonce), so only the
 * account's own next-nonce counter (issue 02) ever appends new rows.
 */
export const nonceHistory = pgTable(
  'nonce_history',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chain: text('chain').notNull(),
    senderAddress: text('sender_address').notNull(),
    nonce: integer('nonce').notNull(),
    hash: text('hash').notNull(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [
    uniqueIndex('nonce_history_chain_sender_nonce_idx').on(
      table.chain,
      table.senderAddress,
      table.nonce,
    ),
  ],
);

/** ADR-0031: Relay Dispatch's own table — never squeezed into `dispatches`, which has no meaningful `items`/`retryPolicy` for this shape. */
export const relayDispatches = pgTable(
  'relay_dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chain: text('chain').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    signedTransaction: text('signed_transaction').notNull(),
    status: text('status').notNull().default('queued'),
    transactionId: uuid('transaction_id').references(() => transactions.id),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('relay_dispatches_idempotency_key_idx').on(table.idempotencyKey)],
);
