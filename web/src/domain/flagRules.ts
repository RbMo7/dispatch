import type { Chain } from './chains';
import type { SenderRef } from './dispatch';

/** ADR-0057: which of the engine's two tokens a session signed in with. */
export type TokenKind = 'auth' | 'operator';

export type LimitKind = 'item_over' | 'dispatch_total_over' | 'daily_volume_over';
export type AllowlistKind = 'recipient_not_allowlisted' | 'call_target_not_allowlisted';
export type RuleKind = LimitKind | 'first_time_recipient' | AllowlistKind;

/** What a rule checks: each kind carries exactly its own parameters (docs/openapi.yaml). */
export type RuleCheck =
  | { kind: LimitKind; asset: string; limit: string }
  | { kind: 'first_time_recipient' }
  | { kind: AllowlistKind; addresses: string[] };

/** Each kind's label in the editor, and which parameters it takes. */
export const RULE_KINDS: Record<RuleKind, { label: string; params: 'limit' | 'none' | 'list' }> = {
  item_over: { label: 'Payment over a limit', params: 'limit' },
  dispatch_total_over: { label: 'Dispatch total over a limit', params: 'limit' },
  daily_volume_over: { label: 'Daily volume over a limit', params: 'limit' },
  first_time_recipient: { label: 'First-time recipient', params: 'none' },
  recipient_not_allowlisted: { label: 'Recipient not on a list', params: 'list' },
  call_target_not_allowlisted: { label: 'Call target not on a list', params: 'list' },
};

export const RULE_KIND_NAMES = Object.keys(RULE_KINDS) as RuleKind[];

export interface RuleVersion {
  version: number;
  name: string;
  chain: Chain;
  /** The one Sender it checks, or null for every Sender on its chain. */
  sender: SenderRef | null;
  enabled: boolean;
  check: RuleCheck;
  /** When this version was written. */
  createdAt: Date;
}

export interface FlagRule {
  id: string;
  current: RuleVersion;
  /** When version 1 was written. */
  createdAt: Date;
  /** Oldest first; the last is `current`. */
  versions: RuleVersion[];
}

const whole = new Intl.NumberFormat('en-US');

/** "5000" as "5,000", "12.5" as "12.5": the operator's own precision, grouped. */
export function formatLimit(limit: string): string {
  const [int = '0', fraction] = limit.split('.');
  return `${whole.format(BigInt(int))}${fraction ? `.${fraction}` : ''}`;
}

/** A rule's condition as a sentence fragment, for rows, history and the Held pane. */
export function describeCheck(check: RuleCheck, chain: Chain): string {
  switch (check.kind) {
    case 'item_over':
      return `A payment over ${formatLimit(check.limit)} ${check.asset}`;
    case 'dispatch_total_over':
      return `A Dispatch paying over ${formatLimit(check.limit)} ${check.asset} in all`;
    case 'daily_volume_over':
      return `Over ${formatLimit(check.limit)} ${check.asset} in 24 hours`;
    case 'first_time_recipient':
      return 'A recipient never paid before';
    case 'recipient_not_allowlisted':
      return `A recipient not on a list of ${listSize(check.addresses.length)}`;
    case 'call_target_not_allowlisted':
      return `A call to a ${chain === 'solana' ? 'program' : 'contract'} not on a list of ${listSize(check.addresses.length)}`;
  }
}

function listSize(n: number): string {
  return n === 1 ? '1 address' : `${whole.format(n)} addresses`;
}

/** Why a Dispatch is held: each rule version that matched, with the items it matched. */
export interface HoldMatch {
  ruleId: string;
  ruleVersion: number;
  /** The rule as that version said when it matched. */
  name: string;
  check: RuleCheck;
  items: number[];
}

export interface Hold {
  matched: HoldMatch[];
  heldAt: Date;
  releasedAt: Date | null;
  reason: string | null;
}

/** Each item's position, with the names of the rules that matched it. */
export function matchedItems(hold: Hold): Map<number, string[]> {
  const byItem = new Map<number, string[]>();
  for (const match of hold.matched) {
    for (const index of match.items) {
      byItem.set(index, [...(byItem.get(index) ?? []), match.name]);
    }
  }
  return byItem;
}

/** What `POST /v1/flag-rules/preview` says a rule would have held. */
export interface Preview {
  from: Date;
  to: Date;
  scanned: number;
  capped: boolean;
  wouldHold: number;
  examples: { dispatchId: string; createdAt: Date; items: number[] }[];
}

export type ActionKind =
  | 'cancel'
  | 'release'
  | 'flag_rule_create'
  | 'flag_rule_update'
  | 'flag_rule_delete'
  | 'asset_add'
  | 'asset_disable'
  | 'asset_enable'
  | 'contract_add'
  | 'contract_disable'
  | 'contract_enable';

/** One entry of the activity record (ADR-0057). */
export interface OperatorAction {
  id: string;
  at: Date;
  action: ActionKind;
  /** The Dispatch, Flag Rule, Known Asset or registered contract acted on. */
  targetId: string;
  tokenKind: TokenKind;
  reason: string | null;
}

export const ACTIONS: Record<
  ActionKind,
  { label: string; target: 'dispatch' | 'rule' | 'asset' | 'contract' }
> = {
  cancel: { label: 'Cancelled', target: 'dispatch' },
  release: { label: 'Released', target: 'dispatch' },
  flag_rule_create: { label: 'Rule created', target: 'rule' },
  flag_rule_update: { label: 'Rule edited', target: 'rule' },
  flag_rule_delete: { label: 'Rule deleted', target: 'rule' },
  asset_add: { label: 'Asset added', target: 'asset' },
  asset_disable: { label: 'Asset disabled', target: 'asset' },
  asset_enable: { label: 'Asset enabled', target: 'asset' },
  contract_add: { label: 'Contract added', target: 'contract' },
  contract_disable: { label: 'Contract disabled', target: 'contract' },
  contract_enable: { label: 'Contract enabled', target: 'contract' },
};

/** The editor's fields, as typed: what the operator sees, before it is a request body. */
export interface RuleDraft {
  name: string;
  chain: Chain;
  /** A Sender's name, or null for every Sender on the chain. */
  sender: string | null;
  enabled: boolean;
  kind: RuleKind;
  asset: string;
  limit: string;
  /** One address per line. */
  addresses: string;
  reason: string;
}

export function draftOf(rule: FlagRule): RuleDraft {
  const { name, chain, sender, enabled, check } = rule.current;
  return {
    name,
    chain,
    // A Sender no longer configured has no name to send back; the editor shows it unscoped.
    sender: sender?.name ?? null,
    enabled,
    kind: check.kind,
    asset: 'asset' in check ? check.asset : '',
    limit: 'limit' in check ? check.limit : '',
    addresses: 'addresses' in check ? check.addresses.join('\n') : '',
    reason: '',
  };
}

export function newDraft(chain: Chain, asset: string): RuleDraft {
  return {
    name: '',
    chain,
    sender: null,
    enabled: true,
    kind: 'item_over',
    asset,
    limit: '',
    addresses: '',
    reason: '',
  };
}

export type DraftField = 'name' | 'limit' | 'addresses';

export type DraftBody =
  { ok: true; body: Record<string, unknown> } | { ok: false; field: DraftField; message: string };

const DECIMAL = /^\d+(\.\d+)?$/;

/**
 * The request body for a draft, or the first field to fix. The engine checks
 * the rest (the asset's decimals, each address); this only catches what can
 * be caught while typing. A preview needs no name.
 */
export function draftBody(draft: RuleDraft, { forPreview = false } = {}): DraftBody {
  const name = draft.name.trim();
  if (!forPreview && !name) return { ok: false, field: 'name', message: 'Give the rule a name.' };
  const body: Record<string, unknown> = {
    ...(name ? { name } : {}),
    chain: draft.chain,
    sender: draft.sender,
    enabled: draft.enabled,
    kind: draft.kind,
  };
  const params = RULE_KINDS[draft.kind].params;
  if (params === 'limit') {
    const limit = draft.limit.trim().replace(/,/g, '');
    if (!DECIMAL.test(limit) || /^0*(\.0*)?$/.test(limit)) {
      return { ok: false, field: 'limit', message: 'A limit in whole units, such as 5000 or 0.5.' };
    }
    Object.assign(body, { asset: draft.asset, limit });
  }
  if (params === 'list') {
    const addresses = draft.addresses
      .split(/[\s,]+/)
      .map((a) => a.trim())
      .filter(Boolean);
    if (addresses.length === 0) {
      return { ok: false, field: 'addresses', message: 'List at least one address.' };
    }
    body.addresses = addresses;
  }
  const reason = draft.reason.trim();
  if (reason && !forPreview) body.reason = reason;
  return { ok: true, body };
}
