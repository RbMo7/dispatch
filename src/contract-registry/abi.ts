import {
  type AbiEvent,
  type AbiFunction,
  type AbiParameter,
  toEventSelector,
  toFunctionSelector,
} from 'viem';

import { err, ok, type Result } from '../domain/result.js';

/** A contract's ABI, indexed the way decoding looks it up. */
export type ParsedAbi = {
  /** By 4-byte selector, lowercase hex. */
  functions: ReadonlyMap<string, AbiFunction>;
  /** By topic 0, lowercase hex. Anonymous events have none, so they are left out. */
  events: ReadonlyMap<string, readonly AbiEvent[]>;
};

const ITEM_TYPES = ['function', 'event', 'constructor', 'fallback', 'receive', 'error'];
const INT_SIZES = Array.from({ length: 32 }, (_, i) => String((i + 1) * 8));

/** `uint256`, `bytes32`, `tuple[2][]`: canonical Solidity types only, as compilers write ABIs. */
function solidityTypeError(type: string): string | null {
  const base = type.replace(/(\[\d*\])+$/, '');
  if (/\[\d*\]/.test(base)) return `"${type}" is not a Solidity type`;
  if (['address', 'bool', 'string', 'bytes', 'tuple'].includes(base)) return null;
  const int = /^u?int(\d+)?$/.exec(base);
  if (int) {
    if (int[1] === undefined) return `"${type}" needs its size: write ${base}256`;
    return INT_SIZES.includes(int[1]) ? null : `"${type}" is not a Solidity type`;
  }
  const bytes = /^bytes(\d+)$/.exec(base);
  if (bytes && Number(bytes[1]) >= 1 && Number(bytes[1]) <= 32) return null;
  return `"${type}" is not a Solidity type`;
}

function parameters(raw: unknown, path: string, event: boolean): Result<AbiParameter[], string> {
  if (raw === undefined) return ok([]);
  if (!Array.isArray(raw)) return err(`${path}: must be an array of parameters`);
  const params: AbiParameter[] = [];
  for (const [i, entry] of raw.entries()) {
    const at = `${path}[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return err(`${at}: must be an object with a type`);
    }
    const { name, type, components, indexed } = entry as Record<string, unknown>;
    if (typeof type !== 'string') return err(`${at}.type: must be a string`);
    const typeError = solidityTypeError(type);
    if (typeError) return err(`${at}.type: ${typeError}`);
    if (name !== undefined && typeof name !== 'string') return err(`${at}.name: must be a string`);
    if (event && indexed !== undefined && typeof indexed !== 'boolean') {
      return err(`${at}.indexed: must be true or false`);
    }
    const param: Record<string, unknown> = { type, ...(name ? { name } : {}) };
    if (event && indexed) param.indexed = true;
    if (type.startsWith('tuple')) {
      if (!Array.isArray(components) || components.length === 0) {
        return err(`${at}.components: a tuple needs its components`);
      }
      const inner = parameters(components, `${at}.components`, false);
      if (!inner.ok) return inner;
      param.components = inner.value;
    }
    params.push(param as AbiParameter);
  }
  return ok(params);
}

/**
 * ADR-0063: reads a pasted ABI, a JSON array of ABI items or a compiler
 * artifact holding one in `abi`. Returns the array to store and its index, or
 * what is wrong, named by where it is.
 */
export function parseAbi(raw: unknown): Result<{ abi: unknown[]; parsed: ParsedAbi }, string> {
  const items =
    typeof raw === 'object' && raw !== null && !Array.isArray(raw) && 'abi' in raw ? raw.abi : raw;
  if (!Array.isArray(items)) return err('abi: must be a JSON array of ABI items');
  const functions = new Map<string, AbiFunction>();
  const events = new Map<string, AbiEvent[]>();
  for (const [i, entry] of items.entries()) {
    const at = `abi[${i}]`;
    if (typeof entry !== 'object' || entry === null || Array.isArray(entry)) {
      return err(`${at}: must be an object`);
    }
    const item = entry as Record<string, unknown>;
    // The Solidity ABI spec lets `type` default to function.
    const type = item.type ?? 'function';
    if (typeof type !== 'string' || !ITEM_TYPES.includes(type)) {
      return err(`${at}.type: must be one of ${ITEM_TYPES.join(', ')}`);
    }
    if (type !== 'function' && type !== 'event') continue;
    if (typeof item.name !== 'string' || !/^[A-Za-z_$][A-Za-z0-9_$]*$/.test(item.name)) {
      return err(`${at}.name: a ${type} needs a name`);
    }
    const inputs = parameters(item.inputs, `${at}.inputs`, type === 'event');
    if (!inputs.ok) return inputs;
    if (type === 'function') {
      const fn = { type, name: item.name, inputs: inputs.value } as unknown as AbiFunction;
      const selector = toFunctionSelector(fn).toLowerCase();
      if (!functions.has(selector)) functions.set(selector, fn);
    } else {
      if (item.anonymous === true) continue;
      const event = { type, name: item.name, inputs: inputs.value } as AbiEvent;
      const topic = toEventSelector(event).toLowerCase();
      events.set(topic, [...(events.get(topic) ?? []), event]);
    }
  }
  if (functions.size === 0 && events.size === 0) {
    return err('abi: has no functions or events, so it explains nothing');
  }
  return ok({ abi: items, parsed: { functions, events } });
}

function formatParam(param: AbiParameter): string {
  const type =
    param.type.startsWith('tuple') && 'components' in param
      ? `(${param.components.map(formatParam).join(', ')})${param.type.slice('tuple'.length)}`
      : param.type;
  const indexed = 'indexed' in param && param.indexed ? ' indexed' : '';
  return `${type}${indexed}${param.name ? ` ${param.name}` : ''}`;
}

/** `deposit(string note)`: what a function or event reads as. */
export function abiSignature(item: AbiFunction | AbiEvent): string {
  return `${item.name}(${item.inputs.map(formatParam).join(', ')})`;
}

/** What the ABI explains, as signatures: its functions, then its events. */
export function describeAbi(abi: ParsedAbi): { functions: string[]; events: string[] } {
  return {
    functions: [...abi.functions.values()].map(abiSignature),
    events: [...abi.events.values()].flat().map(abiSignature),
  };
}
