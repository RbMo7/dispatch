import type { DispatchItem } from './call.js';
import type { Chain } from './chain.js';
import type { SenderAddress } from './sender.js';

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
  /** #149: the one Sender the rule applies to, by address (its identity, ADR-0060); null for every Sender on `chain`. */
  senderAddress: SenderAddress | null;
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

/** ADR-0058: why a Dispatch is held, and the release that let it go ahead, if any. */
export type Hold = {
  dispatchId: string;
  matched: RuleMatch[];
  heldAt: Date;
  release: { at: Date; reason: string } | null;
};

/** What a rule is checked against: a Managed Dispatch about to be stored, or one already stored in a preview. */
export type HoldCandidate = {
  chain: Chain;
  senderAddress: SenderAddress | null;
  items: readonly DispatchItem[];
};

/** #149: a rule scoped to a Sender applies only to that Sender's Dispatches; an unscoped one to its whole chain. */
export function appliesTo(
  rule: Pick<FlagRuleSpec, 'chain' | 'senderAddress'>,
  candidate: HoldCandidate,
): boolean {
  return (
    rule.chain === candidate.chain &&
    (rule.senderAddress === null || rule.senderAddress === candidate.senderAddress)
  );
}

/** What matching needs from the database, read before the Dispatch is stored. */
export type FlagRuleFacts = {
  /** Recipients, by `addressKey`, with a confirmed payment from this engine on the chain. */
  confirmedRecipients: ReadonlySet<string>;
  /** Per asset, in its smallest unit: payments in Managed Dispatches on the chain accepted in the last 24 hours and not cancelled. */
  acceptedVolume: ReadonlyMap<string, bigint>;
  /** The same, from the candidate's own Sender only: what a rule scoped to it counts (#149). */
  senderVolume: ReadonlyMap<string, bigint>;
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
  rule: FlagRuleVersion,
  { chain, items }: HoldCandidate,
  facts: FlagRuleFacts,
): number[] {
  const { definition } = rule;
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
      const volume = rule.senderAddress === null ? facts.acceptedVolume : facts.senderVolume;
      const before = volume.get(definition.asset) ?? 0n;
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
 * asset's smallest unit. `rules` are enabled current versions; only those
 * that apply to the candidate's chain and Sender are checked (#149).
 */
export function matchFlagRules(
  candidate: HoldCandidate,
  rules: readonly FlagRuleVersion[],
  facts: FlagRuleFacts,
): RuleMatch[] {
  return rules.flatMap((rule) => {
    if (!appliesTo(rule, candidate)) return [];
    const matched = matchingItems(rule, candidate, facts);
    return matched.length > 0 ? [{ rule, items: matched }] : [];
  });
}

/** The database reads `matchFlagRules` needs for this candidate, and no more. */
export function factsNeeded(
  candidate: HoldCandidate,
  rules: readonly FlagRuleVersion[],
): { recipients: string[]; chainAssets: string[]; senderAssets: string[] } {
  const payments = paymentsOf(candidate.items);
  const applying = rules.filter((rule) => appliesTo(rule, candidate));
  const recipients = applying.some((r) => r.definition.kind === 'first_time_recipient')
    ? [...new Set(payments.map((p) => addressKey(candidate.chain, p.recipient)))]
    : [];
  const volumeAssets = (scoped: boolean) => [
    ...new Set(
      applying.flatMap(({ definition: d, senderAddress }) =>
        d.kind === 'daily_volume_over' &&
        (senderAddress !== null) === scoped &&
        payments.some((p) => p.asset === d.asset)
          ? [d.asset]
          : [],
      ),
    ),
  ];
  return { recipients, chainAssets: volumeAssets(false), senderAssets: volumeAssets(true) };
}
