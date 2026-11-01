import type { Money } from '../../domain/assets';
import { CHAINS, type Chain, type Network } from '../../domain/chains';
import type {
  Approval,
  ChainRef,
  DispatchDetail,
  DispatchError,
  DispatchSummary,
  Item,
  ItemStatus,
  TimelineEntry,
} from '../../domain/dispatch';
import type { AssetBalance, Holding, Read, Sender, SignerKey } from '../../domain/sender';
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
const STATUS_NAMES = Object.keys(STATUSES) as Status[];
const ITEM_STATUSES: readonly ItemStatus[] = [
  'queued',
  'awaiting_approval',
  'broadcasting',
  'confirmed',
  'failed',
  'abandoned',
  'cancelled',
];

function money(asset: string, raw: string, decimals: unknown, path: string): Money | null {
  return decimals === undefined ? null : { asset, raw, decimals: integer(decimals, path) };
}

function dispatchError(value: unknown, path: string): DispatchError | null {
  if (value === null || value === undefined) return null;
  const json = object(value, path);
  const error: DispatchError = {
    code: string(json.code, `${path}.code`),
    message: string(json.message, `${path}.message`),
  };
  const detail = json.chainDetail;
  if (typeof detail === 'object' && detail !== null) {
    const { asset, short } = detail as Json;
    if (typeof asset === 'string' && typeof short === 'string' && /^\d+$/.test(short)) {
      error.short = { asset, raw: short };
    }
  }
  return error;
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

function approval(value: unknown, path: string): Approval | null {
  if (value === undefined) return null;
  const json = object(value, path);
  return {
    state: oneOf(json.state, APPROVAL_STATES, `${path}.state`),
    approvals: integer(json.approvals, `${path}.approvals`),
    threshold: integer(json.threshold, `${path}.threshold`),
    deadline: date(json.deadline, `${path}.deadline`),
    chainRef: chainRef(json.chainRef, `${path}.chainRef`),
  };
}

function item(value: unknown, path: string, index: number): Item {
  const json = object(value, path);
  const base = {
    index,
    status: oneOf(json.status, ITEM_STATUSES, `${path}.status`),
    transactionHash: nullableString(json.transactionHash, `${path}.transactionHash`),
    error: dispatchError(json.error, `${path}.error`),
    approval: approval(json.approval, `${path}.approval`),
  };
  if (json.type === 'payment') {
    const asset = string(json.asset, `${path}.asset`);
    return {
      ...base,
      type: 'payment',
      recipient: string(json.recipient, `${path}.recipient`),
      asset,
      amount: money(
        asset,
        rawAmount(json.amount, `${path}.amount`),
        json.decimals,
        `${path}.decimals`,
      ),
    };
  }
  if (json.type === 'call') {
    const target = json.to ?? json.programId;
    return { ...base, type: 'call', target: string(target, `${path}.to`) };
  }
  return fail(`${path}.type`, 'payment or call');
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
    case 'dropped':
      return {
        kind: json.kind,
        at: at(),
        hash: hash(),
        items: items(),
        by: nullableString(json.by, `${path}.by`),
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
export function parseDetail(value: unknown): DispatchDetail {
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
    };
  }
  if (json.mode !== 'managed') fail('mode', 'managed or relay');
  return {
    mode: 'managed',
    id,
    chain,
    createdAt,
    status: oneOf(json.status, STATUS_NAMES, 'status'),
    items: array(json.items, 'items').map((value, index) => item(value, `items[${index}]`, index)),
    timeline,
  };
}

function summary(value: unknown, path: string): DispatchSummary {
  const json = object(value, path);
  return {
    id: string(json.dispatchId, `${path}.dispatchId`),
    mode: oneOf(json.mode, ['managed', 'relay'] as const, `${path}.mode`),
    chain: oneOf(json.chain, CHAIN_NAMES, `${path}.chain`),
    status: oneOf(json.status, STATUS_NAMES, `${path}.status`),
    createdAt: date(json.createdAt, `${path}.createdAt`),
    itemCount: integer(json.itemCount, `${path}.itemCount`),
    // A total in an asset no longer configured has no decimals to show it by.
    totals: list(json.totals, `${path}.totals`, (total, at) => {
      const t = object(total, at);
      const asset = string(t.asset, `${at}.asset`);
      return money(asset, rawAmount(t.amount, `${at}.amount`), t.decimals, `${at}.decimals`);
    }).filter((total): total is Money => total !== null),
  };
}

export interface DispatchPage {
  dispatches: DispatchSummary[];
  nextCursor: string | null;
}

/** `GET /v1/dispatches`. */
export function parsePage(value: unknown): DispatchPage {
  const json = object(value, 'body');
  return {
    dispatches: list(json.dispatches, 'dispatches', summary),
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

function holding(value: unknown, path: string): Holding {
  const json = object(value, path);
  return {
    holder: oneOf(json.holder, HOLDERS, `${path}.holder`),
    address: string(json.address, `${path}.address`),
    assets: list(json.assets, `${path}.assets`, (asset, at): AssetBalance => {
      const a = object(asset, at);
      const name = string(a.asset, `${at}.asset`);
      const decimals = a.decimals === undefined ? 0 : integer(a.decimals, `${at}.decimals`);
      const toMoney = (raw: string): Money => ({ asset: name, raw, decimals });
      return {
        asset: name,
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

function sender(value: unknown, path: string): Sender {
  const json = object(value, path);
  const multisig = json.multisig === null ? null : object(json.multisig, `${path}.multisig`);
  return {
    chain: oneOf(json.chain, CHAIN_NAMES, `${path}.chain`),
    network: network(json.network, `${path}.network`),
    mode: oneOf(json.mode, ['single', 'squads', 'safe'] as const, `${path}.mode`),
    address: string(json.address, `${path}.address`),
    multisig: multisig && {
      address: string(multisig.address, `${path}.multisig.address`),
      threshold: read(multisig.threshold, `${path}.multisig.threshold`, integer),
      engineKey: string(multisig.engineKey, `${path}.multisig.engineKey`),
    },
    balances: list(json.balances, `${path}.balances`, holding),
    signerKey: signerKeyRead(json.signerKey, `${path}.signerKey`),
  };
}

/** `GET /v1/senders`. */
export function parseSenders(value: unknown): Sender[] {
  return list(object(value, 'body').senders, 'senders', sender);
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

/** A refusal with an error code, such as `409 ALREADY_CLAIMED`. */
export function parseRefusal(value: unknown): { code: string; message: string } | null {
  if (typeof value !== 'object' || value === null) return null;
  const { code, message } = value as Json;
  return typeof code === 'string' && typeof message === 'string' ? { code, message } : null;
}
