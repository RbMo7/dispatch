import type { DispatchItem } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import {
  DAILY_VOLUME_WINDOW_MS,
  factsNeeded,
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
