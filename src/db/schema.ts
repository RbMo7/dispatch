import { sql } from 'drizzle-orm';
import {
  type AnyPgColumn,
  bigint,
  boolean,
  check,
  index,
  integer,
  jsonb,
  pgTable,
  primaryKey,
  text,
  timestamp,
  uniqueIndex,
  uuid,
} from 'drizzle-orm/pg-core';

import type { DispatchItem } from '../domain/call.js';
import type { BulkCall } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { FlagRuleDefinitionJson } from '../domain/flag-rule.js';
import type {
  Approver,
  ChainProposalRef,
  CommittedAmounts,
  ExpectedTotals,
} from '../domain/proposal.js';
import type { Fix } from '../setup/check.js';
import type { SignerPins } from '../signer/client.js';

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
    /** #20 (ADR-0041): when a worker last claimed this row — a claim still `broadcasting` long after is reclaimed. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** ADR-0056: when an operator cancelled it, before any claim. */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    /**
     * ADR-0060: the Sender that pays, its identity. Null only for a row stored
     * without one (from before named Senders, or a caller that named none): its
     * chain's default Sender takes it over, at startup and before each claim.
     */
    senderAddress: text('sender_address'),
  },
  (table) => [
    uniqueIndex('dispatches_idempotency_key_idx').on(table.idempotencyKey),
    index('dispatches_created_at_id_idx').on(table.createdAt, table.id),
    index('dispatches_chain_sender_status_idx').on(table.chain, table.senderAddress, table.status),
  ],
);

export const transactions = pgTable(
  'transactions',
  {
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
    /** #109: when this Transaction was marked FAILED — what the timeline reports it at. */
    failedAt: timestamp('failed_at', { withTimezone: true }),
    /** #21: when the pending poll last picked this row up — what listPendingTransactions rotates on. */
    lastCheckedAt: timestamp('last_checked_at', { withTimezone: true }),
    /** #9: when these exact signed bytes were last sent — what the stuck timer measures against. */
    lastBroadcastAt: timestamp('last_broadcast_at', { withTimezone: true }),
    /** #9: the fee-bumped predecessor this row replaced (same Call, same nonce). */
    replacesTransactionId: uuid('replaces_transaction_id'),
    /** #9: fee-bump attempts made for this Call so far, failed ones included. */
    feeBumpAttempts: integer('fee_bump_attempts').notNull().default(0),
    /** ADR-0054: the Proposal a multisig Call belongs to — null for every other Transaction. */
    proposalId: uuid('proposal_id').references((): AnyPgColumn => proposals.id),
    /** ADR-0054: this Call's position inside its Proposal. */
    proposalPosition: integer('proposal_position'),
  },
  (table) => [
    index('transactions_dispatch_id_call_index_idx').on(table.dispatchId, table.callIndex),
  ],
);

/**
 * ADR-0054: one multisig transaction proposed for Approvers to decide on,
 * written down (phase `noted`) before it is sent (ADR-0041). Holds Calls from
 * exactly one Dispatch, hence the foreign key to `dispatches`.
 */
export const proposals = pgTable(
  'proposals',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    dispatchId: uuid('dispatch_id')
      .notNull()
      .references(() => dispatches.id),
    chain: text('chain').notNull(),
    /** The multisig that is the Sender (the Squads vault or the Safe). */
    senderAddress: text('sender_address').notNull(),
    chainRef: jsonb('chain_ref').notNull().$type<ChainProposalRef>(),
    /** Opaque, Chain Handler-owned: enough to re-sign, re-post or execute. */
    payload: text('payload').notNull(),
    /** The proposal PDA or `safeTxHash` — unique, so a re-post is idempotent. */
    proposalRef: text('proposal_ref').notNull(),
    /** Squads transactionIndex, Safe nonce. */
    sequence: bigint('sequence', { mode: 'number' }),
    phase: text('phase').notNull().default('noted'),
    approvalState: text('approval_state').notNull().default('awaiting'),
    approvals: integer('approvals').notNull().default(0),
    threshold: integer('threshold').notNull(),
    approvers: jsonb('approvers').notNull().default([]).$type<Approver[]>(),
    deadlineAt: timestamp('deadline_at', { withTimezone: true }).notNull(),
    /** The multisig's time lock. */
    executeAfter: timestamp('execute_after', { withTimezone: true }),
    timedOutAt: timestamp('timed_out_at', { withTimezone: true }),
    resolvedAt: timestamp('resolved_at', { withTimezone: true }),
    /** `pending` until a finished Proposal's accounts are closed (#88), then `closed`; null when never asked. */
    closeState: text('close_state'),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
    nextCheckAt: timestamp('next_check_at', { withTimezone: true }).notNull().defaultNow(),
    checkFailures: integer('check_failures').notNull().default(0),
    proposeSignedBytes: text('propose_signed_bytes'),
    proposeHash: text('propose_hash'),
    expected: jsonb('expected').notNull().$type<ExpectedTotals>(),
    committed: jsonb('committed').notNull().$type<CommittedAmounts>(),
  },
  (table) => [
    uniqueIndex('proposals_proposal_ref_idx').on(table.proposalRef),
    // Squads transaction indexes are never reused; a Safe nonce is, after a timeout (ADR-0053).
    uniqueIndex('proposals_solana_sequence_idx')
      .on(table.chain, table.senderAddress, table.sequence)
      .where(sql`${table.chain} = 'solana'`),
  ],
);

export const attempts = pgTable(
  'attempts',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    transactionId: uuid('transaction_id')
      .notNull()
      .references(() => transactions.id),
    broadcastAt: timestamp('broadcast_at', { withTimezone: true }).notNull().defaultNow(),
    error: jsonb('error').$type<DispatchError | null>(),
  },
  (table) => [index('attempts_transaction_id_idx').on(table.transactionId)],
);

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
    /** #20: when a worker last claimed this row. */
    claimedAt: timestamp('claimed_at', { withTimezone: true }),
    /** ADR-0056: when an operator cancelled it, before any claim. */
    cancelledAt: timestamp('cancelled_at', { withTimezone: true }),
  },
  (table) => [
    uniqueIndex('relay_dispatches_idempotency_key_idx').on(table.idempotencyKey),
    index('relay_dispatches_created_at_id_idx').on(table.createdAt, table.id),
  ],
);

/** ADR-0057: one row per cancel, release and Flag Rule write, never updated. */
export const operatorActions = pgTable(
  'operator_actions',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    // Not now(): that is when the transaction began, possibly before it waited on the row it changed.
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    action: text('action').notNull(),
    targetId: uuid('target_id').notNull(),
    tokenKind: text('token_kind').notNull(),
    reason: text('reason'),
  },
  (table) => [
    index('operator_actions_at_id_idx').on(table.at, table.id),
    index('operator_actions_target_idx').on(table.targetId),
  ],
);

/** ADR-0058: a Flag Rule's identity. Its content lives in `flag_rule_versions`. */
export const flagRules = pgTable('flag_rules', {
  id: uuid('id').primaryKey().defaultRandom(),
  currentVersion: integer('current_version').notNull(),
  createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  deletedAt: timestamp('deleted_at', { withTimezone: true }),
});

/** ADR-0058: forward-only; a row is never updated, and an edit inserts the next version. */
export const flagRuleVersions = pgTable(
  'flag_rule_versions',
  {
    ruleId: uuid('rule_id')
      .notNull()
      .references(() => flagRules.id),
    version: integer('version').notNull(),
    name: text('name').notNull(),
    chain: text('chain').notNull(),
    /** #149: null applies the version to every Sender on `chain`. */
    senderAddress: text('sender_address'),
    enabled: boolean('enabled').notNull(),
    definition: jsonb('definition').notNull().$type<FlagRuleDefinitionJson>(),
    createdAt: timestamp('created_at', { withTimezone: true }).notNull().defaultNow(),
  },
  (table) => [primaryKey({ columns: [table.ruleId, table.version] })],
);

/** ADR-0058: why a Dispatch was held. Each match names an immutable rule version. */
export const dispatchHolds = pgTable('dispatch_holds', {
  dispatchId: uuid('dispatch_id')
    .primaryKey()
    .references(() => dispatches.id),
  matched: jsonb('matched')
    .notNull()
    .$type<{ ruleId: string; ruleVersion: number; items: number[] }[]>(),
  heldAt: timestamp('held_at', { withTimezone: true }).notNull().defaultNow(),
  releasedAt: timestamp('released_at', { withTimezone: true }),
  releaseReason: text('release_reason'),
});
/** ADR-0059: what the worker last read from the Signer about each Sender key, so the API never calls the Signer. */
export const signerKeys = pgTable(
  'signer_keys',
  {
    chain: text('chain').notNull(),
    address: text('address').notNull(),
    pins: jsonb('pins').$type<SignerPins>(),
    error: text('error'),
    readAt: timestamp('read_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    primaryKey({ columns: [table.chain, table.address] }),
    check('signer_keys_pins_or_error', sql`(${table.pins} IS NULL) <> (${table.error} IS NULL)`),
  ],
);

/** The worker's latest run of its setup checks: one row per check, and per chain for a chain check. */
export const setupChecks = pgTable(
  'setup_checks',
  {
    /** The check's id, with `:<chain>` for a chain check, as `doctor --json` names it. */
    id: text('id').primaryKey(),
    area: text('area').notNull(),
    title: text('title').notNull(),
    chain: text('chain'),
    status: text('status').notNull(),
    finding: text('finding').notNull(),
    fix: jsonb('fix').$type<Fix>(),
    ranAt: timestamp('ran_at', { withTimezone: true }).notNull(),
  },
  (table) => [
    check('setup_checks_fix_unless_pass', sql`(${table.status} = 'pass') = (${table.fix} IS NULL)`),
  ],
);

/** ADR-0061: the Known Asset registry. A row is disabled, never deleted, so history keeps resolving. */
export const knownAssets = pgTable(
  'known_assets',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    chain: text('chain').notNull(),
    /** The mint or contract (Base checksummed), or `native`. */
    address: text('address').notNull(),
    symbol: text('symbol').notNull(),
    name: text('name').notNull(),
    decimals: integer('decimals').notNull(),
    kind: text('kind').notNull(),
    source: text('source').notNull(),
    addedBy: text('added_by'),
    addedAt: timestamp('added_at', { withTimezone: true }).notNull().defaultNow(),
    enabled: boolean('enabled').notNull(),
  },
  (table) => [
    uniqueIndex('known_assets_chain_address_idx').on(table.chain, table.address),
    uniqueIndex('known_assets_enabled_symbol_idx')
      .on(table.chain, sql`upper(${table.symbol})`)
      .where(sql`${table.enabled}`),
    check('known_assets_decimals', sql`${table.decimals} BETWEEN 0 AND 255`),
  ],
);

/** ADR-0062: a `POST /v1/dispatch` refused with a 4xx other than 401. Pruned by the worker. */
export const rejectedRequests = pgTable(
  'rejected_requests',
  {
    id: uuid('id').primaryKey().defaultRandom(),
    at: timestamp('at', { withTimezone: true })
      .notNull()
      .default(sql`clock_timestamp()`),
    status: integer('status').notNull(),
    chain: text('chain'),
    idempotencyKey: text('idempotency_key'),
    tokenKind: text('token_kind').notNull(),
    code: text('code'),
    message: text('message').notNull(),
    chainDetail: jsonb('chain_detail'),
    body: jsonb('body'),
  },
  (table) => [index('rejected_requests_at_id_idx').on(table.at, table.id)],
);
