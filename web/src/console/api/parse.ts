import {
  ASSET_KINDS,
  type AssetKind,
  type AssetNames,
  type AssetPreview,
  type KnownAsset,
  type Money,
} from '../../domain/assets';
import type {
  AmountView,
  ArgValue,
  CallArg,
  CallEvent,
  DecodedCall,
  Effects,
  Transfer,
} from '../../domain/calls';
import { CHAINS, type Chain, type Network } from '../../domain/chains';
import type { ContractPreview, KnownContract } from '../../domain/contracts';
import type {
  Approval,
  Approver,
  BulkCallSettings,
  Cancellation,
  ChainRef,
  DispatchDetail,
  DispatchError,
  DispatchSummary,
  Fee,
  Item,
  ItemStatus,
  SenderRef,
  TakenNonce,
  TimelineEntry,
} from '../../domain/dispatch';
import {
  ACTIONS,
  type ActionKind,
  type FlagRule,
  type Hold,
  type OperatorAction,
  type Preview,
  RULE_KIND_NAMES,
  type RuleCheck,
  type RuleVersion,
  type TokenKind,
} from '../../domain/flagRules';
import type { ErrorDetail, ReadError } from '../../domain/errors';
import type {
  AssetBalance,
  ForeignActivity,
  Holding,
  Read,
  Sender,
  SignerKey,
} from '../../domain/sender';
import { AREAS, type Fix, type Setup, type SetupCheck, type WorkerRun } from '../../domain/setup';
import { type Status, STATUSES } from '../../domain/status';

/** The engine answered with a shape this console does not understand. */
export class MalformedResponse extends Error {
  constructor(
    readonly path: string,
    expected: string,
  ) {
    super(`${path} is not ${expected}`);
    this.name = 'MalformedResponse';
  }
}

type Json = Record<string, unknown>;

function fail(path: string, expected: string): never {
  throw new MalformedResponse(path, expected);
}

function object(value: unknown, path: string): Json {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
    ? (value as Json)
    : fail(path, 'an object');
}

function array(value: unknown, path: string): unknown[] {
  return Array.isArray(value) ? value : fail(path, 'an array');
}

function string(value: unknown, path: string): string {
  return typeof value === 'string' ? value : fail(path, 'a string');
}

function nullableString(value: unknown, path: string): string | null {
  return value === null || value === undefined ? null : string(value, path);
}

function boolean(value: unknown, path: string): boolean {
  return typeof value === 'boolean' ? value : fail(path, 'true or false');
}

function integer(value: unknown, path: string): number {
  return typeof value === 'number' && Number.isInteger(value) ? value : fail(path, 'an integer');
}

function rawAmount(value: unknown, path: string): string {
  const raw = string(value, path);
  return /^\d+$/.test(raw) ? raw : fail(path, 'an integer string');
}

function date(value: unknown, path: string): Date {
  const parsed = new Date(string(value, path));
  return Number.isNaN(parsed.getTime()) ? fail(path, 'an ISO 8601 time') : parsed;
}

function oneOf<T extends string>(value: unknown, options: readonly T[], path: string): T {
  return options.includes(value as T) ? (value as T) : fail(path, `one of ${options.join(', ')}`);
}

function list<T>(value: unknown, path: string, each: (item: unknown, path: string) => T): T[] {
  return array(value, path).map((item, index) => each(item, `${path}[${index}]`));
}

const CHAIN_NAMES = Object.keys(CHAINS) as Chain[];

/** Names every asset by its symbol: what a reader without the registry, such as a test, gets. */
const bySymbol: AssetNames = (_chain, symbol) => symbol;
const STATUS_NAMES = Object.keys(STATUSES) as Status[];
const ITEM_STATUSES: readonly ItemStatus[] = [
  'queued',
  'held',
  'awaiting_approval',
  'broadcasting',
  'confirmed',
  'failed',
  'abandoned',
  'cancelled',
];

function money(
  name: string,
  asset: string,
  raw: string,
  decimals: unknown,
  path: string,
): Money | null {
  return decimals === undefined ? null : { asset, name, raw, decimals: integer(decimals, path) };
}

function dispatchError(value: unknown, path: string): DispatchError | null {
  if (value === null || value === undefined) return null;
  const json = object(value, path);
  const error: DispatchError = {
    code: string(json.code, `${path}.code`),
    message: string(json.message, `${path}.message`),
  };
  const detail = errorDetail(json.chainDetail);
  if (detail.asset && detail.short) error.short = { asset: detail.asset, raw: detail.short };
  if (Object.keys(detail).length > 0) error.detail = detail;
  return error;
}

/** The parts of `chainDetail` the error catalogue explains. Its shape depends on the code and the chain, so a field of another shape is left out, never an error. */
function errorDetail(value: unknown): ErrorDetail {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return {};
  const json = value as Json;
  const text = (key: string) => {
    const value = json[key];
    return typeof value === 'string' ? value : undefined;
  };
  const detail: ErrorDetail = {};
  for (const key of ['asset', 'holder', 'address', 'status', 'reason'] as const) {
    const v = text(key);
    if (v) detail[key] = v;
  }
  const shortfall = text('short');
  if (shortfall && /^\d+$/.test(shortfall)) detail.short = shortfall;
  const deadlineAt = text('deadlineAt');
  if (deadlineAt && !Number.isNaN(new Date(deadlineAt).getTime())) {
    detail.deadlineAt = new Date(deadlineAt);
  }
  if (typeof json.httpStatus === 'number') detail.httpStatus = json.httpStatus;
  return detail;
}

/** Absent on a Relay Dispatch, and on one the engine has not yet given to a Sender. */
function senderRef(value: unknown, path: string): SenderRef | null {
  if (value === undefined || value === null) return null;
  const json = object(value, path);
  return {
    name: nullableString(json.name, `${path}.name`),
    address: string(json.address, `${path}.address`),
  };
}

function chainRef(value: unknown, path: string): ChainRef {
  const json = object(value, path);
  const kind = oneOf(json.kind, ['squads', 'safe'] as const, `${path}.kind`);
  return kind === 'squads'
    ? {
        kind,
        multisig: string(json.multisig, `${path}.multisig`),
        proposal: string(json.proposal, `${path}.proposal`),
        transactionIndex: integer(json.transactionIndex, `${path}.transactionIndex`),
      }
    : {
        kind,
        safe: string(json.safe, `${path}.safe`),
        safeTxHash: string(json.safeTxHash, `${path}.safeTxHash`),
        nonce: integer(json.nonce, `${path}.nonce`),
      };
}

const APPROVAL_STATES = ['awaiting', 'approved', 'approved_after_deadline'] as const;
const DECISIONS = ['approved', 'rejected', 'pending'] as const;

function approver(value: unknown, path: string): Approver {
  const json = object(value, path);
  return {
    address: string(json.address, `${path}.address`),
    label: json.label === undefined ? null : string(json.label, `${path}.label`),
    decision: oneOf(json.decision, DECISIONS, `${path}.decision`),
  };
}

function approval(value: unknown, path: string): Approval | null {
  if (value === undefined) return null;
  const json = object(value, path);
  return {
    state: oneOf(json.state, APPROVAL_STATES, `${path}.state`),
    approvals: integer(json.approvals, `${path}.approvals`),
    threshold: integer(json.threshold, `${path}.threshold`),
    remaining: integer(json.remaining, `${path}.remaining`),
    approvers: array(json.approvers, `${path}.approvers`).map((entry, index) =>
      approver(entry, `${path}.approvers[${index}]`),
    ),
    deadline: date(json.deadline, `${path}.deadline`),
    chainRef: chainRef(json.chainRef, `${path}.chainRef`),
  };
}

/** An amount the engine decoded: its asset and name come with it when it is a Known Asset. */
function amountView(value: unknown, path: string): AmountView {
  const json = object(value, path);
  const raw = rawAmount(json.amount, `${path}.amount`);
  return { raw, money: moneyOf(json, raw, path) };
}

function moneyOf(json: Json, raw: string, path: string): Money | null {
  if (json.asset === undefined) return null;
  const asset = object(json.asset, `${path}.asset`);
  return {
    raw,
    decimals: integer(asset.decimals, `${path}.asset.decimals`),
    asset: string(asset.symbol, `${path}.asset.symbol`),
    name: string(asset.name, `${path}.asset.name`),
  };
}

function argValue(value: unknown, path: string): ArgValue {
  if (value === null || typeof value === 'string' || typeof value === 'boolean') return value;
  if (Array.isArray(value)) return value.map((v, i) => argValue(v, `${path}[${i}]`));
  const json = object(value, path);
  return Object.fromEntries(
    Object.entries(json).map(([key, v]) => [key, argValue(v, `${path}.${key}`)]),
  );
}

function callArg(value: unknown, path: string): CallArg {
  const json = object(value, path);
  const v = argValue(json.value, `${path}.value`);
  return {
    name: string(json.name, `${path}.name`),
    type: string(json.type, `${path}.type`),
    value: v,
    money: typeof v === 'string' && /^\d+$/.test(v) ? moneyOf(json, v, path) : null,
  };
}

const optional = <T>(value: unknown, read: (value: unknown) => T): T | null =>
  value === undefined ? null : read(value);

function decodedCall(value: unknown, path: string): DecodedCall {
  const json = object(value, path);
  return {
    target: string(json.target, `${path}.target`),
    label: optional(json.label, (v) => string(v, `${path}.label`)),
    decoded: boolean(json.decoded, `${path}.decoded`),
    decoder: optional(json.decoder, (v) => string(v, `${path}.decoder`)),
    function: optional(json.function, (v) => string(v, `${path}.function`)),
    args: list(json.args ?? [], `${path}.args`, callArg),
    selector: optional(json.selector, (v) => string(v, `${path}.selector`)),
    data: optional(json.data, (v) => string(v, `${path}.data`)),
    value: optional(json.value, (v) => amountView(v, `${path}.value`)),
    calls: list(json.calls ?? [], `${path}.calls`, decodedCall),
  };
}

function transfer(value: unknown, path: string): Transfer {
  const json = object(value, path);
  return {
    ...amountView(json, path),
    standard: string(json.standard, `${path}.standard`),
    token: string(json.token, `${path}.token`),
    from: nullableString(json.from, `${path}.from`),
    to: nullableString(json.to, `${path}.to`),
    tokenId: optional(json.tokenId, (v) => string(v, `${path}.tokenId`)),
  };
}

function callEvent(value: unknown, path: string): CallEvent {
  const json = object(value, path);
  return {
    kind: oneOf(json.kind, ['log', 'instruction'] as const, `${path}.kind`),
    source: string(json.source, `${path}.source`),
    label: optional(json.label, (v) => string(v, `${path}.label`)),
    decoder: string(json.decoder, `${path}.decoder`),
    name: string(json.name, `${path}.name`),
    args: list(json.args, `${path}.args`, callArg),
  };
}

function effects(value: unknown, path: string): Effects | null {
  if (value === undefined) return null;
  const json = object(value, path);
  const fee = object(json.fee, `${path}.fee`);
  return {
    transfers: list(json.transfers, `${path}.transfers`, transfer),
    value: optional(json.value, (v) => amountView(v, `${path}.value`)),
    fee: { ...amountView(fee, `${path}.fee`), payer: string(fee.payer, `${path}.fee.payer`) },
    events: list(json.events, `${path}.events`, callEvent),
    undecodedEvents: integer(json.undecodedEvents, `${path}.undecodedEvents`),
    undecodedEventSources: list(
      json.undecodedEventSources,
      `${path}.undecodedEventSources`,
      (s, at) => {
        const source = object(s, at);
        return {
          source: string(source.source, `${at}.source`),
          label: optional(source.label, (v) => string(v, `${at}.label`)),
          count: integer(source.count, `${at}.count`),
        };
      },
    ),
    truncated: boolean(json.truncated, `${path}.truncated`),
  };
}

function item(value: unknown, path: string, index: number, name: (asset: string) => string): Item {
  const json = object(value, path);
  const base = {
    index,
    status: oneOf(json.status, ITEM_STATUSES, `${path}.status`),
    transactionHash: nullableString(json.transactionHash, `${path}.transactionHash`),
    error: dispatchError(json.error, `${path}.error`),
    approval: approval(json.approval, `${path}.approval`),
    effects: effects(json.effects, `${path}.effects`),
  };
  if (json.type === 'payment') {
    const asset = string(json.asset, `${path}.asset`);
    return {
      ...base,
      type: 'payment',
      recipient: string(json.recipient, `${path}.recipient`),
      asset,
      amount: money(
        name(asset),
        asset,
        rawAmount(json.amount, `${path}.amount`),
        json.decimals,
        `${path}.decimals`,
      ),
    };
  }
  if (json.type === 'call') {
    const target = json.to ?? json.programId;
    return {
      ...base,
      type: 'call',
      target: string(target, `${path}.to`),
      call: decodedCall(json.call, `${path}.call`),
    };
  }
  return fail(`${path}.type`, 'payment or call');
}

/** A dropped version's `error`, when it says another sender took the nonce (`chainDetail.reason: nonce_taken`). */
function takenNonce(value: unknown, path: string): TakenNonce | null {
  if (value === undefined || value === null) return null;
  const json = object(value, path);
  const detail = json.chainDetail;
  if (typeof detail !== 'object' || detail === null) return null;
  const { reason, nonce, resentNonce } = detail as Json;
  if (reason !== 'nonce_taken') return null;
  const optional = (v: unknown, at: string) => (v === undefined ? null : integer(v, at));
  return {
    nonce: optional(nonce, `${path}.chainDetail.nonce`),
    resentNonce: optional(resentNonce, `${path}.chainDetail.resentNonce`),
  };
}

function indexes(value: unknown, path: string): number[] {
  return list(value, path, integer);
}

function entry(value: unknown, path: string): TimelineEntry {
  const json = object(value, path);
  const at = () => date(json.at, `${path}.at`);
  const hash = () => string(json.hash, `${path}.hash`);
  const items = () => indexes(json.items, `${path}.items`);
  const proposalId = () => string(json.proposalId, `${path}.proposalId`);
  switch (json.kind) {
    case 'created':
    case 'claimed':
    case 'cancelled':
      return { kind: json.kind, at: at() };
    case 'written':
      return {
        kind: 'written',
        at: at(),
        hash: hash(),
        items: items(),
        replaces: nullableString(json.replaces, `${path}.replaces`),
        fee: fee(json.fee, `${path}.fee`),
      };
    case 'sent':
      return { kind: 'sent', at: at(), hash: hash(), items: items() };
    case 'attempt':
      return {
        kind: 'attempt',
        at: at(),
        hash: hash(),
        items: items(),
        error: dispatchError(json.error, `${path}.error`),
      };
    case 'replaced':
      return {
        kind: 'replaced',
        at: at(),
        hash: hash(),
        items: items(),
        by: nullableString(json.by, `${path}.by`),
      };
    case 'dropped':
      return {
        kind: 'dropped',
        at: at(),
        hash: hash(),
        items: items(),
        by: nullableString(json.by, `${path}.by`),
        taken: takenNonce(json.error, `${path}.error`),
      };
    case 'confirmed':
      return {
        kind: 'confirmed',
        at: at(),
        hash: nullableString(json.hash, `${path}.hash`),
        items: items(),
      };
    case 'failed':
    case 'abandoned':
      return {
        kind: json.kind,
        at: at(),
        hash: nullableString(json.hash, `${path}.hash`),
        items: items(),
        error: dispatchError(json.error, `${path}.error`),
      };
    case 'proposal_created':
      return {
        kind: 'proposal_created',
        at: at(),
        proposalId: proposalId(),
        chainRef: chainRef(json.chainRef, `${path}.chainRef`),
        items: items(),
      };
    case 'proposal_approval':
      return {
        kind: 'proposal_approval',
        at: json.at === null ? null : at(),
        proposalId: proposalId(),
        state: oneOf(json.state, APPROVAL_STATES, `${path}.state`),
        approvals: integer(json.approvals, `${path}.approvals`),
        threshold: integer(json.threshold, `${path}.threshold`),
      };
    case 'proposal_timed_out':
      return { kind: 'proposal_timed_out', at: at(), proposalId: proposalId() };
    case 'proposal_resolved':
      return {
        kind: 'proposal_resolved',
        at: at(),
        proposalId: proposalId(),
        outcome: oneOf(
          json.outcome,
          ['executed', 'rejected', 'failed'] as const,
          `${path}.outcome`,
        ),
      };
    default:
      return fail(`${path}.kind`, 'a known timeline kind');
  }
}

/** `GET /v1/dispatch/:id?include=timeline`. */
export function parseDetail(value: unknown, names: AssetNames = bySymbol): DispatchDetail {
  const json = object(value, 'body');
  const id = string(json.dispatchId, 'dispatchId');
  const chain = oneOf(json.chain, CHAIN_NAMES, 'chain');
  const createdAt = date(json.createdAt, 'createdAt');
  const timeline = list(json.timeline ?? [], 'timeline', entry);
  if (json.mode === 'relay') {
    return {
      mode: 'relay',
      id,
      chain,
      createdAt,
      status: oneOf(json.status, ITEM_STATUSES, 'status'),
      transactionHash: nullableString(json.transactionHash, 'transactionHash'),
      error: dispatchError(json.error, 'error'),
      timeline,
      cancellation: cancellation(json.cancellation),
      signer: nullableString(json.signer, 'signer'),
      target: nullableString(json.target, 'target'),
      value: json.value === undefined ? null : total(json.value, 'value', chain, names),
    };
  }
  if (json.mode !== 'managed') fail('mode', 'managed or relay');
  return {
    mode: 'managed',
    id,
    chain,
    sender: senderRef(json.sender, 'sender'),
    createdAt,
    status: oneOf(json.status, STATUS_NAMES, 'status'),
    items: array(json.items, 'items').map((value, index) =>
      item(value, `items[${index}]`, index, (asset) => names(chain, asset)),
    ),
    timeline,
    hold: json.hold === undefined ? null : hold(json.hold, 'hold'),
    cancellation: cancellation(json.cancellation),
    ...(json.retryPolicy === undefined
      ? {}
      : { retryPolicy: boolean(json.retryPolicy, 'retryPolicy') }),
    bulkCall: json.bulkCall === undefined ? null : bulkCall(json.bulkCall, 'bulkCall'),
  };
}

function fee(value: unknown, path: string): Fee | null {
  if (value === undefined || value === null) return null;
  const json = object(value, path);
  return {
    maxFeePerGas: rawAmount(json.maxFeePerGas, `${path}.maxFeePerGas`),
    maxPriorityFeePerGas: rawAmount(json.maxPriorityFeePerGas, `${path}.maxPriorityFeePerGas`),
  };
}

function bulkCall(value: unknown, path: string): BulkCallSettings {
  const json = object(value, path);
  return {
    aggregator: string(json.aggregator, `${path}.aggregator`),
    label: nullableString(json.label, `${path}.label`),
    maxBatchSize: integer(json.maxBatchSize, `${path}.maxBatchSize`),
    allowFailure: boolean(json.allowFailure, `${path}.allowFailure`),
  };
}

/** An `AssetTotal`: null when the asset is no longer configured, so it has no decimals. */
function total(value: unknown, path: string, chain: Chain, names: AssetNames): Money | null {
  const t = object(value, path);
  const asset = string(t.asset, `${path}.asset`);
  return money(
    names(chain, asset),
    asset,
    rawAmount(t.amount, `${path}.amount`),
    t.decimals,
    `${path}.decimals`,
  );
}

function cancellation(value: unknown): Cancellation | null {
  if (value === undefined || value === null) return null;
  const json = object(value, 'cancellation');
  return {
    at: date(json.at, 'cancellation.at'),
    tokenKind: oneOf(json.tokenKind, ['auth', 'operator'] as const, 'cancellation.tokenKind'),
    reason: nullableString(json.reason, 'cancellation.reason'),
  };
}

/** A rule's kind and its own parameters, from a body that may carry other fields beside them. */
function ruleCheck(json: Json, path: string): RuleCheck {
  const kind = oneOf(json.kind, RULE_KIND_NAMES, `${path}.kind`);
  switch (kind) {
    case 'item_over':
    case 'dispatch_total_over':
    case 'daily_volume_over':
      return {
        kind,
        asset: string(json.asset, `${path}.asset`),
        limit: string(json.limit, `${path}.limit`),
      };
    case 'first_time_recipient':
      return { kind };
    case 'recipient_not_allowlisted':
    case 'call_target_not_allowlisted':
      return { kind, addresses: list(json.addresses, `${path}.addresses`, string) };
  }
}

function hold(value: unknown, path: string): Hold {
  const json = object(value, path);
  return {
    matched: list(json.matched, `${path}.matched`, (match, at) => {
      const m = object(match, at);
      const rule = object(m.rule, `${at}.rule`);
      return {
        ruleId: string(m.ruleId, `${at}.ruleId`),
        ruleVersion: integer(m.ruleVersion, `${at}.ruleVersion`),
        name: string(rule.name, `${at}.rule.name`),
        check: ruleCheck(rule, `${at}.rule`),
        items: indexes(m.items, `${at}.items`),
      };
    }),
    heldAt: date(json.heldAt, `${path}.heldAt`),
    releasedAt: json.releasedAt === undefined ? null : date(json.releasedAt, `${path}.releasedAt`),
    reason: nullableString(json.reason, `${path}.reason`),
  };
}

function summary(value: unknown, path: string, names: AssetNames): DispatchSummary {
  const json = object(value, path);
  const chain = oneOf(json.chain, CHAIN_NAMES, `${path}.chain`);
  return {
    id: string(json.dispatchId, `${path}.dispatchId`),
    mode: oneOf(json.mode, ['managed', 'relay'] as const, `${path}.mode`),
    chain,
    sender: senderRef(json.sender, `${path}.sender`),
    status: oneOf(json.status, STATUS_NAMES, `${path}.status`),
    createdAt: date(json.createdAt, `${path}.createdAt`),
    itemCount: integer(json.itemCount, `${path}.itemCount`),
    ...(json.callCount === undefined
      ? {}
      : { callCount: integer(json.callCount, `${path}.callCount`) }),
    // A total in an asset no longer configured has no decimals to show it by.
    totals: list(json.totals, `${path}.totals`, (value, at) =>
      total(value, at, chain, names),
    ).filter((t): t is Money => t !== null),
    ...(json.heldBy === undefined ? {} : { heldBy: list(json.heldBy, `${path}.heldBy`, string) }),
  };
}

export interface DispatchPage {
  dispatches: DispatchSummary[];
  nextCursor: string | null;
}

/** `GET /v1/dispatches`. */
export function parsePage(value: unknown, names: AssetNames = bySymbol): DispatchPage {
  const json = object(value, 'body');
  return {
    dispatches: list(json.dispatches, 'dispatches', (row, at) => summary(row, at, names)),
    nextCursor: nullableString(json.nextCursor, 'nextCursor'),
  };
}

function fieldError(value: unknown): string | null {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) return null;
  const { error } = value as Json;
  return typeof error === 'string' ? error : null;
}

function read<T>(
  value: unknown,
  path: string,
  parse: (value: unknown, path: string) => T,
): Read<T> {
  const error = fieldError(value);
  return error === null ? { ok: true, value: parse(value, path) } : { ok: false, error };
}

const HOLDERS = ['sender', 'vault', 'safe', 'memberKey', 'executor'] as const;
const NETWORK_NAMES = [
  'base',
  'base-sepolia',
  'mainnet-beta',
  'devnet',
  'testnet',
  'unknown',
] as const;

/** A network this console does not know reads as `unknown`, which links nowhere. */
function network(value: unknown, path: string): Network {
  if (typeof value === 'object' && value !== null) {
    return { chainId: integer((value as Json).chainId, `${path}.chainId`) };
  }
  return (NETWORK_NAMES as readonly unknown[]).includes(value) ? (value as Network) : 'unknown';
}

function holding(value: unknown, path: string, name: (asset: string) => string): Holding {
  const json = object(value, path);
  return {
    holder: oneOf(json.holder, HOLDERS, `${path}.holder`),
    address: string(json.address, `${path}.address`),
    assets: list(json.assets, `${path}.assets`, (asset, at): AssetBalance => {
      const a = object(asset, at);
      const symbol = string(a.asset, `${at}.asset`);
      const decimals = a.decimals === undefined ? 0 : integer(a.decimals, `${at}.decimals`);
      const toMoney = (raw: string): Money => ({
        asset: symbol,
        name: name(symbol),
        raw,
        decimals,
      });
      return {
        asset: symbol,
        decimals: a.decimals === undefined ? null : decimals,
        balance: read(a.balance, `${at}.balance`, (v, p) => toMoney(rawAmount(v, p))),
        committed: toMoney(rawAmount(a.committed, `${at}.committed`)),
      };
    }),
  };
}

function signerKey(value: unknown, path: string): SignerKey {
  const json = object(value, path);
  return {
    address: string(json.address, `${path}.address`),
    curve: string(json.curve, `${path}.curve`),
    chainIds: json.chainIds === undefined ? [] : list(json.chainIds, `${path}.chainIds`, integer),
    allowedSafe: nullableString(json.allowedSafe, `${path}.allowedSafe`),
    allowedMultisig: nullableString(json.allowedMultisig, `${path}.allowedMultisig`),
    readAt: string(json.readAt, `${path}.readAt`),
  };
}

function signerKeyRead(value: unknown, path: string): Read<SignerKey> {
  if (typeof value === 'object' && value !== null && (value as Json).status === 'not_read_yet') {
    return { ok: false, error: 'the worker has not read this key yet' };
  }
  return read(value, path, signerKey);
}

function foreignActivity(value: unknown, path: string): ForeignActivity | null {
  if (value === null) return null;
  const json = object(value, path);
  const nonces = list(json.nonces, `${path}.nonces`, integer);
  const [first, last] = nonces;
  if (nonces.length !== 2 || first === undefined || last === undefined) {
    return fail(`${path}.nonces`, 'the lowest and the highest nonce');
  }
  return {
    lastSeenAt: date(json.lastSeenAt, `${path}.lastSeenAt`),
    nonces: [first, last],
    count: integer(json.count, `${path}.count`),
  };
}

function sender(value: unknown, path: string, names: AssetNames): Sender {
  const json = object(value, path);
  const multisig = json.multisig === null ? null : object(json.multisig, `${path}.multisig`);
  const chain = oneOf(json.chain, CHAIN_NAMES, `${path}.chain`);
  return {
    chain,
    name: string(json.name, `${path}.name`),
    isDefault: boolean(json.default, `${path}.default`),
    network: network(json.network, `${path}.network`),
    mode: oneOf(json.mode, ['single', 'squads', 'safe'] as const, `${path}.mode`),
    address: string(json.address, `${path}.address`),
    multisig: multisig && {
      address: string(multisig.address, `${path}.multisig.address`),
      threshold: read(multisig.threshold, `${path}.multisig.threshold`, integer),
      engineKey: string(multisig.engineKey, `${path}.multisig.engineKey`),
    },
    balances: list(json.balances, `${path}.balances`, (h, at) =>
      holding(h, at, (asset) => names(chain, asset)),
    ),
    signerKey: signerKeyRead(json.signerKey, `${path}.signerKey`),
    foreignActivity: foreignActivity(json.foreignActivity, `${path}.foreignActivity`),
  };
}

/** `GET /v1/senders`. */
export function parseSenders(value: unknown, names: AssetNames = bySymbol): Sender[] {
  return list(object(value, 'body').senders, 'senders', (s, at) => sender(s, at, names));
}

const ASSET_KIND_NAMES = Object.keys(ASSET_KINDS) as AssetKind[];

export function parseKnownAsset(value: unknown, path = 'body'): KnownAsset {
  const json = object(value, path);
  return {
    id: string(json.id, `${path}.id`),
    chain: oneOf(json.chain, CHAIN_NAMES, `${path}.chain`),
    address: string(json.address, `${path}.address`),
    symbol: string(json.symbol, `${path}.symbol`),
    name: string(json.name, `${path}.name`),
    decimals: integer(json.decimals, `${path}.decimals`),
    kind: oneOf(json.kind, ASSET_KIND_NAMES, `${path}.kind`),
    source: oneOf(json.source, ['config', 'console'] as const, `${path}.source`),
    enabled: boolean(json.enabled, `${path}.enabled`),
    addedBy:
      json.addedBy === null
        ? null
        : oneOf(json.addedBy, ['auth', 'operator'] as const, `${path}.addedBy`),
    addedAt: date(json.addedAt, `${path}.addedAt`),
  };
}

/** A row of `GET /v1/contracts` (ADR-0063). */
export function parseKnownContract(value: unknown, path = 'body'): KnownContract {
  const json = object(value, path);
  return {
    id: string(json.id, `${path}.id`),
    chain: oneOf(json.chain, CHAIN_NAMES, `${path}.chain`),
    address: string(json.address, `${path}.address`),
    label: string(json.label, `${path}.label`),
    functions: list(json.functions, `${path}.functions`, string),
    events: list(json.events, `${path}.events`, string),
    enabled: boolean(json.enabled, `${path}.enabled`),
    addedBy: oneOf(json.addedBy, ['auth', 'operator'] as const, `${path}.addedBy`),
    addedAt: date(json.addedAt, `${path}.addedAt`),
  };
}

/** `GET /v1/contracts`. */
export function parseContracts(value: unknown): KnownContract[] {
  return list(object(value, 'body').contracts, 'contracts', parseKnownContract);
}

/** `POST /v1/contracts/preview`. */
export function parseContractPreview(value: unknown): ContractPreview {
  const json = object(value, 'body');
  return {
    chain: oneOf(json.chain, CHAIN_NAMES, 'chain'),
    address: string(json.address, 'address'),
    label: string(json.label, 'label'),
    functions: list(json.functions, 'functions', string),
    events: list(json.events, 'events', string),
  };
}

/** `GET /v1/assets`. */
export function parseAssets(value: unknown): KnownAsset[] {
  return list(object(value, 'body').assets, 'assets', parseKnownAsset);
}

/** `POST /v1/assets/preview`. */
export function parseAssetPreview(value: unknown): AssetPreview {
  const json = object(value, 'body');
  const onChain = object(json.onChain, 'onChain');
  return {
    chain: oneOf(json.chain, CHAIN_NAMES, 'chain'),
    kind: oneOf(json.kind, ['spl', 'token-2022', 'erc20'] as const, 'kind'),
    address: string(json.address, 'address'),
    decimals: integer(json.decimals, 'decimals'),
    symbol: string(json.symbol, 'symbol'),
    name: string(json.name, 'name'),
    onChain: {
      symbol: string(onChain.symbol, 'onChain.symbol'),
      name: string(onChain.name, 'onChain.name'),
    },
    supply: rawAmount(json.supply, 'supply'),
  };
}

function fix(value: unknown, path: string): Fix {
  const json = object(value, path);
  if ('command' in json) return { command: string(json.command, `${path}.command`) };
  if ('setting' in json) {
    return {
      setting: string(json.setting, `${path}.setting`),
      value: string(json.value, `${path}.value`),
    };
  }
  return { step: string(json.step, `${path}.step`) };
}

function setupCheck(value: unknown, path: string): SetupCheck {
  const json = object(value, path);
  const status = oneOf(json.status, ['pass', 'warn', 'fail'] as const, `${path}.status`);
  return {
    id: string(json.id, `${path}.id`),
    area: oneOf(json.area, AREAS, `${path}.area`),
    title: string(json.title, `${path}.title`),
    chain: json.chain === undefined ? null : oneOf(json.chain, CHAIN_NAMES, `${path}.chain`),
    ranIn: oneOf(json.ranIn, ['worker', 'api'] as const, `${path}.ranIn`),
    ranAt: date(json.ranAt, `${path}.ranAt`),
    status,
    finding: string(json.finding, `${path}.finding`),
    fix: status === 'pass' ? null : fix(json.fix, `${path}.fix`),
  };
}

function workerRun(value: unknown, path: string): WorkerRun {
  const json = object(value, path);
  const status = oneOf(
    json.status,
    ['ran', 'not_run_yet', 'unreadable'] as const,
    `${path}.status`,
  );
  return status === 'ran' ? { status, ranAt: date(json.ranAt, `${path}.ranAt`) } : { status };
}

/** `GET /v1/setup`. */
export function parseSetup(value: unknown): Setup {
  const json = object(value, 'body');
  return {
    worker: workerRun(json.worker, 'worker'),
    checks: list(json.checks, 'checks', setupCheck),
  };
}

/**
 * A refusal: one with an error code, such as `409 ALREADY_CLAIMED`, or a
 * plain `{ error }` naming the field at fault, such as a Flag Rule's `400`.
 */
export function parseRefusal(value: unknown): { code: string; message: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { code, message, error } = value as Json;
  if (typeof code === 'string' && typeof message === 'string') return { code, message };
  return typeof error === 'string' ? { code: 'INVALID', message: error } : null;
}

/** `GET /v1/token`. */
export function parseTokenKind(value: unknown): TokenKind {
  return oneOf(object(value, 'body').kind, ['auth', 'operator'] as const, 'kind');
}

function ruleVersion(json: Json, path: string): RuleVersion {
  const chain = oneOf(json.chain, CHAIN_NAMES, `${path}.chain`);
  return {
    version: integer(json.version, `${path}.version`),
    name: string(json.name, `${path}.name`),
    chain,
    sender: senderRef(json.sender, `${path}.sender`),
    enabled: boolean(json.enabled, `${path}.enabled`),
    check: ruleCheck(json, path),
    createdAt: date(json.createdAt, `${path}.createdAt`),
  };
}

/** One rule: `POST`, `PUT` and `GET /v1/flag-rules/:id`. */
export function parseFlagRule(value: unknown, path = 'body'): FlagRule {
  const json = object(value, path);
  const versions = list(json.versions, `${path}.versions`, (v, at) =>
    ruleVersion(object(v, at), at),
  );
  return {
    id: string(json.ruleId, `${path}.ruleId`),
    current: { ...ruleVersion(json, path), createdAt: date(json.updatedAt, `${path}.updatedAt`) },
    createdAt: date(json.createdAt, `${path}.createdAt`),
    versions,
  };
}

/** `GET /v1/flag-rules`. */
export function parseFlagRules(value: unknown): FlagRule[] {
  return list(object(value, 'body').rules, 'rules', parseFlagRule);
}

/** `POST /v1/flag-rules/preview`. */
export function parsePreview(value: unknown): Preview {
  const json = object(value, 'body');
  return {
    from: date(json.from, 'from'),
    to: date(json.to, 'to'),
    scanned: integer(json.scanned, 'scanned'),
    capped: boolean(json.capped, 'capped'),
    wouldHold: integer(json.wouldHold, 'wouldHold'),
    examples: list(json.examples, 'examples', (example, at) => {
      const e = object(example, at);
      return {
        dispatchId: string(e.dispatchId, `${at}.dispatchId`),
        createdAt: date(e.createdAt, `${at}.createdAt`),
        items: indexes(e.items, `${at}.items`),
      };
    }),
  };
}

const ACTION_NAMES = Object.keys(ACTIONS) as ActionKind[];

export interface ActivityPage {
  actions: OperatorAction[];
  nextCursor: string | null;
}

/** `GET /v1/activity`. */
export function parseActivity(value: unknown): ActivityPage {
  const json = object(value, 'body');
  return {
    actions: list(json.actions, 'actions', (action, at) => {
      const a = object(action, at);
      return {
        id: string(a.id, `${at}.id`),
        at: date(a.at, `${at}.at`),
        action: oneOf(a.action, ACTION_NAMES, `${at}.action`),
        targetId: string(a.targetId, `${at}.targetId`),
        tokenKind: oneOf(a.tokenKind, ['auth', 'operator'] as const, `${at}.tokenKind`),
        reason: nullableString(a.reason, `${at}.reason`),
      };
    }),
    nextCursor: nullableString(json.nextCursor, 'nextCursor'),
  };
}

/** ADR-0062: one refused `POST /v1/dispatch`. */
export interface RejectedRequest {
  id: string;
  at: Date;
  status: number;
  /** Null when the request named no chain the engine has. */
  chain: Chain | null;
  idempotencyKey: string | null;
  tokenKind: TokenKind;
  error: ReadError;
  /** The body as sent, every item kept; null when it was not JSON. */
  body: unknown;
}

export interface RejectedPage {
  rejected: RejectedRequest[];
  nextCursor: string | null;
  last24Hours: number;
}

/** `GET /v1/rejected`. */
export function parseRejected(value: unknown): RejectedPage {
  const json = object(value, 'body');
  return {
    rejected: list(json.rejected, 'rejected', (entry, at) => {
      const r = object(entry, at);
      const detail = errorDetail(r.chainDetail);
      return {
        id: string(r.id, `${at}.id`),
        at: date(r.at, `${at}.at`),
        status: integer(r.status, `${at}.status`),
        chain: r.chain === null ? null : oneOf(r.chain, CHAIN_NAMES, `${at}.chain`),
        idempotencyKey: nullableString(r.idempotencyKey, `${at}.idempotencyKey`),
        tokenKind: oneOf(r.tokenKind, ['auth', 'operator'] as const, `${at}.tokenKind`),
        error: {
          code: nullableString(r.code, `${at}.code`),
          message: string(r.message, `${at}.message`),
          ...(Object.keys(detail).length > 0 ? { detail } : {}),
        },
        body: r.body ?? null,
      };
    }),
    nextCursor: nullableString(json.nextCursor, 'nextCursor'),
    last24Hours: integer(json.last24Hours, 'last24Hours'),
  };
}
