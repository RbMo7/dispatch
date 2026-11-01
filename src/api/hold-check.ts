import type { DispatchItem } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch } from '../domain/dispatch.js';
import {
  DAILY_VOLUME_WINDOW_MS,
  factsNeeded,
  type FlagRuleDefinition,
  type FlagRuleFacts,
  type FlagRuleVersion,
  matchFlagRules,
  type RuleMatch,
} from '../domain/flag-rule.js';
import type { DispatchStore } from '../repository/dispatch-store.js';

/**
 * ADR-0058: the Flag Rules a Managed Dispatch about to be stored matches.
 * Database reads only, batched, and none at all on a chain with no
 * enabled rules: the ingest path makes no RPC call (ADR-0024).
 */
export async function findHoldMatches(
  store: DispatchStore,
  chain: Chain,
  items: readonly DispatchItem[],
  now: Date,
): Promise<RuleMatch[]> {
  const rules = await store.listEnabledFlagRules(chain);
  if (rules.length === 0) return [];
  const { recipients, assets } = factsNeeded(chain, items, rules);
  const [confirmed, acceptedVolume] = await Promise.all([
    store.firstConfirmedPayments(chain, recipients),
    store.acceptedVolume(chain, assets, new Date(now.getTime() - DAILY_VOLUME_WINDOW_MS)),
  ]);
  return matchFlagRules(chain, items, rules, {
    confirmedRecipients: new Set(confirmed.keys()),
    acceptedVolume,
  });
}

export const PREVIEW_WINDOW_MS = 30 * DAILY_VOLUME_WINDOW_MS;
/** The most Dispatches one preview reads, the 24 hours before the window included. */
export const PREVIEW_ROW_CAP = 2000;
const PREVIEW_EXAMPLES = 10;
/** Recipients per read, well under Postgres's limit on bound parameters. */
const RECIPIENT_BATCH = 5000;

/**
 * The facts `findHoldMatches` would have read when `dispatch` was submitted,
 * rebuilt from `history`: confirmations before it, and the Dispatches of the
 * 24 hours before it that were not yet cancelled then.
 */
function factsAt(
  dispatch: Dispatch,
  rule: FlagRuleVersion,
  history: readonly Dispatch[],
  firstConfirmed: ReadonlyMap<string, Date>,
): FlagRuleFacts {
  const at = dispatch.createdAt;
  const { recipients, assets } = factsNeeded(dispatch.chain, dispatch.items, [rule]);
  const acceptedVolume = new Map<string, bigint>();
  for (const earlier of history) {
    const inWindow =
      earlier.createdAt < at &&
      at.getTime() - earlier.createdAt.getTime() <= DAILY_VOLUME_WINDOW_MS;
    if (!inWindow || (earlier.cancelledAt && earlier.cancelledAt <= at)) continue;
    for (const { payment } of earlier.items) {
      if (!payment || !assets.includes(payment.asset)) continue;
      acceptedVolume.set(
        payment.asset,
        (acceptedVolume.get(payment.asset) ?? 0n) + BigInt(payment.amount),
      );
    }
  }
  return {
    confirmedRecipients: new Set(
      recipients.filter((key) => (firstConfirmed.get(key)?.getTime() ?? Infinity) < at.getTime()),
    ),
    acceptedVolume,
  };
}

/**
 * #119: how many of the last 30 days' Managed Dispatches on `chain` an unsaved
 * rule would have held, run through the same matcher as `findHoldMatches`
 * against each Dispatch as it was submitted.
 */
export async function previewFlagRule(
  store: DispatchStore,
  chain: Chain,
  definition: FlagRuleDefinition,
  now: Date,
) {
  const from = new Date(now.getTime() - PREVIEW_WINDOW_MS);
  const rows = await store.listManagedDispatchesSince(
    chain,
    new Date(from.getTime() - DAILY_VOLUME_WINDOW_MS),
    PREVIEW_ROW_CAP + 1,
  );
  const history = rows.slice(0, PREVIEW_ROW_CAP);
  const rule: FlagRuleVersion = {
    ruleId: 'preview',
    version: 0,
    name: 'preview',
    chain,
    enabled: true,
    definition,
    createdAt: now,
  };
  const candidates = history.filter((d) => d.createdAt >= from);

  const recipients = [
    ...new Set(candidates.flatMap((d) => factsNeeded(chain, d.items, [rule]).recipients)),
  ];
  const firstConfirmed = new Map<string, Date>();
  for (let i = 0; i < recipients.length; i += RECIPIENT_BATCH) {
    const batch = recipients.slice(i, i + RECIPIENT_BATCH);
    for (const [key, at] of await store.firstConfirmedPayments(chain, batch)) {
      firstConfirmed.set(key, at);
    }
  }

  const held = candidates.flatMap((dispatch) => {
    const facts = factsAt(dispatch, rule, history, firstConfirmed);
    const [match] = matchFlagRules(chain, dispatch.items, [rule], facts);
    return match ? [{ dispatch, items: match.items }] : [];
  });
  return {
    from: from.toISOString(),
    to: now.toISOString(),
    scanned: candidates.length,
    capped: rows.length > PREVIEW_ROW_CAP,
    wouldHold: held.length,
    examples: held.slice(0, PREVIEW_EXAMPLES).map(({ dispatch, items }) => ({
      dispatchId: dispatch.id,
      createdAt: dispatch.createdAt.toISOString(),
      items,
    })),
  };
}
