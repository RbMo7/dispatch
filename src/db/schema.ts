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
});

export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id')
    .notNull()
    .references(() => transactions.id),
  broadcastAt: timestamp('broadcast_at', { withTimezone: true }).notNull().defaultNow(),
  error: jsonb('error').$type<DispatchError | null>(),
});

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
