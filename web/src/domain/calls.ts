import { formatAmount, type Money } from './assets';
import type { Chain } from './chains';

/**
 * ADR-0063: what a call item does, and what its transaction changed, as the
 * engine decodes them when the Dispatch is read (docs/openapi.yaml,
 * `DecodedCall` and `Effects`). Amounts of Known Assets arrive as `Money`.
 */

export type ArgValue = string | boolean | null | ArgValue[] | { [name: string]: ArgValue };

/** An amount in the smallest unit; `money` when the asset is a Known Asset. */
export interface AmountView {
  raw: string;
  money: Money | null;
}

export interface CallArg {
  name: string;
  type: string;
  value: ArgValue;
  /** An amount of a Known Asset. */
  money: Money | null;
}

export interface DecodedCall {
  target: string;
  /** The target's label in the contract registry. */
  label: string | null;
  /** A decoder named the function, or the call carries no data. */
  decoded: boolean;
  decoder: string | null;
  function: string | null;
  args: CallArg[];
  selector: string | null;
  /** Raw data, only when not decoded. */
  data: string | null;
  /** Base: native value sent with the call. */
  value: AmountView | null;
  /** Multicall3: each call it makes. */
  calls: DecodedCall[];
}

export interface Transfer extends AmountView {
  standard: string;
  token: string;
  from: string | null;
  to: string | null;
  tokenId: string | null;
}

export interface CallEvent {
  kind: 'log' | 'instruction';
  source: string;
  label: string | null;
  decoder: string;
  name: string;
  args: CallArg[];
}

export interface Effects {
  transfers: Transfer[];
  value: AmountView | null;
  fee: AmountView & { payer: string };
  events: CallEvent[];
  undecodedEvents: number;
  undecodedEventSources: { source: string; label: string | null; count: number }[];
  truncated: boolean;
}

/** `0x79bB…D793`: an address as a heading shows it. */
export function shortAddress(address: string): string {
  return address.length > 14 ? `${address.slice(0, 6)}…${address.slice(-4)}` : address;
}

/** What to call the target: its registry label, else its address shortened. */
export function targetName(call: Pick<DecodedCall, 'target' | 'label'>): string {
  return call.label ?? shortAddress(call.target);
}

/** A value as one line of text: `"flows row 4"`, `[7, 300]`, `{ days: 14 }`. */
export function argText(value: ArgValue): string {
  if (value === null) return 'none';
  if (typeof value === 'boolean') return String(value);
  if (typeof value === 'string') return value;
  if (Array.isArray(value)) return `[${value.map(argText).join(', ')}]`;
  return `{ ${Object.entries(value)
    .map(([key, v]) => `${key}: ${argText(v)}`)
    .join(', ')} }`;
}

/** One argument's value as people read it: an amount in its units, an address shortened. */
export function argDisplay(arg: CallArg): string {
  if (arg.money) return `${formatAmount(arg.money)} ${arg.money.asset}`;
  if (typeof arg.value === 'string' && (arg.type === 'address' || arg.type === 'pubkey')) {
    return shortAddress(arg.value);
  }
  if (arg.type === 'string' && typeof arg.value === 'string') return `"${arg.value}"`;
  return argText(arg.value);
}

/** `deposit(note: "flows row 4")`: the call on one line. Null when no decoder named it. */
export function callSignature(call: DecodedCall): string | null {
  if (!call.function) return null;
  const data = call.args.filter((a) => !(a.type === 'pubkey' && isAccountArg(call, a)));
  return `${call.function}(${data.map((a) => `${a.name}: ${argDisplay(a)}`).join(', ')})`;
}

/** Solana lists accounts before data; an account argument is a pubkey before the first non-pubkey. */
function isAccountArg(call: DecodedCall, arg: CallArg): boolean {
  const firstData = call.args.findIndex((a) => a.type !== 'pubkey');
  const index = call.args.indexOf(arg);
  return firstData === -1 || index < firstData;
}

/** What to add for a target the registry does not explain: an ABI on Base, an IDL on Solana. */
export function definitionName(chain: Chain): 'ABI' | 'IDL' {
  return chain === 'base' ? 'ABI' : 'IDL';
}

/** "1 event with no ABI", "3 instructions with no IDL". */
export function undecodedLine(chain: Chain, count: number): string {
  const noun = chain === 'base' ? 'event' : 'instruction';
  return `${count} ${noun}${count === 1 ? '' : 's'} with no ${definitionName(chain)}`;
}
