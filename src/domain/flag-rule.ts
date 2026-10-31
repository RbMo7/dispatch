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
