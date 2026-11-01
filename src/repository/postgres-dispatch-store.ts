import {
  and,
  desc,
  eq,
  gte,
  inArray,
  isNotNull,
  isNull,
  lt,
  lte,
  ne,
  notInArray,
  or,
  sql,
  type SQL,
} from 'drizzle-orm';

import type { Database } from '../db/client.js';
import {
  attempts,
  dispatches,
  dispatchHolds,
  flagRules,
  flagRuleVersions,
  knownAssets,
  operatorActions,
  proposals,
  relayDispatches,
  setupChecks,
  signerKeys,
  transactions,
} from '../db/schema.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch, DispatchStatus } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import {
  definitionFromJson,
  definitionToJson,
  type FlagRule,
  type FlagRuleSpec,
  type FlagRuleVersion,
  type Hold,
} from '../domain/flag-rule.js';
import {
  planConfigSeed,
  symbolKey,
  type AssetSource,
  type ConfigAsset,
  type KnownAsset,
  type NewKnownAsset,
} from '../domain/known-asset.js';
import type { OperatorActionKind, OperatorActor, TokenKind } from '../domain/operator-action.js';
import { ok, type Result } from '../domain/result.js';
import type {
  ApprovalState,
  AssetAmount,
  CloseState,
  Proposal,
  ProposalPhase,
} from '../domain/proposal.js';
import type { RelayDispatch, RelayDispatchStatus } from '../domain/relay-dispatch.js';
import type { SenderAddress, SenderRef } from '../domain/sender.js';
import type { Area } from '../setup/check.js';
import type { Attempt, Transaction, TransactionStatus } from '../domain/transaction.js';
import { totalCommitted } from './committed.js';
import { compareNewestFirst } from './dispatch-store.js';
import type {
  CancelOutcome,
  ChainScope,
  CommittedHolder,
  DispatchListQuery,
  DispatchStore,
  ListedDispatch,
  ListedOperatorAction,
  NewDispatchInput,
  NewFailedCallInput,
  NewProposalInput,
  NewRelayDispatchInput,
  NewTransactionInput,
  NewUnproposedInput,
  OperatorActionQuery,
  ProposalOutcome,
  ProposalPatch,
  SetupCheckRecord,
  SignerKeyRecord,
} from './dispatch-store.js';

type DispatchRow = typeof dispatches.$inferSelect;
type TransactionRow = typeof transactions.$inferSelect;
type RelayDispatchRow = typeof relayDispatches.$inferSelect;
type ProposalRow = typeof proposals.$inferSelect;

function toDispatch(row: DispatchRow): Dispatch {
  return {
    id: row.id,
    chain: row.chain as Chain,
    idempotencyKey: row.idempotencyKey,
    items: row.items,
    status: row.status as DispatchStatus,
    retryPolicy: row.retryPolicy,
    bulkCall: row.bulkCall ?? null,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    firstClaimedAt: row.firstClaimedAt,
    cancelledAt: row.cancelledAt,
    senderAddress: row.senderAddress as SenderAddress | null,
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
    abandonedAt: row.abandonedAt,
    confirmedAt: row.confirmedAt,
    failedAt: row.failedAt,
    lastCheckedAt: row.lastCheckedAt,
    lastBroadcastAt: row.lastBroadcastAt,
    sentAt: row.sentAt,
    replacesTransactionId: row.replacesTransactionId,
    feeBumpAttempts: row.feeBumpAttempts,
    proposalId: row.proposalId,
    proposalPosition: row.proposalPosition,
  };
}

function toProposal(row: ProposalRow): Proposal {
  return {
    id: row.id,
    dispatchId: row.dispatchId,
    chain: row.chain as Chain,
    senderAddress: row.senderAddress,
    chainRef: row.chainRef,
    payload: row.payload,
    proposalRef: row.proposalRef,
    sequence: row.sequence,
    phase: row.phase as ProposalPhase,
    approvalState: row.approvalState as ApprovalState,
    approvals: row.approvals,
    threshold: row.threshold,
    approvers: row.approvers,
    deadlineAt: row.deadlineAt,
    executeAfter: row.executeAfter,
    timedOutAt: row.timedOutAt,
    resolvedAt: row.resolvedAt,
    closeState: row.closeState as CloseState | null,
    createdAt: row.createdAt,
    nextCheckAt: row.nextCheckAt,
    checkFailures: row.checkFailures,
    proposeSignedBytes: row.proposeSignedBytes,
    proposeHash: row.proposeHash,
    expected: row.expected,
    committed: row.committed,
  };
}

function byPosition(a: Transaction, b: Transaction): number {
  return (a.proposalPosition ?? 0) - (b.proposalPosition ?? 0);
}

function toRelayDispatch(row: RelayDispatchRow): RelayDispatch {
  return {
    id: row.id,
    chain: row.chain as Chain,
    idempotencyKey: row.idempotencyKey,
    signedTransaction: row.signedTransaction,
    status: row.status as RelayDispatchStatus,
    transactionId: row.transactionId,
    createdAt: row.createdAt,
    claimedAt: row.claimedAt,
    firstClaimedAt: row.firstClaimedAt,
    cancelledAt: row.cancelledAt,
  };
}

type Tx = Parameters<Parameters<Database['transaction']>[0]>[0];

function toKnownAsset(row: typeof knownAssets.$inferSelect): KnownAsset {
  return {
    ...row,
    chain: row.chain as Chain,
    kind: row.kind,
    source: row.source as AssetSource,
    addedBy: row.addedBy as TokenKind | null,
  } as KnownAsset;
}

/** Every Known Asset write takes this lock, so two writers never both pass the same check (ADR-0061). */
async function lockKnownAssets(tx: Tx): Promise<void> {
  await tx.execute(sql`select pg_advisory_xact_lock(hashtext('known_assets'))`);
}

async function symbolHeld(tx: Tx, chain: string, symbol: string): Promise<boolean> {
  const [held] = await tx
    .select({ id: knownAssets.id })
    .from(knownAssets)
    .where(
      and(
        eq(knownAssets.chain, chain),
        eq(knownAssets.enabled, true),
        eq(sql`upper(${knownAssets.symbol})`, symbolKey(symbol)),
      ),
    );
  return held !== undefined;
}

function toVersionRow(ruleId: string, version: number, spec: FlagRuleSpec) {
  return {
    ruleId,
    version,
    name: spec.name,
    chain: spec.chain,
    senderAddress: spec.senderAddress,
    enabled: spec.enabled,
    definition: definitionToJson(spec.definition),
  };
}

function toFlagRuleVersion(row: typeof flagRuleVersions.$inferSelect): FlagRuleVersion {
  return {
    ruleId: row.ruleId,
    version: row.version,
    name: row.name,
    chain: row.chain as Chain,
    senderAddress: row.senderAddress as SenderAddress | null,
    enabled: row.enabled,
    definition: definitionFromJson(row.definition),
    createdAt: row.createdAt,
  };
}

/** The rules `rows`, each with its versions, in the order given. */
async function withVersions(
  db: Database | Tx,
  rows: (typeof flagRules.$inferSelect)[],
): Promise<FlagRule[]> {
  if (rows.length === 0) return [];
  const versions = await db
    .select()
    .from(flagRuleVersions)
    .where(
      inArray(
        flagRuleVersions.ruleId,
        rows.map((r) => r.id),
      ),
    )
    .orderBy(flagRuleVersions.version);
  return rows.map((row) => {
    const own = versions.filter((v) => v.ruleId === row.id).map(toFlagRuleVersion);
    const current = own.find((v) => v.version === row.currentVersion);
    if (!current) throw new Error(`Flag Rule ${row.id} has no version ${row.currentVersion}`);
    return {
      id: row.id,
      createdAt: row.createdAt,
      deletedAt: row.deletedAt,
      current,
      versions: own,
    };
  });
}

async function withVersionsOne(
  db: Database | Tx,
  row: typeof flagRules.$inferSelect,
): Promise<FlagRule> {
  const [rule] = await withVersions(db, [row]);
  if (!rule) throw new Error(`Flag Rule ${row.id} vanished mid-read`);
  return rule;
}

/**
 * The real persistence behind DispatchStore (ADR-0008/ADR-0011) — plain
 * constructor injection (ADR-0014), never creates its own connection.
 */
export class PostgresDispatchStore implements DispatchStore {
  constructor(private readonly db: Database) {}

  async createDispatch<C extends Chain>(input: NewDispatchInput<C>): Promise<Dispatch<C>> {
    const hold = input.hold ?? [];
    const inserted = await this.db.transaction(async (tx) => {
      const rows = await tx
        .insert(dispatches)
        .values({
          chain: input.chain,
          idempotencyKey: input.idempotencyKey,
          items: input.items,
          retryPolicy: input.retryPolicy,
          bulkCall: input.bulkCall ?? null,
          senderAddress: input.senderAddress ?? null,
          status: hold.length > 0 ? 'held' : 'queued',
        })
        .onConflictDoNothing({ target: dispatches.idempotencyKey })
        .returning();
      const [row] = rows;
      if (row && hold.length > 0) {
        await tx.insert(dispatchHolds).values({
          dispatchId: row.id,
          matched: hold.map(({ rule, items }) => ({
            ruleId: rule.ruleId,
            ruleVersion: rule.version,
            items,
          })),
        });
      }
      return rows;
    });

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

  async listAttempts(dispatchId: string): Promise<Attempt[]> {
    const rows = await this.db
      .select({ attempt: attempts })
      .from(attempts)
      .innerJoin(transactions, eq(transactions.id, attempts.transactionId))
      .where(eq(transactions.dispatchId, dispatchId))
      .orderBy(attempts.broadcastAt);
    return rows.map(({ attempt }) => ({ ...attempt, error: attempt.error ?? null }));
  }

  async claimQueuedFor(sender: SenderRef, limit: number): Promise<Dispatch[]> {
    return this.claimWhere(
      and(
        eq(dispatches.status, 'queued'),
        eq(dispatches.chain, sender.chain),
        eq(dispatches.senderAddress, sender.address),
      ),
      limit,
    );
  }

  async assignUnassignedDispatches(sender: SenderRef): Promise<number> {
    const rows = await this.db
      .update(dispatches)
      .set({ senderAddress: sender.address })
      .where(and(eq(dispatches.chain, sender.chain), isNull(dispatches.senderAddress)))
      .returning({ id: dispatches.id });
    return rows.length;
  }

  async claimQueued(chains: ChainScope, limit: number): Promise<Dispatch[]> {
    return this.claimWhere(
      and(eq(dispatches.status, 'queued'), inArray(dispatches.chain, chains)),
      limit,
    );
  }

  private async claimWhere(where: SQL | undefined, limit: number): Promise<Dispatch[]> {
    // Concurrency-safe outbox claim: lock and skip rows another worker is
    // already claiming, per ADR-0009's shared-outbox pattern. Via the query
    // builder (not a raw sql`` template) so the returned rows go through
    // Drizzle's own camelCase mapping — the same one every other method
    // here relies on — rather than postgres.js's raw snake_case columns.
    return this.db.transaction(async (tx) => {
      const claimable = await tx
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(where)
        .orderBy(dispatches.createdAt)
        .limit(limit)
        .for('update', { skipLocked: true });

      if (claimable.length === 0) return [];

      const now = new Date();
      const rows = await tx
        .update(dispatches)
        .set({ status: 'broadcasting', claimedAt: now, firstClaimedAt: now })
        .where(
          inArray(
            dispatches.id,
            claimable.map((row) => row.id),
          ),
        )
        .returning();

      return rows.map(toDispatch);
    });
  }

  async cancelDispatch(id: string, actor: OperatorActor): Promise<CancelOutcome> {
    // The status guard is the whole race: claimQueued and releaseDispatch lock the row they change,
    // so this update either commits first or re-reads the row as they left it.
    const cancelled = await this.db.transaction(async (tx) => {
      const cancelledAt = new Date();
      const [managed] = await tx
        .update(dispatches)
        .set({ status: 'cancelled', cancelledAt })
        .where(and(eq(dispatches.id, id), inArray(dispatches.status, ['queued', 'held'])))
        .returning({ id: dispatches.id });
      const [relay] = managed
        ? []
        : await tx
            .update(relayDispatches)
            .set({ status: 'cancelled', cancelledAt })
            .where(and(eq(relayDispatches.id, id), eq(relayDispatches.status, 'queued')))
            .returning({ id: relayDispatches.id });
      if (!managed && !relay) return false;
      await tx.insert(operatorActions).values({ ...actor, action: 'cancel', targetId: id });
      return true;
    });
    if (cancelled) return 'cancelled';

    const [existing] = await this.db
      .select({ status: dispatches.status })
      .from(dispatches)
      .where(eq(dispatches.id, id))
      .union(
        this.db
          .select({ status: relayDispatches.status })
          .from(relayDispatches)
          .where(eq(relayDispatches.id, id)),
      );
    if (!existing) return 'not_found';
    return existing.status === 'cancelled' ? 'already_cancelled' : 'already_claimed';
  }

  async releaseDispatch(
    id: string,
    reason: string,
  ): Promise<'released' | 'not_held' | 'not_found'> {
    const released = await this.db.transaction(async (tx) => {
      const [row] = await tx
        .update(dispatches)
        .set({ status: 'queued' })
        .where(and(eq(dispatches.id, id), eq(dispatches.status, 'held')))
        .returning({ id: dispatches.id });
      if (!row) return false;
      await tx
        .update(dispatchHolds)
        .set({ releasedAt: new Date(), releaseReason: reason })
        .where(eq(dispatchHolds.dispatchId, id));
      await tx
        .insert(operatorActions)
        .values({ tokenKind: 'operator', reason, action: 'release', targetId: id });
      return true;
    });
    if (released) return 'released';
    const [existing] = await this.db
      .select({ id: dispatches.id })
      .from(dispatches)
      .where(eq(dispatches.id, id))
      .union(
        this.db
          .select({ id: relayDispatches.id })
          .from(relayDispatches)
          .where(eq(relayDispatches.id, id)),
      );
    return existing ? 'not_held' : 'not_found';
  }

  async listOperatorActions(query: OperatorActionQuery): Promise<ListedOperatorAction[]> {
    const { after } = query;
    const rows = await this.db
      .select({
        row: operatorActions,
        exactAt: sql<string>`to_char(${operatorActions.at} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`,
      })
      .from(operatorActions)
      .where(
        after
          ? sql`(${operatorActions.at}, ${operatorActions.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
          : undefined,
      )
      .orderBy(desc(operatorActions.at), desc(operatorActions.id))
      .limit(query.limit);
    return rows.map(({ row, exactAt }) => ({
      action: {
        ...row,
        action: row.action as OperatorActionKind,
        tokenKind: row.tokenKind as TokenKind,
      },
      cursor: { createdAt: exactAt, id: row.id },
    }));
  }

  async createFlagRule(spec: FlagRuleSpec, actor: OperatorActor): Promise<FlagRule> {
    return this.db.transaction(async (tx) => {
      const [rule] = await tx.insert(flagRules).values({ currentVersion: 1 }).returning();
      if (!rule) throw new Error('Failed to create a Flag Rule');
      await tx.insert(flagRuleVersions).values(toVersionRow(rule.id, 1, spec));
      await tx
        .insert(operatorActions)
        .values({ ...actor, action: 'flag_rule_create', targetId: rule.id });
      return withVersionsOne(tx, rule);
    });
  }

  async updateFlagRule(
    id: string,
    spec: FlagRuleSpec,
    actor: OperatorActor,
  ): Promise<FlagRule | 'not_found' | 'deleted'> {
    return this.db.transaction(async (tx) => {
      // The row lock serializes concurrent edits, so each takes the next version number.
      const [rule] = await tx.select().from(flagRules).where(eq(flagRules.id, id)).for('update');
      if (!rule) return 'not_found';
      if (rule.deletedAt) return 'deleted';
      const version = rule.currentVersion + 1;
      await tx.insert(flagRuleVersions).values(toVersionRow(id, version, spec));
      await tx.update(flagRules).set({ currentVersion: version }).where(eq(flagRules.id, id));
      await tx
        .insert(operatorActions)
        .values({ ...actor, action: 'flag_rule_update', targetId: id });
      return withVersionsOne(tx, { ...rule, currentVersion: version });
    });
  }

  async deleteFlagRule(
    id: string,
    actor: OperatorActor,
  ): Promise<{ rule: FlagRule; deleted: boolean } | 'not_found'> {
    return this.db.transaction(async (tx) => {
      const [deleted] = await tx
        .update(flagRules)
        .set({ deletedAt: new Date() })
        .where(and(eq(flagRules.id, id), isNull(flagRules.deletedAt)))
        .returning();
      if (deleted) {
        await tx
          .insert(operatorActions)
          .values({ ...actor, action: 'flag_rule_delete', targetId: id });
        return { rule: await withVersionsOne(tx, deleted), deleted: true };
      }
      const [existing] = await tx.select().from(flagRules).where(eq(flagRules.id, id));
      return existing ? { rule: await withVersionsOne(tx, existing), deleted: false } : 'not_found';
    });
  }

  async getFlagRule(id: string): Promise<FlagRule | null> {
    const rows = await this.db.select().from(flagRules).where(eq(flagRules.id, id));
    const [rule] = await withVersions(this.db, rows);
    return rule ?? null;
  }

  async listKnownAssets(): Promise<KnownAsset[]> {
    return (await this.db.select().from(knownAssets)).map(toKnownAsset);
  }

  async seedConfigAssets(configured: readonly ConfigAsset[]): Promise<Result<void, string>> {
    return this.db.transaction(async (tx) => {
      await lockKnownAssets(tx);
      const existing = (await tx.select().from(knownAssets)).map(toKnownAsset);
      const plan = planConfigSeed(existing, configured);
      if (!plan.ok) return plan;
      for (const write of plan.value) {
        if (write.op === 'disable') {
          await tx.update(knownAssets).set({ enabled: false }).where(eq(knownAssets.id, write.id));
        } else {
          const values = { ...write.asset, source: 'config', addedBy: null, enabled: true };
          if (write.op === 'insert') await tx.insert(knownAssets).values(values);
          else await tx.update(knownAssets).set(values).where(eq(knownAssets.id, write.id));
        }
      }
      return ok(undefined);
    });
  }

  async addKnownAsset(
    asset: NewKnownAsset,
    actor: OperatorActor,
  ): Promise<KnownAsset | 'address_taken' | 'symbol_taken'> {
    return this.db.transaction(async (tx) => {
      await lockKnownAssets(tx);
      const [atAddress] = await tx
        .select({ id: knownAssets.id })
        .from(knownAssets)
        .where(and(eq(knownAssets.chain, asset.chain), eq(knownAssets.address, asset.address)));
      if (atAddress) return 'address_taken';
      if (await symbolHeld(tx, asset.chain, asset.symbol)) return 'symbol_taken';
      const [row] = await tx
        .insert(knownAssets)
        .values({ ...asset, source: 'console', addedBy: actor.tokenKind, enabled: true })
        .returning();
      if (!row) throw new Error('Failed to add a Known Asset');
      await tx.insert(operatorActions).values({ ...actor, action: 'asset_add', targetId: row.id });
      return toKnownAsset(row);
    });
  }

  async setKnownAssetEnabled(
    id: string,
    enabled: boolean,
    actor: OperatorActor,
  ): Promise<
    { asset: KnownAsset; changed: boolean } | 'not_found' | 'config_row' | 'symbol_taken'
  > {
    return this.db.transaction(async (tx) => {
      await lockKnownAssets(tx);
      const [row] = await tx.select().from(knownAssets).where(eq(knownAssets.id, id));
      if (!row) return 'not_found';
      if (row.source === 'config') return 'config_row';
      if (row.enabled === enabled) return { asset: toKnownAsset(row), changed: false };
      if (enabled && (await symbolHeld(tx, row.chain, row.symbol))) return 'symbol_taken';
      const [updated] = await tx
        .update(knownAssets)
        .set({ enabled })
        .where(eq(knownAssets.id, id))
        .returning();
      await tx.insert(operatorActions).values({
        ...actor,
        action: enabled ? 'asset_enable' : 'asset_disable',
        targetId: id,
      });
      return { asset: toKnownAsset(updated!), changed: true };
    });
  }

  async listEnabledFlagRules(chain: Chain): Promise<FlagRuleVersion[]> {
    const rows = await this.db
      .select({ version: flagRuleVersions })
      .from(flagRules)
      .innerJoin(
        flagRuleVersions,
        and(
          eq(flagRuleVersions.ruleId, flagRules.id),
          eq(flagRuleVersions.version, flagRules.currentVersion),
        ),
      )
      .where(
        and(
          isNull(flagRules.deletedAt),
          eq(flagRuleVersions.enabled, true),
          eq(flagRuleVersions.chain, chain),
        ),
      )
      .orderBy(flagRules.createdAt, flagRules.id);
    return rows.map(({ version }) => toFlagRuleVersion(version));
  }

  async firstConfirmedPayments(chain: Chain, recipients: string[]): Promise<Map<string, Date>> {
    if (recipients.length === 0) return new Map();
    const raw = sql`(${dispatches.items} -> ${transactions.callIndex} -> 'payment' ->> 'recipient')`;
    const recipient = chain === 'base' ? sql<string>`lower(${raw})` : sql<string>`${raw}`;
    const rows = await this.db
      .select({
        recipient,
        first:
          sql<Date>`min(coalesce(${transactions.confirmedAt}, ${transactions.broadcastAt}, ${dispatches.createdAt}))`.mapWith(
            transactions.confirmedAt,
          ),
      })
      .from(transactions)
      .innerJoin(dispatches, eq(dispatches.id, transactions.dispatchId))
      .where(
        and(
          eq(transactions.status, 'CONFIRMED'),
          eq(transactions.chain, chain),
          inArray(recipient, recipients),
        ),
      )
      .groupBy(recipient);
    return new Map(rows.map((r) => [r.recipient, r.first]));
  }

  async acceptedVolume(
    chain: Chain,
    assets: string[],
    since: Date,
    senderAddress?: SenderAddress,
  ): Promise<Map<string, bigint>> {
    if (assets.length === 0) return new Map();
    const rows = await this.db.execute<{ asset: string; total: string }>(sql`
      select item -> 'payment' ->> 'asset' as asset,
             sum((item -> 'payment' ->> 'amount')::numeric)::text as total
      from ${dispatches}, jsonb_array_elements(${dispatches.items}) as item
      where ${dispatches.chain} = ${chain}
        and ${dispatches.createdAt} >= ${since.toISOString()}::timestamptz
        and ${dispatches.status} <> 'cancelled'
        and ${senderAddress === undefined ? sql`true` : sql`${dispatches.senderAddress} = ${senderAddress}`}
        and item -> 'payment' ->> 'asset' in (${sql.join(
          assets.map((a) => sql`${a}`),
          sql`, `,
        )})
      group by 1`);
    return new Map(rows.map((r) => [r.asset, BigInt(r.total)]));
  }

  async listManagedDispatchesSince(chain: Chain, since: Date, limit: number): Promise<Dispatch[]> {
    const rows = await this.db
      .select()
      .from(dispatches)
      .where(and(eq(dispatches.chain, chain), gte(dispatches.createdAt, since)))
      .orderBy(desc(dispatches.createdAt), desc(dispatches.id))
      .limit(limit);
    return rows.map(toDispatch);
  }

  async getHold(dispatchId: string): Promise<Hold | null> {
    const [hold] = await this.db
      .select()
      .from(dispatchHolds)
      .where(eq(dispatchHolds.dispatchId, dispatchId));
    if (!hold) return null;
    const versions = await this.db
      .select()
      .from(flagRuleVersions)
      .where(
        or(
          ...hold.matched.map((m) =>
            and(eq(flagRuleVersions.ruleId, m.ruleId), eq(flagRuleVersions.version, m.ruleVersion)),
          ),
        ),
      );
    return {
      dispatchId,
      heldAt: hold.heldAt,
      release:
        hold.releasedAt && hold.releaseReason !== null
          ? { at: hold.releasedAt, reason: hold.releaseReason }
          : null,
      matched: hold.matched.map(({ ruleId, ruleVersion, items }) => {
        const row = versions.find((v) => v.ruleId === ruleId && v.version === ruleVersion);
        if (!row) throw new Error(`hold on ${dispatchId} names a missing rule version`);
        return { rule: toFlagRuleVersion(row), items };
      }),
    };
  }

  async listFlagRules(): Promise<FlagRule[]> {
    const rows = await this.db
      .select()
      .from(flagRules)
      .where(isNull(flagRules.deletedAt))
      .orderBy(flagRules.createdAt, flagRules.id);
    return withVersions(this.db, rows);
  }

  async listPendingTransactions(chains: ChainScope, limit: number): Promise<Transaction[]> {
    const rows = await this.db.query.transactions.findMany({
      where: and(eq(transactions.status, 'PENDING'), inArray(transactions.chain, chains)),
      orderBy: [sql`${transactions.lastCheckedAt} asc nulls first`, transactions.broadcastAt],
      limit,
    });
    if (rows.length === 0) return [];
    // ponytail: select-then-stamp, not one atomic UPDATE…RETURNING — fine for the single worker (ADR-0009); make it atomic if workers ever run concurrently.
    const lastCheckedAt = new Date();
    await this.db
      .update(transactions)
      .set({ lastCheckedAt })
      .where(
        inArray(
          transactions.id,
          rows.map((row) => row.id),
        ),
      );
    return rows.map((row) => toTransaction({ ...row, lastCheckedAt }));
  }

  async listAbandonedTransactions(
    chains: ChainScope,
    limit: number,
    notAbandonedBefore: Date,
  ): Promise<Transaction[]> {
    const rows = await this.db.query.transactions.findMany({
      where: and(
        eq(transactions.status, 'ABANDONED'),
        isNotNull(transactions.hash),
        inArray(transactions.chain, chains),
        gte(transactions.abandonedAt, notAbandonedBefore),
      ),
      orderBy: transactions.abandonedAt,
      limit,
    });
    return rows.map(toTransaction);
  }

  async listRecentlyConfirmedTransactions(
    chain: Chain,
    limit: number,
    notConfirmedBefore: Date,
  ): Promise<Transaction[]> {
    const rows = await this.db.query.transactions.findMany({
      where: and(
        eq(transactions.chain, chain),
        eq(transactions.status, 'CONFIRMED'),
        // A Call a proposal's other executor confirmed (#88) has no signed bytes of ours to re-check.
        isNotNull(transactions.signedBytes),
        gte(transactions.confirmedAt, notConfirmedBefore),
      ),
      orderBy: transactions.confirmedAt,
      limit,
    });
    return rows.map(toTransaction);
  }

  async createTransaction(input: NewTransactionInput): Promise<Transaction> {
    const now = new Date();
    const [row] = await this.db
      .insert(transactions)
      .values({
        dispatchId: input.dispatchId,
        callIndex: input.callIndex,
        chain: input.chain,
        signedBytes: input.signedBytes,
        hash: input.hash,
        broadcastAt: now,
        lastBroadcastAt: now,
      })
      .returning();

    if (!row) {
      throw new Error('Failed to create Transaction');
    }

    return toTransaction(row);
  }

  async createReplacementTransaction(
    predecessorId: string,
    replacement: { signedBytes: string; hash: string },
  ): Promise<Transaction> {
    return this.db.transaction(async (tx) => {
      const predecessor = await tx.query.transactions.findFirst({
        where: eq(transactions.id, predecessorId),
      });
      if (!predecessor) {
        throw new Error(`Unknown transaction: ${predecessorId}`);
      }
      const now = new Date();
      const [row] = await tx
        .insert(transactions)
        .values({
          dispatchId: predecessor.dispatchId,
          callIndex: predecessor.callIndex,
          chain: predecessor.chain,
          signedBytes: replacement.signedBytes,
          hash: replacement.hash,
          broadcastAt: now,
          lastBroadcastAt: now,
          replacesTransactionId: predecessor.id,
          feeBumpAttempts: predecessor.feeBumpAttempts + 1,
          proposalId: predecessor.proposalId,
          proposalPosition: predecessor.proposalPosition,
        })
        .returning();
      if (!row) {
        throw new Error('Failed to create replacement Transaction');
      }
      await tx
        .update(transactions)
        .set({ status: 'REPLACED' })
        .where(eq(transactions.id, predecessorId));
      return toTransaction(row);
    });
  }

  async listTransactionsByHash(hash: string): Promise<Transaction[]> {
    const rows = await this.db.query.transactions.findMany({ where: eq(transactions.hash, hash) });
    return rows.map(toTransaction);
  }

  async setFeeBumpAttempts(transactionId: string, feeBumpAttempts: number): Promise<void> {
    await this.db
      .update(transactions)
      .set({ feeBumpAttempts })
      .where(eq(transactions.id, transactionId));
  }

  async recordSent(transactionId: string, hash: string, sentAt = new Date()): Promise<void> {
    await this.db
      .update(transactions)
      .set({
        hash,
        lastBroadcastAt: sentAt,
        sentAt: sql`coalesce(${transactions.sentAt}, ${sentAt.toISOString()}::timestamptz)`,
      })
      .where(eq(transactions.id, transactionId));
  }

  async undoReplacement(replacementId: string): Promise<void> {
    await this.db.transaction(async (tx) => {
      const replacement = await tx.query.transactions.findFirst({
        where: eq(transactions.id, replacementId),
      });
      if (!replacement?.replacesTransactionId) {
        throw new Error(`Not a replacement transaction: ${replacementId}`);
      }
      await tx
        .update(transactions)
        .set({ status: 'DROPPED' })
        .where(eq(transactions.id, replacementId));
      await tx
        .update(transactions)
        .set({ status: 'PENDING' })
        .where(eq(transactions.id, replacement.replacesTransactionId));
    });
  }

  async reclaimStaleDispatches(
    chains: ChainScope,
    claimedBefore: Date,
    limit: number,
  ): Promise<Dispatch[]> {
    return this.db.transaction(async (tx) => {
      const stale = await tx
        .select({ id: dispatches.id })
        .from(dispatches)
        .where(
          and(
            eq(dispatches.status, 'broadcasting'),
            inArray(dispatches.chain, chains),
            or(isNull(dispatches.claimedAt), lt(dispatches.claimedAt, claimedBefore)),
            sql`jsonb_array_length(${dispatches.items}) > (select count(distinct ${transactions.callIndex}) from ${transactions} where ${transactions.dispatchId} = ${dispatches.id})`,
          ),
        )
        .orderBy(dispatches.claimedAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      if (stale.length === 0) return [];
      const rows = await tx
        .update(dispatches)
        .set({ claimedAt: new Date() })
        .where(
          inArray(
            dispatches.id,
            stale.map((row) => row.id),
          ),
        )
        .returning();
      return rows.map(toDispatch);
    });
  }

  async reclaimStaleRelayDispatches(
    chains: ChainScope,
    claimedBefore: Date,
    limit: number,
  ): Promise<RelayDispatch[]> {
    return this.db.transaction(async (tx) => {
      const stale = await tx
        .select({ id: relayDispatches.id })
        .from(relayDispatches)
        .where(
          and(
            eq(relayDispatches.status, 'broadcasting'),
            inArray(relayDispatches.chain, chains),
            or(isNull(relayDispatches.claimedAt), lt(relayDispatches.claimedAt, claimedBefore)),
            sql`not exists (select 1 from ${transactions} where ${transactions.dispatchId} = ${relayDispatches.id})`,
          ),
        )
        .orderBy(relayDispatches.claimedAt)
        .limit(limit)
        .for('update', { skipLocked: true });
      if (stale.length === 0) return [];
      const rows = await tx
        .update(relayDispatches)
        .set({ claimedAt: new Date() })
        .where(
          inArray(
            relayDispatches.id,
            stale.map((row) => row.id),
          ),
        )
        .returning();
      return rows.map(toRelayDispatch);
    });
  }

  async countWaitingWork(chains: ChainScope): Promise<Map<Chain, number>> {
    const counts = new Map<Chain, number>();
    for (const [table, waitingStatus] of [
      [dispatches, eq(dispatches.status, 'queued')],
      [relayDispatches, eq(relayDispatches.status, 'queued')],
      [transactions, inArray(transactions.status, ['PENDING', 'UNPROPOSED', 'AWAITING_APPROVAL'])],
    ] as const) {
      const rows = await this.db
        .select({ chain: table.chain, count: sql<number>`count(*)::int` })
        .from(table)
        .where(and(waitingStatus, inArray(table.chain, chains)))
        .groupBy(table.chain);
      for (const { chain, count } of rows) {
        counts.set(chain as Chain, (counts.get(chain as Chain) ?? 0) + count);
      }
    }
    return counts;
  }

  async markDropped(transactionId: string): Promise<void> {
    await this.db
      .update(transactions)
      .set({ status: 'DROPPED' })
      .where(eq(transactions.id, transactionId));
  }

  async createTransactions(inputs: NewTransactionInput[]): Promise<Transaction[]> {
    if (inputs.length === 0) return [];
    const now = new Date();
    const rows = await this.db
      .insert(transactions)
      .values(
        inputs.map((input) => ({
          dispatchId: input.dispatchId,
          callIndex: input.callIndex,
          chain: input.chain,
          signedBytes: input.signedBytes,
          hash: input.hash,
          broadcastAt: now,
          lastBroadcastAt: now,
        })),
      )
      .returning();
    return rows.map(toTransaction);
  }

  async listUnsettledTransactions(chain: Chain): Promise<Transaction[]> {
    const rows = await this.db.query.transactions.findMany({
      where: and(
        eq(transactions.chain, chain),
        inArray(transactions.status, ['PENDING', 'REPLACED']),
      ),
    });
    return rows.map(toTransaction);
  }

  async touchClaims(dispatchIds: string[]): Promise<void> {
    if (dispatchIds.length === 0) return;
    await this.db
      .update(dispatches)
      .set({ claimedAt: new Date() })
      .where(inArray(dispatches.id, dispatchIds));
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
        failedAt: new Date(),
      })
      .returning();

    if (!row) {
      throw new Error('Failed to record Call failure');
    }

    return toTransaction(row);
  }

  async recordBroadcast(transactionId: string, hash: string, error?: DispatchError): Promise<void> {
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
      await tx.insert(attempts).values({ transactionId, error: error ?? null });
      await tx
        .update(transactions)
        .set({ lastBroadcastAt: new Date() })
        .where(eq(transactions.id, transactionId));
    });
  }

  async markAbandoned(transactionId: string, error?: DispatchError): Promise<void> {
    await this.db
      .update(transactions)
      .set({ status: 'ABANDONED', abandonedAt: new Date(), ...(error ? { error } : {}) })
      .where(eq(transactions.id, transactionId));
  }

  async markFailed(transactionId: string, error: DispatchError): Promise<void> {
    await this.db
      .update(transactions)
      .set({ status: 'FAILED', error, failedAt: new Date() })
      .where(eq(transactions.id, transactionId));
  }

  async markConfirmed(transactionId: string): Promise<void> {
    await this.db
      .update(transactions)
      .set({ status: 'CONFIRMED', confirmedAt: new Date() })
      .where(eq(transactions.id, transactionId));
  }

  async reopenTransaction(transactionId: string): Promise<void> {
    await this.db
      .update(transactions)
      .set({ status: 'PENDING', confirmedAt: null })
      .where(eq(transactions.id, transactionId));
  }

  async noteUnproposed(inputs: NewUnproposedInput[]): Promise<Transaction[]> {
    if (inputs.length === 0) return [];
    return this.db.transaction(async (tx) => {
      const noted: Transaction[] = [];
      for (const input of inputs) {
        const existing = await tx.query.transactions.findFirst({
          where: and(
            eq(transactions.dispatchId, input.dispatchId),
            eq(transactions.callIndex, input.callIndex),
          ),
        });
        if (existing) {
          noted.push(toTransaction(existing));
          continue;
        }
        const [row] = await tx
          .insert(transactions)
          .values({
            dispatchId: input.dispatchId,
            callIndex: input.callIndex,
            chain: input.chain,
            status: 'UNPROPOSED',
          })
          .returning();
        if (!row) throw new Error('Failed to note an UNPROPOSED Transaction');
        noted.push(toTransaction(row));
      }
      return noted;
    });
  }

  async listUnproposed(
    chain: Chain,
    limit: number,
    senderAddress?: string,
  ): Promise<Transaction[]> {
    const rows = await this.db
      .select({ transaction: transactions })
      .from(transactions)
      .innerJoin(dispatches, eq(dispatches.id, transactions.dispatchId))
      .where(
        and(
          eq(transactions.status, 'UNPROPOSED'),
          eq(transactions.chain, chain),
          senderAddress === undefined ? undefined : eq(dispatches.senderAddress, senderAddress),
        ),
      )
      .orderBy(dispatches.createdAt, dispatches.id, transactions.callIndex)
      .limit(limit);
    return rows.map((row) => toTransaction(row.transaction));
  }

  async createProposal(input: NewProposalInput): Promise<Proposal> {
    const { transactionIds, ...fields } = input;
    if (transactionIds.length === 0) throw new Error('A Proposal needs at least one Transaction');
    if (new Set(transactionIds).size !== transactionIds.length) {
      throw new Error('A Proposal cannot hold the same Transaction twice');
    }
    return this.db.transaction(async (tx) => {
      const rows = await tx
        .select()
        .from(transactions)
        .where(inArray(transactions.id, transactionIds))
        .for('update');
      if (rows.length !== transactionIds.length) {
        throw new Error('A Proposal names a Transaction that does not exist');
      }
      for (const row of rows) {
        if (row.status !== 'UNPROPOSED') {
          throw new Error(`Transaction ${row.id} is ${row.status}, not UNPROPOSED`);
        }
        if (row.dispatchId !== input.dispatchId || row.chain !== input.chain) {
          throw new Error(
            `Transaction ${row.id} is not of Dispatch ${input.dispatchId} on ${input.chain}: a Proposal never mixes Dispatches`,
          );
        }
      }

      const [proposalRow] = await tx
        .insert(proposals)
        .values({
          ...fields,
          phase: 'noted',
          approvalState: 'awaiting',
          approvals: 0,
        })
        .returning();
      if (!proposalRow) throw new Error('Failed to create Proposal');

      for (const [position, id] of transactionIds.entries()) {
        await tx
          .update(transactions)
          .set({
            status: 'AWAITING_APPROVAL',
            proposalId: proposalRow.id,
            proposalPosition: position,
          })
          .where(eq(transactions.id, id));
      }
      return toProposal(proposalRow);
    });
  }

  async getProposal(id: string): Promise<Proposal | null> {
    const row = await this.db.query.proposals.findFirst({ where: eq(proposals.id, id) });
    return row ? toProposal(row) : null;
  }

  async countOpenProposals(chain: Chain, senderAddress: string): Promise<number> {
    const [row] = await this.db
      .select({ count: sql<number>`count(*)::int` })
      .from(proposals)
      .where(
        and(
          eq(proposals.chain, chain),
          eq(proposals.senderAddress, senderAddress),
          inArray(proposals.phase, ['noted', 'open', 'executing']),
        ),
      );
    return row?.count ?? 0;
  }

  async highestConfirmedSequence(chain: Chain, senderAddress: string): Promise<number | null> {
    const [row] = await this.db
      .select({ highest: sql<number | null>`max(${proposals.sequence})::float8` })
      .from(proposals)
      .where(
        and(
          eq(proposals.chain, chain),
          eq(proposals.senderAddress, senderAddress),
          sql`exists (select 1 from ${transactions} where ${transactions.proposalId} = ${proposals.id} and ${transactions.status} = 'CONFIRMED')`,
        ),
      );
    return row?.highest ?? null;
  }

  async hasNotedProposal(chain: Chain, senderAddress: string): Promise<boolean> {
    const row = await this.db.query.proposals.findFirst({
      columns: { id: true },
      where: and(
        eq(proposals.chain, chain),
        eq(proposals.senderAddress, senderAddress),
        eq(proposals.phase, 'noted'),
      ),
    });
    return row !== undefined;
  }

  async listProposalsDue(chains: ChainScope, now: Date, limit: number): Promise<Proposal[]> {
    const rows = await this.db.query.proposals.findMany({
      where: and(
        ne(proposals.phase, 'resolved'),
        inArray(proposals.chain, chains),
        lte(proposals.nextCheckAt, now),
      ),
      orderBy: [proposals.nextCheckAt, proposals.createdAt],
      limit,
    });
    return rows.map(toProposal);
  }

  async listProposalsAwaitingClose(chains: ChainScope, limit: number): Promise<Proposal[]> {
    const rows = await this.db.query.proposals.findMany({
      where: and(eq(proposals.closeState, 'pending'), inArray(proposals.chain, chains)),
      orderBy: [proposals.createdAt, proposals.id],
      limit,
    });
    return rows.map(toProposal);
  }

  async listProposalCalls(proposalId: string): Promise<Transaction[]> {
    return this.currentProposalCalls(this.db, proposalId);
  }

  async updateProposal(id: string, patch: ProposalPatch): Promise<Proposal> {
    const defined = Object.fromEntries(Object.entries(patch).filter(([, v]) => v !== undefined));
    const [row] =
      Object.keys(defined).length === 0
        ? await this.db.select().from(proposals).where(eq(proposals.id, id))
        : await this.db.update(proposals).set(defined).where(eq(proposals.id, id)).returning();
    if (!row) throw new Error(`Unknown proposal: ${id}`);
    return toProposal(row);
  }

  async markProposalExecuting(
    proposalId: string,
    signedBytes: string,
    hash: string,
  ): Promise<Transaction[]> {
    return this.db.transaction(async (tx) => {
      const calls = await this.currentProposalCalls(tx, proposalId, true);
      if (calls.length === 0 || calls.some((c) => c.status !== 'AWAITING_APPROVAL')) {
        throw new Error(`Proposal ${proposalId} has Calls that are not AWAITING_APPROVAL`);
      }
      const now = new Date();
      await tx.update(proposals).set({ phase: 'executing' }).where(eq(proposals.id, proposalId));
      const rows = await tx
        .update(transactions)
        .set({
          status: 'PENDING',
          hash,
          signedBytes,
          broadcastAt: now,
          lastBroadcastAt: now,
          sentAt: null,
        })
        .where(
          inArray(
            transactions.id,
            calls.map((c) => c.id),
          ),
        )
        .returning();
      return rows.map(toTransaction).sort(byPosition);
    });
  }

  async reopenProposalForExecution(proposalId: string): Promise<Transaction[]> {
    return this.db.transaction(async (tx) => {
      const calls = await this.currentProposalCalls(tx, proposalId, true);
      if (
        calls.length === 0 ||
        calls.some((c) => c.status !== 'FAILED' && c.status !== 'PENDING')
      ) {
        throw new Error(`Proposal ${proposalId} has Calls that are neither PENDING nor FAILED`);
      }
      await tx
        .update(proposals)
        .set({ phase: 'open', nextCheckAt: new Date() })
        .where(eq(proposals.id, proposalId));
      const rows = await tx
        .update(transactions)
        .set({
          status: 'AWAITING_APPROVAL',
          hash: null,
          signedBytes: null,
          error: null,
          failedAt: null,
          broadcastAt: null,
          lastBroadcastAt: null,
          sentAt: null,
        })
        .where(
          inArray(
            transactions.id,
            calls.map((c) => c.id),
          ),
        )
        .returning();
      return rows.map(toTransaction).sort(byPosition);
    });
  }

  async settleProposal(proposalId: string, outcome: ProposalOutcome): Promise<Transaction[]> {
    return this.db.transaction(async (tx) => {
      const proposal = await tx.query.proposals.findFirst({ where: eq(proposals.id, proposalId) });
      if (!proposal) throw new Error(`Unknown proposal: ${proposalId}`);
      const calls = await this.currentProposalCalls(tx, proposalId, true);
      const now = new Date();
      await tx
        .update(proposals)
        .set(
          outcome.status === 'ABANDONED'
            ? { phase: 'timed_out', timedOutAt: now }
            : { phase: 'resolved', resolvedAt: now },
        )
        .where(eq(proposals.id, proposalId));
      if (calls.length === 0) return [];
      const rows = await tx
        .update(transactions)
        .set({
          status: outcome.status,
          error: outcome.error ?? null,
          ...(outcome.hash === undefined ? {} : { hash: outcome.hash }),
          // A timed-out Proposal's Calls carry no execute: a failed attempt's hash must not feed the ABANDONED re-watch.
          ...(outcome.status === 'ABANDONED' && outcome.hash === undefined
            ? { hash: null, signedBytes: null }
            : {}),
          ...(outcome.status === 'CONFIRMED' ? { confirmedAt: now } : {}),
          ...(outcome.status === 'FAILED' ? { failedAt: now } : {}),
          ...(outcome.status === 'ABANDONED' ? { abandonedAt: now } : {}),
        })
        .where(
          inArray(
            transactions.id,
            calls.map((c) => c.id),
          ),
        )
        .returning();
      return rows.map(toTransaction).sort(byPosition);
    });
  }

  async listCommitted(
    chain: Chain,
    holder: CommittedHolder,
    timedOutSince: Date,
    senderAddress?: string,
  ): Promise<AssetAmount[]> {
    const rows = await this.db.query.proposals.findMany({
      where: and(
        eq(proposals.chain, chain),
        senderAddress === undefined ? undefined : eq(proposals.senderAddress, senderAddress),
        or(
          inArray(proposals.phase, ['noted', 'open', 'executing']),
          and(eq(proposals.phase, 'timed_out'), gte(proposals.timedOutAt, timedOutSince)),
        ),
      ),
    });
    const unproposed =
      holder === 'sender'
        ? await this.db
            .select({ callIndex: transactions.callIndex, items: dispatches.items })
            .from(transactions)
            .innerJoin(dispatches, eq(dispatches.id, transactions.dispatchId))
            .where(
              and(
                eq(transactions.status, 'UNPROPOSED'),
                eq(transactions.chain, chain),
                senderAddress === undefined
                  ? undefined
                  : eq(dispatches.senderAddress, senderAddress),
              ),
            )
        : [];
    return totalCommitted(
      holder,
      rows.map(toProposal),
      unproposed.map((row) => row.items[row.callIndex]?.payment ?? null),
    );
  }

  async listProposalsForDispatch(dispatchId: string): Promise<Proposal[]> {
    const rows = await this.db.query.proposals.findMany({
      where: eq(proposals.dispatchId, dispatchId),
      orderBy: [proposals.createdAt, proposals.id],
    });
    return rows.map(toProposal);
  }

  async recordSignerKey(record: SignerKeyRecord): Promise<void> {
    const row = {
      pins: 'pins' in record.read ? record.read.pins : null,
      error: 'error' in record.read ? record.read.error : null,
      readAt: record.readAt,
    };
    await this.db
      .insert(signerKeys)
      .values({ chain: record.chain, address: record.address, ...row })
      .onConflictDoUpdate({ target: [signerKeys.chain, signerKeys.address], set: row });
  }

  async getSignerKey(chain: Chain, address: string): Promise<SignerKeyRecord | null> {
    const [row] = await this.db
      .select()
      .from(signerKeys)
      .where(and(eq(signerKeys.chain, chain), eq(signerKeys.address, address)));
    if (!row) return null;
    return {
      chain,
      address,
      read: row.pins ? { pins: row.pins } : { error: row.error ?? 'no read recorded' },
      readAt: row.readAt,
    };
  }

  async recordSetupChecks(records: readonly SetupCheckRecord[]): Promise<void> {
    const rows = records.map(({ id, area, title, chain, result, ranAt }) => ({
      id,
      area,
      title,
      chain: chain ?? null,
      status: result.status,
      finding: result.finding,
      fix: result.status === 'pass' ? null : result.fix,
      ranAt,
    }));
    await this.db.transaction(async (tx) => {
      await tx.delete(setupChecks).where(
        rows.length > 0
          ? notInArray(
              setupChecks.id,
              rows.map((row) => row.id),
            )
          : undefined,
      );
      if (rows.length === 0) return;
      await tx
        .insert(setupChecks)
        .values(rows)
        .onConflictDoUpdate({
          target: setupChecks.id,
          set: {
            area: sql`excluded.area`,
            title: sql`excluded.title`,
            chain: sql`excluded.chain`,
            status: sql`excluded.status`,
            finding: sql`excluded.finding`,
            fix: sql`excluded.fix`,
            ranAt: sql`excluded.ran_at`,
          },
        });
    });
  }

  async listSetupChecks(): Promise<SetupCheckRecord[]> {
    const rows = await this.db.select().from(setupChecks).orderBy(setupChecks.id);
    return rows.map((row) => ({
      id: row.id,
      area: row.area as Area,
      title: row.title,
      ...(row.chain ? { chain: row.chain as Chain } : {}),
      // The table's check constraint keeps `fix` null exactly when the check passed.
      result:
        row.fix === null
          ? { status: 'pass', finding: row.finding }
          : { status: row.status as 'warn' | 'fail', finding: row.finding, fix: row.fix },
      ranAt: row.ranAt,
    }));
  }

  /** A Proposal's Calls in position order, one per Call (never a REPLACED or DROPPED version). `lock` takes row locks, inside a transaction. */
  private async currentProposalCalls(
    db: Pick<Database, 'select'>,
    proposalId: string,
    lock = false,
  ): Promise<Transaction[]> {
    const query = db
      .select()
      .from(transactions)
      .where(
        and(
          eq(transactions.proposalId, proposalId),
          notInArray(transactions.status, ['REPLACED', 'DROPPED']),
        ),
      )
      .orderBy(transactions.proposalPosition);
    const rows = await (lock ? query.for('update') : query);
    return rows.map(toTransaction);
  }

  async createRelayDispatch<C extends Chain>(
    input: NewRelayDispatchInput<C>,
  ): Promise<RelayDispatch<C>> {
    const inserted = await this.db
      .insert(relayDispatches)
      .values({
        chain: input.chain,
        idempotencyKey: input.idempotencyKey,
        signedTransaction: input.signedTransaction,
      })
      .onConflictDoNothing({ target: relayDispatches.idempotencyKey })
      .returning();

    const row =
      inserted[0] ??
      (await this.db.query.relayDispatches.findFirst({
        where: eq(relayDispatches.idempotencyKey, input.idempotencyKey),
      }));

    if (!row) {
      throw new Error(
        `Failed to create or find RelayDispatch for idempotencyKey ${input.idempotencyKey}`,
      );
    }

    return toRelayDispatch(row) as RelayDispatch<C>;
  }

  async getRelayDispatch(id: string): Promise<RelayDispatch | null> {
    const row = await this.db.query.relayDispatches.findFirst({
      where: eq(relayDispatches.id, id),
    });
    return row ? toRelayDispatch(row) : null;
  }

  async listDispatches(query: DispatchListQuery): Promise<ListedDispatch[]> {
    const { after } = query;
    const where = (table: typeof dispatches | typeof relayDispatches) =>
      and(
        query.chain ? eq(table.chain, query.chain) : undefined,
        query.storedStatuses ? inArray(table.status, [...query.storedStatuses]) : undefined,
        query.from ? gte(table.createdAt, query.from) : undefined,
        query.to ? lt(table.createdAt, query.to) : undefined,
        after
          ? sql`(${table.createdAt}, ${table.id}) < (${after.createdAt}::timestamptz, ${after.id}::uuid)`
          : undefined,
      );
    // Microseconds, which a Date would drop: a cursor rounded to the millisecond could repeat its own row.
    const exactCreatedAt = (table: typeof dispatches | typeof relayDispatches) =>
      sql<string>`to_char(${table.createdAt} at time zone 'UTC', 'YYYY-MM-DD"T"HH24:MI:SS.US"Z"')`;

    const [managed, relay] = await Promise.all([
      query.mode === 'relay'
        ? []
        : this.db
            .select({ row: dispatches, exactCreatedAt: exactCreatedAt(dispatches) })
            .from(dispatches)
            .where(
              and(
                where(dispatches),
                query.senders
                  ? or(
                      ...query.senders.map((s) =>
                        and(eq(dispatches.chain, s.chain), eq(dispatches.senderAddress, s.address)),
                      ),
                    )
                  : undefined,
              ),
            )
            .orderBy(desc(dispatches.createdAt), desc(dispatches.id))
            .limit(query.limit),
      query.mode === 'managed' || query.senders
        ? []
        : this.db
            .select({ row: relayDispatches, exactCreatedAt: exactCreatedAt(relayDispatches) })
            .from(relayDispatches)
            .where(where(relayDispatches))
            .orderBy(desc(relayDispatches.createdAt), desc(relayDispatches.id))
            .limit(query.limit),
    ]);
    const listed = [
      ...managed.map(({ row, exactCreatedAt }) => ({
        mode: 'managed' as const,
        dispatch: toDispatch(row),
        cursor: { createdAt: exactCreatedAt, id: row.id },
      })),
      ...relay.map(({ row, exactCreatedAt }) => ({
        mode: 'relay' as const,
        dispatch: toRelayDispatch(row),
        cursor: { createdAt: exactCreatedAt, id: row.id },
      })),
    ]
      .sort((a, b) => compareNewestFirst(a.cursor, b.cursor))
      .slice(0, query.limit);
    if (listed.length === 0) return [];

    const rows = await this.db.query.transactions.findMany({
      where: inArray(
        transactions.dispatchId,
        listed.map((l) => l.dispatch.id),
      ),
      orderBy: transactions.callIndex,
    });
    const byDispatch = new Map<string, Transaction[]>();
    for (const row of rows) {
      byDispatch.set(row.dispatchId, [
        ...(byDispatch.get(row.dispatchId) ?? []),
        toTransaction(row),
      ]);
    }
    return listed.map((l) => ({ ...l, transactions: byDispatch.get(l.dispatch.id) ?? [] }));
  }

  async claimQueuedRelayDispatches(chains: ChainScope, limit: number): Promise<RelayDispatch[]> {
    return this.db.transaction(async (tx) => {
      const claimable = await tx
        .select({ id: relayDispatches.id })
        .from(relayDispatches)
        .where(and(eq(relayDispatches.status, 'queued'), inArray(relayDispatches.chain, chains)))
        .orderBy(relayDispatches.createdAt)
        .limit(limit)
        .for('update', { skipLocked: true });

      if (claimable.length === 0) return [];

      const now = new Date();
      const rows = await tx
        .update(relayDispatches)
        .set({ status: 'broadcasting', claimedAt: now, firstClaimedAt: now })
        .where(
          inArray(
            relayDispatches.id,
            claimable.map((row) => row.id),
          ),
        )
        .returning();

      return rows.map(toRelayDispatch);
    });
  }

  async setRelayDispatchTransaction(relayDispatchId: string, transactionId: string): Promise<void> {
    await this.db
      .update(relayDispatches)
      .set({ transactionId })
      .where(eq(relayDispatches.id, relayDispatchId));
  }
}
