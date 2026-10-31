import type { DispatchItem } from './call.js';
import type { Chain } from './chain.js';

/**
 * A limit on one asset (ADR-0058). `limit` is what the operator wrote, in
 * whole units ("5000"); `limitUnits` is the same in the asset's smallest
 * unit, converted once when the rule was saved, and what amounts compare to.
 */
export type AssetLimit = { asset: string; limit: string; limitUnits: bigint };

/** What a Flag Rule checks: each kind carries exactly its own parameters (`.scratch/flag-rules/spec.md`). */
export type FlagRuleDefinition =
  | ({ kind: 'item_over' } & AssetLimit)
  | ({ kind: 'dispatch_total_over' } & AssetLimit)
  | ({ kind: 'daily_volume_over' } & AssetLimit)
  | { kind: 'first_time_recipient' }
  | { kind: 'recipient_not_allowlisted'; addresses: string[] }
  | { kind: 'call_target_not_allowlisted'; addresses: string[] };

export type FlagRuleKind = FlagRuleDefinition['kind'];

/** bigint has no JSON form, so a stored definition keeps `limitUnits` as a decimal string. */
export type FlagRuleDefinitionJson = FlagRuleDefinition extends infer D
  ? D extends { limitUnits: bigint }
    ? Omit<D, 'limitUnits'> & { limitUnits: string }
    : D
  : never;

export function definitionToJson(definition: FlagRuleDefinition): FlagRuleDefinitionJson {
  return 'limitUnits' in definition
    ? { ...definition, limitUnits: definition.limitUnits.toString() }
    : definition;
}

export function definitionFromJson(json: FlagRuleDefinitionJson): FlagRuleDefinition {
  return 'limitUnits' in json ? { ...json, limitUnits: BigInt(json.limitUnits) } : json;
}

/** One version's whole content, as an operator writes it. */
export type FlagRuleSpec = {
  name: string;
  chain: Chain;
  enabled: boolean;
  definition: FlagRuleDefinition;
};

/** ADR-0058: immutable once written; an edit writes the next version. */
export type FlagRuleVersion = FlagRuleSpec & { ruleId: string; version: number; createdAt: Date };

export type FlagRule = {
  id: string;
  createdAt: Date;
  /** A deleted rule matches nothing and is no longer listed, but keeps its history. */
  deletedAt: Date | null;
  current: FlagRuleVersion;
  /** Oldest first; the last is `current`. */
  versions: FlagRuleVersion[];
};

/** A rule version that matched, and the positions of the items it matched. */
export type RuleMatch = { rule: FlagRuleVersion; items: number[] };

/** ADR-0058: why a Dispatch is held. */
export type Hold = {
  dispatchId: string;
  matched: RuleMatch[];
  heldAt: Date;
};

/** What matching needs from the database, read before the Dispatch is stored. */
export type FlagRuleFacts = {
  /** Recipients, by `addressKey`, with a confirmed payment from this engine on the chain. */
  confirmedRecipients: ReadonlySet<string>;
  /** Per asset, in its smallest unit: payments in Managed Dispatches accepted in the last 24 hours and not cancelled. */
  acceptedVolume: ReadonlyMap<string, bigint>;
};

export const DAILY_VOLUME_WINDOW_MS = 24 * 60 * 60 * 1000;

/** How an address is compared: Base addresses ignore case, Solana's are exact. */
export function addressKey(chain: Chain, address: string): string {
  return chain === 'base' ? address.toLowerCase() : address;
}

type PaymentAt = { index: number; recipient: string; asset: string; units: bigint };

function paymentsOf(items: readonly DispatchItem[]): PaymentAt[] {
  return items.flatMap(({ payment }, index) =>
    payment ? [{ index, ...payment, units: BigInt(payment.amount) }] : [],
  );
}

function callTargetsOf(items: readonly DispatchItem[]): { index: number; target: string }[] {
  return items.flatMap(({ call, payment }, index) =>
    payment ? [] : [{ index, target: 'to' in call ? call.to : call.programId }],
  );
}

const sum = (payments: PaymentAt[]) => payments.reduce((total, p) => total + p.units, 0n);
const indices = (matched: { index: number }[]) => matched.map((m) => m.index);

function matchingItems(
  chain: Chain,
  definition: FlagRuleDefinition,
  items: readonly DispatchItem[],
  facts: FlagRuleFacts,
): number[] {
  const payments = paymentsOf(items);
  switch (definition.kind) {
    case 'item_over':
      return indices(
        payments.filter((p) => p.asset === definition.asset && p.units > definition.limitUnits),
      );
    case 'dispatch_total_over': {
      const ofAsset = payments.filter((p) => p.asset === definition.asset);
      return sum(ofAsset) > definition.limitUnits ? indices(ofAsset) : [];
    }
    case 'daily_volume_over': {
      const ofAsset = payments.filter((p) => p.asset === definition.asset);
      const before = facts.acceptedVolume.get(definition.asset) ?? 0n;
      return ofAsset.length > 0 && before + sum(ofAsset) > definition.limitUnits
        ? indices(ofAsset)
        : [];
    }
    case 'first_time_recipient':
      return indices(
        payments.filter((p) => !facts.confirmedRecipients.has(addressKey(chain, p.recipient))),
      );
    case 'recipient_not_allowlisted': {
      const allowed = new Set(definition.addresses.map((a) => addressKey(chain, a)));
      return indices(payments.filter((p) => !allowed.has(addressKey(chain, p.recipient))));
    }
    case 'call_target_not_allowlisted': {
      const allowed = new Set(definition.addresses.map((a) => addressKey(chain, a)));
      return indices(callTargetsOf(items).filter((c) => !allowed.has(addressKey(chain, c.target))));
    }
  }
}

/**
 * ADR-0058: every enabled rule version a Managed Dispatch's items match,
 * each with every item it matched. Amounts compare as integers in the
 * asset's smallest unit. `rules` are the chain's enabled current versions.
 */
export function matchFlagRules(
  chain: Chain,
  items: readonly DispatchItem[],
  rules: readonly FlagRuleVersion[],
  facts: FlagRuleFacts,
): RuleMatch[] {
  return rules.flatMap((rule) => {
    const matched = matchingItems(chain, rule.definition, items, facts);
    return matched.length > 0 ? [{ rule, items: matched }] : [];
  });
}

/** The database reads `matchFlagRules` needs for these items, and no more. */
export function factsNeeded(
  chain: Chain,
  items: readonly DispatchItem[],
  rules: readonly FlagRuleVersion[],
): { recipients: string[]; assets: string[] } {
  const payments = paymentsOf(items);
  const definitions = rules.map((r) => r.definition);
  const recipients = definitions.some((d) => d.kind === 'first_time_recipient')
    ? [...new Set(payments.map((p) => addressKey(chain, p.recipient)))]
    : [];
  const assets = definitions.flatMap((d) =>
    d.kind === 'daily_volume_over' && payments.some((p) => p.asset === d.asset) ? [d.asset] : [],
  );
  return { recipients, assets: [...new Set(assets)] };
}
