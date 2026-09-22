import { integer, jsonb, pgTable, text, timestamp, uniqueIndex, uuid } from 'drizzle-orm/pg-core';

import type { Call } from '../domain/call.js';
import type { DispatchError } from '../domain/errors.js';

export const dispatches = pgTable(
  'dispatches',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chain: text('chain').notNull(),
    idempotencyKey: text('idempotency_key').notNull(),
    items: jsonb('items').notNull().$type<Call[]>(),
    status: text('status').notNull().default('queued'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [uniqueIndex('dispatches_idempotency_key_idx').on(table.idempotencyKey)],
);

export const transactions = pgTable('transactions', {
  id: uuid('id').primaryKey().defaultRandom(),
  dispatchId: uuid('dispatch_id')
    .notNull()
    .references(() => dispatches.id),
  callIndex: integer('call_index').notNull(),
  chain: text('chain').notNull(),
  signedBytes: text('signed_bytes'),
  hash: text('hash'),
  status: text('status').notNull().default('PENDING'),
  error: jsonb('error').$type<DispatchError | null>(),
});

export const attempts = pgTable('attempts', {
  id: uuid('id').primaryKey().defaultRandom(),
  transactionId: uuid('transaction_id')
    .notNull()
    .references(() => transactions.id),
  broadcastAt: timestamp('broadcast_at', { withTimezone: true }).notNull().defaultNow(),
  error: jsonb('error').$type<DispatchError | null>(),
});
