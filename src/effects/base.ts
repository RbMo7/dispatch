import {
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
  decodeAbiParameters,
  decodeEventLog,
  getAddress,
  type Hex,
  isAddress,
  parseAbi,
  toEventSelector,
  toFunctionSelector,
  zeroAddress,
} from 'viem';

import type { EvmCall } from '../domain/call.js';
import type { BaseEffects, BaseLog } from '../domain/effects.js';
import { NATIVE_ADDRESS } from '../domain/known-asset.js';
import {
  type AmountView,
  amountOf,
  type ArgValue,
  type ArgView,
  type AssetAt,
  type CallView,
  type EffectsView,
  type EventView,
  type InnerCallView,
  type Known,
  labelOf,
  type TransferView,
  undecodedSources,
} from './view.js';

/** WETH9 as Base and Base Sepolia predeploy it; its Deposit and Withdrawal mean nothing elsewhere. */
export const BASE_WETH = '0x4200000000000000000000000000000000000006';

type Decoder = {
  name: string;
  /** Applies only to calls to, and logs from, this address. */
  only?: string;
  functions: AbiFunction[];
  events: AbiEvent[];
  /** Arguments that are amounts of the called token, by function name. */
  amountArgs?: Record<string, string[]>;
};

const abi = (signatures: string[]) => parseAbi(signatures as readonly string[]);
const functionsOf = (signatures: string[]) =>
  abi(signatures).filter((item): item is AbiFunction => item.type === 'function');
const eventsOf = (signatures: string[]) =>
  abi(signatures).filter((item): item is AbiEvent => item.type === 'event');

/**
 * In order: where ERC-20 and ERC-721 share a selector (`approve`,
 * `transferFrom`), the ERC-20 reading wins. Their `Transfer` and `Approval`
 * logs differ in how many topics are indexed, so logs are never ambiguous.
 */
const DECODERS: Decoder[] = [
  {
    name: 'weth',
    only: BASE_WETH,
    functions: functionsOf(['function deposit()', 'function withdraw(uint256 amount)']),
    events: eventsOf([
      'event Deposit(address indexed to, uint256 amount)',
      'event Withdrawal(address indexed from, uint256 amount)',
    ]),
    amountArgs: { withdraw: ['amount'] },
  },
  {
    name: 'multicall3',
    functions: functionsOf([
      'function aggregate3Value((address target, bool allowFailure, uint256 value, bytes callData)[] calls)',
      'function aggregate3((address target, bool allowFailure, bytes callData)[] calls)',
      'function aggregate((address target, bytes callData)[] calls)',
    ]),
    events: [],
  },
  {
    name: 'erc20',
    functions: functionsOf([
      'function transfer(address to, uint256 amount)',
      'function transferFrom(address from, address to, uint256 amount)',
      'function approve(address spender, uint256 amount)',
    ]),
    events: eventsOf([
      'event Transfer(address indexed from, address indexed to, uint256 value)',
      'event Approval(address indexed owner, address indexed spender, uint256 value)',
    ]),
    amountArgs: {
      transfer: ['amount'],
      transferFrom: ['amount'],
      approve: ['amount'],
      Transfer: ['value'],
      Approval: ['value'],
    },
  },
  {
    name: 'erc721',
    functions: functionsOf([
      'function safeTransferFrom(address from, address to, uint256 tokenId)',
      'function safeTransferFrom(address from, address to, uint256 tokenId, bytes data)',
      'function setApprovalForAll(address operator, bool approved)',
    ]),
    events: eventsOf([
      'event Transfer(address indexed from, address indexed to, uint256 indexed tokenId)',
      'event Approval(address indexed owner, address indexed approved, uint256 indexed tokenId)',
      'event ApprovalForAll(address indexed owner, address indexed operator, bool approved)',
    ]),
  },
  {
    name: 'erc1155',
    functions: functionsOf([
      'function safeTransferFrom(address from, address to, uint256 id, uint256 amount, bytes data)',
      'function safeBatchTransferFrom(address from, address to, uint256[] ids, uint256[] amounts, bytes data)',
    ]),
    events: eventsOf([
      'event TransferSingle(address indexed operator, address indexed from, address indexed to, uint256 id, uint256 value)',
      'event TransferBatch(address indexed operator, address indexed from, address indexed to, uint256[] ids, uint256[] values)',
      'event URI(string value, uint256 indexed id)',
    ]),
  },
];

const FUNCTIONS = DECODERS.flatMap((decoder) =>
  decoder.functions.map((fn) => ({ decoder, fn, selector: toFunctionSelector(fn) })),
);
const EVENTS = DECODERS.flatMap((decoder) =>
  decoder.events.map((event) => ({
    decoder,
    event,
    topic: toEventSelector(event),
    topicCount: 1 + event.inputs.filter((input) => input.indexed).length,
  })),
);

const applies = (decoder: Decoder, address: string) =>
  !decoder.only || decoder.only === address.toLowerCase();

function toArgValue(param: AbiParameter, value: unknown): ArgValue {
  if (param.type.endsWith('[]') && Array.isArray(value)) {
    const element = { ...param, type: param.type.slice(0, -2) };
    return value.map((v) => toArgValue(element, v));
  }
  if (param.type === 'tuple' && 'components' in param) {
    const record = value as Record<string, unknown>;
    return Object.fromEntries(
      param.components.map((c, i) => [c.name ?? `${i}`, toArgValue(c, record[c.name ?? i])]),
    );
  }
  if (typeof value === 'bigint') return value.toString();
  if (typeof value === 'boolean') return value;
  if (typeof value === 'string' && param.type === 'address' && isAddress(value)) {
    return getAddress(value);
  }
  return String(value);
}

function argsOf(
  decoder: Decoder,
  member: string,
  params: readonly AbiParameter[],
  values: readonly unknown[],
  token: string,
  assetAt: AssetAt,
): ArgView[] {
  const amounts = decoder.amountArgs?.[member] ?? [];
  return params.map((param, i) => {
    const name = param.name ?? `arg${i}`;
    const value = toArgValue(param, values[i]);
    if (!amounts.includes(name) || typeof value !== 'string')
      return { name, type: param.type, value };
    const { asset, formatted } = amountOf(assetAt, 'base', token, value);
    return { name, type: param.type, value, ...(asset ? { asset, formatted } : {}) };
  });
}

function nativeValue(assetAt: AssetAt, wei: bigint | string): AmountView | undefined {
  return BigInt(wei) === 0n ? undefined : amountOf(assetAt, 'base', NATIVE_ADDRESS, wei);
}

const AMOUNT_NAME = /^(amount|value|wad)$|Amount$/;

/**
 * A registered ABI says nothing about units, so an unsigned argument named
 * like an amount is shown in the token the call is about: the called contract
 * when it is a Known Asset, or else the one Known Asset among its address
 * arguments. Otherwise it stays a plain number.
 */
function registryArgs(
  params: readonly AbiParameter[],
  values: readonly unknown[],
  target: string,
  assetAt: AssetAt,
): ArgView[] {
  const args = params.map((param, i) => ({
    name: param.name || `arg${i}`,
    type: param.type,
    value: toArgValue(param, values[i]),
  }));
  const tokens = new Set(
    args.flatMap((a) =>
      a.type === 'address' && typeof a.value === 'string' && assetAt('base', a.value)
        ? [a.value]
        : [],
    ),
  );
  const token = assetAt('base', target) ? target : tokens.size === 1 ? [...tokens][0] : undefined;
  if (token === undefined) return args;
  return args.map((arg) => {
    if (!/^uint\d*$/.test(arg.type) || !AMOUNT_NAME.test(arg.name) || typeof arg.value !== 'string')
      return arg;
    const { asset, formatted } = amountOf(assetAt, 'base', token, arg.value);
    return { ...arg, ...(asset ? { asset, formatted } : {}) };
  });
}

/**
 * ADR-0063: a Base call, named by the built-in decoders when one knows its
 * selector, or else by the ABI registered for its target. Pure.
 */
export function decodeBaseCall(call: EvmCall, known: Known): CallView {
  const { assetAt } = known;
  const target = isAddress(call.to) ? getAddress(call.to) : call.to;
  const value = nativeValue(assetAt, call.value || '0');
  const base = { target, ...labelOf(known, 'base', call.to), ...(value ? { value } : {}) };
  const data = call.data.toLowerCase();
  if (data === '0x' || data === '') return { ...base, decoded: true };
  const selector = data.slice(0, 10);
  for (const { decoder, fn } of FUNCTIONS.filter(
    (f) => f.selector === selector && applies(f.decoder, call.to),
  )) {
    let values: readonly unknown[];
    try {
      values = decodeAbiParameters(fn.inputs, `0x${data.slice(10)}`);
    } catch {
      continue;
    }
    if (decoder.name === 'multicall3') {
      return {
        ...base,
        decoded: true,
        decoder: decoder.name,
        function: fn.name,
        selector,
        calls: innerCalls(values[0] as InnerCall[], known),
      };
    }
    return {
      ...base,
      decoded: true,
      decoder: decoder.name,
      function: fn.name,
      args: argsOf(decoder, fn.name, fn.inputs, values, call.to, assetAt),
      selector,
    };
  }
  const registered = known.contractAt('base', call.to)?.abi.functions.get(selector);
  if (registered) {
    try {
      const values = decodeAbiParameters(registered.inputs, `0x${data.slice(10)}`);
      return {
        ...base,
        decoded: true,
        decoder: 'abi',
        function: registered.name,
        args: registryArgs(registered.inputs, values, call.to, assetAt),
        selector,
      };
    } catch {
      // The data does not fit the registered function: shown raw, as if unknown.
    }
  }
  return {
    ...base,
    decoded: false,
    ...(data.length >= 10 ? { selector } : {}),
    data: call.data,
  };
}

type InnerCall = { target: string; allowFailure?: boolean; value?: bigint; callData: Hex };

function innerCalls(calls: readonly InnerCall[], known: Known): InnerCallView[] {
  return calls.map((inner) => ({
    ...decodeBaseCall(
      { to: inner.target, data: inner.callData, value: (inner.value ?? 0n).toString() },
      known,
    ),
    allowFailure: inner.allowFailure ?? false,
  }));
}

type DecodedLog = { event: EventView; transfers: TransferView[] };

function decodeLog(log: BaseLog, known: Known): DecodedLog | null {
  const { assetAt } = known;
  const candidates = EVENTS.filter(
    (e) =>
      e.topic === log.topics[0]?.toLowerCase() &&
      e.topicCount === log.topics.length &&
      applies(e.decoder, log.address),
  );
  for (const { decoder, event } of candidates) {
    let args: Record<string, unknown>;
    try {
      args = decodeEventLog({
        abi: [event],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
        strict: true,
      }).args;
    } catch {
      continue;
    }
    const source = getAddress(log.address);
    const values = event.inputs.map((input) => args[input.name!]);
    return {
      event: {
        kind: 'log',
        source,
        ...labelOf(known, 'base', source),
        decoder: decoder.name,
        name: event.name,
        args: argsOf(decoder, event.name, event.inputs, values, source, assetAt),
      },
      transfers: transfersOf(decoder.name, event.name, args, source, assetAt),
    };
  }
  return decodeRegisteredLog(log, known);
}

function decodeRegisteredLog(log: BaseLog, known: Known): DecodedLog | null {
  const contract = known.contractAt('base', log.address);
  const events = contract?.abi.events.get(log.topics[0]?.toLowerCase() ?? '') ?? [];
  for (const event of events) {
    let decoded: unknown;
    try {
      decoded = decodeEventLog({
        abi: [event],
        topics: log.topics as [Hex, ...Hex[]],
        data: log.data as Hex,
        strict: true,
      }).args;
    } catch {
      continue;
    }
    // An event with an unnamed input decodes to a list; a fully named one to a record.
    const values = event.inputs.map((input, i): unknown =>
      Array.isArray(decoded) ? decoded[i] : (decoded as Record<string, unknown>)[input.name!],
    );
    const source = getAddress(log.address);
    return {
      event: {
        kind: 'log',
        source,
        label: contract!.label,
        decoder: 'abi',
        name: event.name,
        args: registryArgs(event.inputs, values, source, known.assetAt),
      },
      transfers: [],
    };
  }
  return null;
}

function transfersOf(
  decoder: string,
  event: string,
  args: Record<string, unknown>,
  token: string,
  assetAt: AssetAt,
): TransferView[] {
  const party = (address: unknown) => {
    const at = getAddress(address as string);
    return at === zeroAddress ? null : at;
  };
  const amount = (raw: unknown) => amountOf(assetAt, 'base', token, raw as bigint);
  const key = `${decoder}.${event}`;
  switch (key) {
    case 'erc20.Transfer':
      return [
        {
          standard: 'erc20',
          token,
          from: party(args.from),
          to: party(args.to),
          ...amount(args.value),
        },
      ];
    case 'weth.Deposit':
      return [{ standard: 'erc20', token, from: null, to: party(args.to), ...amount(args.amount) }];
    case 'weth.Withdrawal':
      return [
        { standard: 'erc20', token, from: party(args.from), to: null, ...amount(args.amount) },
      ];
    case 'erc721.Transfer':
      return [
        {
          standard: 'erc721',
          token,
          from: party(args.from),
          to: party(args.to),
          tokenId: String(args.tokenId),
          amount: '1',
        },
      ];
    case 'erc1155.TransferSingle':
      return [
        {
          standard: 'erc1155',
          token,
          from: party(args.from),
          to: party(args.to),
          tokenId: String(args.id),
          amount: String(args.value),
        },
      ];
    case 'erc1155.TransferBatch': {
      const ids = args.ids as bigint[];
      const values = args.values as bigint[];
      return ids.map((id, i) => ({
        standard: 'erc1155' as const,
        token,
        from: party(args.from),
        to: party(args.to),
        tokenId: id.toString(),
        amount: String(values[i] ?? 0n),
      }));
    }
    default:
      return [];
  }
}

/** ADR-0063: a confirmed Base transaction's stored effects, decoded. Pure. */
export function decodeBaseEffects(effects: BaseEffects, known: Known): EffectsView {
  const { assetAt } = known;
  const events: EventView[] = [];
  const transfers: TransferView[] = [];
  const undecoded: string[] = [];
  const value = nativeValue(assetAt, effects.value);
  if (value && effects.to) {
    transfers.push({
      standard: 'native',
      token: NATIVE_ADDRESS,
      from: getAddress(effects.from),
      to: getAddress(effects.to),
      ...value,
    });
  }
  for (const log of effects.logs) {
    const decoded = decodeLog(log, known);
    if (!decoded) {
      undecoded.push(isAddress(log.address) ? getAddress(log.address) : log.address);
      continue;
    }
    events.push(decoded.event);
    transfers.push(...decoded.transfers);
  }
  return {
    transfers,
    ...(value ? { value } : {}),
    fee: {
      ...amountOf(assetAt, 'base', NATIVE_ADDRESS, effects.fee),
      payer: getAddress(effects.from),
    },
    events,
    undecodedEvents: undecoded.length,
    undecodedEventSources: undecodedSources(known, 'base', undecoded),
    truncated: effects.truncated,
  };
}
