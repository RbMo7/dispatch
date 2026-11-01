import { existsSync, readFileSync } from 'node:fs';

import { getAddress, isAddress } from 'viem';

import type { RawBaseSafeSettings } from './chain-handler/base/safe/safe-config.js';
import {
  deriveVaultAddress,
  parsePublicKey,
  type RawSolanaMultisigSettings,
} from './chain-handler/solana/multisig/multisig-config.js';
import type { Chain } from './domain/chain.js';
import { DEFAULT_SENDER_NAME, parseSenderName, type SenderName } from './domain/sender.js';

/**
 * ADR-0060: one configured Sender, in the raw settings shape its chain's
 * resolver (`resolveSolanaMultisigConfig`, `resolveBaseSafeConfig`) already
 * validates, so a Sender from the senders file and the single Sender of
 * today's variables are checked and built by exactly the same code.
 * `address` is what pays (the plain key, the vault, the Safe); it is '' only
 * for a variables-only Sender whose variables name none, which the loader
 * reports after the mode's own checks have had their say, as it always has.
 */
export type SolanaSenderSpec = {
  chain: 'solana';
  name: SenderName;
  address: string;
  settings: RawSolanaMultisigSettings;
  approverLabels: ApproverLabels;
};

export type BaseSenderSpec = {
  chain: 'base';
  name: SenderName;
  address: string;
  /** The key the Base handler signs and owns the nonce for: the Sender in `single` mode, the executor in `safe` mode. */
  handlerAddress: string;
  settings: RawBaseSafeSettings;
  approverLabels: ApproverLabels;
};

export type SenderSpec = SolanaSenderSpec | BaseSenderSpec;

/** A Multisig Sender's names for its Approvers, keyed by `sameAddressKey`. Empty for a plain Sender. */
export type ApproverLabels = Readonly<Record<string, string>>;

const MAX_APPROVER_LABEL = 40;

export type ChainSendersSpec = {
  chain: Chain;
  /** The Sender a Dispatch without `sender` pays from; null means every Dispatch on the chain must name one. */
  default: SenderName | null;
  senders: SenderSpec[];
};

export type SendersConfig = {
  source: 'file' | 'variables';
  /** One entry per enabled chain, in `ENABLED_CHAINS` order. */
  chains: ChainSendersSpec[];
  /** Startup warnings: settings the senders file makes the engine ignore. */
  warnings: string[];
};

/** Today's per-chain variables, exactly as config.ts reads them. */
export type SenderVariables = {
  solana: RawSolanaMultisigSettings;
  base: RawBaseSafeSettings;
};

export type SendersSource = { kind: 'file'; path: string; text: string } | { kind: 'variables' };

/** `SENDERS_FILE`, default `senders.json`. Without the default file, today's variables describe the Senders; a named file that is missing is an error. */
export function readSendersSource(sendersFile: string): SendersSource {
  const named = sendersFile.trim();
  const path = named || 'senders.json';
  if (!existsSync(path)) {
    if (named) throw new Error(`SENDERS_FILE names ${path}, which does not exist`);
    return { kind: 'variables' };
  }
  return { kind: 'file', path, text: readFileSync(path, 'utf8') };
}

/** SOLANA_SENDER_ADDRESS, or in multisig mode the vault of SOLANA_MULTISIG_ADDRESS ('' when that is invalid: its resolver reports it). */
export function solanaSenderAddress(settings: RawSolanaMultisigSettings): string {
  if (settings.senderAddress) return settings.senderAddress;
  if (settings.senderMode !== 'multisig') return '';
  const multisig = parsePublicKey(settings.multisigAddress.trim());
  return multisig ? deriveVaultAddress(multisig).toBase58() : '';
}

/** BASE_SENDER_ADDRESS, or in safe mode the executor. */
export function baseHandlerAddress(settings: RawBaseSafeSettings): string {
  return (
    settings.senderAddress || (settings.senderMode === 'safe' ? settings.safeExecutorAddress : '')
  );
}

/**
 * What pays on Base: the key in `single` mode, the Safe in `safe` mode
 * (ADR-0051). A malformed Safe address is left as typed: its resolver
 * refuses to start on it, before anything is sent.
 */
export function baseSenderAddress(settings: RawBaseSafeSettings): string {
  const safe = settings.safeAddress.trim();
  if (settings.senderMode.trim() !== 'safe' || safe === '') return baseHandlerAddress(settings);
  return isAddress(safe, { strict: false }) ? getAddress(safe) : safe;
}

function sendersFromVariables(
  enabledChains: readonly Chain[],
  variables: SenderVariables,
): SendersConfig {
  return {
    source: 'variables',
    warnings: [],
    chains: enabledChains.map((chain): ChainSendersSpec => {
      const sender: SenderSpec =
        chain === 'solana'
          ? {
              chain,
              name: DEFAULT_SENDER_NAME,
              address: solanaSenderAddress(variables.solana),
              settings: variables.solana,
              approverLabels: {},
            }
          : {
              chain,
              name: DEFAULT_SENDER_NAME,
              address: baseSenderAddress(variables.base),
              handlerAddress: baseHandlerAddress(variables.base),
              settings: variables.base,
              approverLabels: {},
            };
      return { chain, default: DEFAULT_SENDER_NAME, senders: [sender] };
    }),
  };
}

const MODES_BY_CHAIN: Record<Chain, readonly string[]> = {
  solana: ['single', 'squads'],
  base: ['single', 'safe'],
};

/** The fields each mode takes; anything else is a typo the engine would otherwise silently ignore. */
const FIELDS: Record<string, { required: readonly string[]; optional: readonly string[] }> = {
  single: { required: ['address'], optional: ['mode'] },
  squads: {
    required: ['mode', 'multisig', 'memberKey'],
    optional: ['approvalDeadlineMs', 'approvalRewatchWindowMs', 'approvers'],
  },
  safe: {
    required: ['mode', 'safe', 'executor'],
    optional: [
      'txServiceUrl',
      'apiKey',
      'approvalDeadlineMs',
      'approvalRewatchWindowMs',
      'bundleLimit',
      'approvers',
    ],
  },
};

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/** Chain-canonical spelling, for comparing addresses: EVM addresses are case-insensitive. */
export function sameAddressKey(chain: Chain, address: string): string {
  return chain === 'base' ? address.toLowerCase() : address;
}

/**
 * JSON keeps only the last of two equal keys, so a copied Sender that kept
 * its name would silently replace the first. The paths of every repeated key.
 */
export function duplicateKeys(text: string): string[] {
  type Frame =
    | { kind: 'object'; path: string; keys: Set<string>; key: string; awaitingKey: boolean }
    | { kind: 'array'; path: string };
  const stack: Frame[] = [];
  const duplicates: string[] = [];
  const childPath = (): string => {
    const top = stack.at(-1);
    if (!top) return '';
    if (top.kind === 'array') return `${top.path}[]`;
    return top.path ? `${top.path}.${top.key}` : top.key;
  };
  for (let i = 0; i < text.length; i++) {
    const c = text[i];
    if (c === '"') {
      let end = i + 1;
      while (end < text.length && text[end] !== '"') end += text[end] === '\\' ? 2 : 1;
      const top = stack.at(-1);
      if (top?.kind === 'object' && top.awaitingKey) {
        const key = JSON.parse(text.slice(i, end + 1)) as string;
        if (top.keys.has(key)) duplicates.push(top.path ? `${top.path}.${key}` : key);
        top.keys.add(key);
        top.key = key;
        top.awaitingKey = false;
      }
      i = end;
    } else if (c === '{') {
      stack.push({
        kind: 'object',
        path: childPath(),
        keys: new Set(),
        key: '',
        awaitingKey: true,
      });
    } else if (c === '[') {
      stack.push({ kind: 'array', path: childPath() });
    } else if (c === '}' || c === ']') {
      stack.pop();
    } else if (c === ',') {
      const top = stack.at(-1);
      if (top?.kind === 'object') top.awaitingKey = true;
    }
  }
  return duplicates;
}

function parseSenderEntry(
  chain: Chain,
  name: SenderName,
  entry: unknown,
  variables: SenderVariables,
  problem: (message: string) => void,
): SenderSpec | undefined {
  const where = `${chain} sender "${name}"`;
  if (!isRecord(entry)) {
    problem(`${where} must be an object`);
    return undefined;
  }
  const mode = entry.mode ?? 'single';
  if (typeof mode !== 'string' || !MODES_BY_CHAIN[chain].includes(mode)) {
    problem(
      `${where}: mode must be ${MODES_BY_CHAIN[chain].map((m) => `"${m}"`).join(' or ')}, got ${JSON.stringify(mode)}`,
    );
    return undefined;
  }
  const fields = FIELDS[mode] as (typeof FIELDS)[string];
  let valid = true;
  const fail = (message: string): void => {
    problem(`${where}: ${message}`);
    valid = false;
  };
  for (const key of Object.keys(entry)) {
    if (!fields.required.includes(key) && !fields.optional.includes(key)) {
      fail(`"${key}" is not a field of a ${mode} Sender`);
    }
  }
  const text = (key: string): string => {
    const value = entry[key];
    if (value === undefined) {
      if (fields.required.includes(key)) fail(`${key} is required for a ${mode} Sender`);
      return '';
    }
    if (typeof value !== 'string' || value.trim() === '') {
      fail(`${key} must be a non-empty string`);
      return '';
    }
    return value.trim();
  };
  const whole = (key: string): string => {
    const value = entry[key];
    if (value === undefined) return '';
    if (typeof value !== 'number' || !Number.isSafeInteger(value) || value <= 0) {
      fail(`${key} must be a positive whole number, got ${JSON.stringify(value)}`);
      return '';
    }
    return String(value);
  };
  const solanaAddress = (key: string): string => {
    const value = text(key);
    if (value && !parsePublicKey(value))
      fail(`${key} is not a valid base58 Solana address: ${value}`);
    return value;
  };
  const evmAddress = (key: string): string => {
    const value = text(key);
    if (!value) return '';
    if (!isAddress(value, { strict: true })) {
      fail(
        `${key} is not a valid address (a mixed-case address must have a correct checksum): ${value}`,
      );
      return '';
    }
    return getAddress(value);
  };
  const approverLabels = (): ApproverLabels => {
    const value = entry.approvers;
    if (value === undefined) return {};
    if (!isRecord(value)) {
      fail('approvers must be an object of Approver address to label');
      return {};
    }
    const labels: Record<string, string> = {};
    for (const [address, label] of Object.entries(value)) {
      const valid =
        chain === 'solana'
          ? parsePublicKey(address) !== undefined
          : isAddress(address, { strict: true });
      if (!valid) {
        fail(
          `approvers: ${address} is not a valid ${chain === 'solana' ? 'base58 Solana ' : ''}address`,
        );
        continue;
      }
      if (
        typeof label !== 'string' ||
        label.trim() === '' ||
        label.trim().length > MAX_APPROVER_LABEL
      ) {
        fail(`approvers: the label of ${address} must be 1 to ${MAX_APPROVER_LABEL} characters`);
        continue;
      }
      const key = sameAddressKey(chain, address);
      if (Object.hasOwn(labels, key)) {
        fail(`approvers: ${address} is listed twice`);
        continue;
      }
      labels[key] = label.trim();
    }
    return labels;
  };
  let spec: SenderSpec;
  if (chain === 'solana') {
    const settings: RawSolanaMultisigSettings =
      mode === 'squads'
        ? {
            senderMode: 'multisig',
            senderAddress: '',
            multisigAddress: solanaAddress('multisig'),
            memberAddress: solanaAddress('memberKey'),
            approvalDeadlineMs: whole('approvalDeadlineMs'),
            approvalRewatchWindowMs: whole('approvalRewatchWindowMs'),
          }
        : {
            senderMode: '',
            senderAddress: solanaAddress('address'),
            multisigAddress: '',
            memberAddress: '',
            approvalDeadlineMs: '',
            approvalRewatchWindowMs: '',
          };
    spec = {
      chain,
      name,
      address: solanaSenderAddress(settings),
      settings,
      approverLabels: approverLabels(),
    };
  } else {
    const settings: RawBaseSafeSettings =
      mode === 'safe'
        ? {
            senderMode: 'safe',
            senderAddress: '',
            safeAddress: evmAddress('safe'),
            safeExecutorAddress: evmAddress('executor'),
            txServiceUrl: entry.txServiceUrl === undefined ? '' : text('txServiceUrl'),
            apiKey: entry.apiKey === undefined ? variables.base.apiKey : text('apiKey'),
            approvalDeadlineMs: whole('approvalDeadlineMs'),
            approvalRewatchWindowMs: whole('approvalRewatchWindowMs'),
            bundleLimit: whole('bundleLimit'),
          }
        : {
            senderMode: '',
            senderAddress: evmAddress('address'),
            safeAddress: '',
            safeExecutorAddress: '',
            txServiceUrl: '',
            apiKey: '',
            approvalDeadlineMs: '',
            approvalRewatchWindowMs: '',
            bundleLimit: '',
          };
    spec = {
      chain,
      name,
      address: baseSenderAddress(settings),
      handlerAddress: baseHandlerAddress(settings),
      settings,
      approverLabels: approverLabels(),
    };
  }
  return valid ? spec : undefined;
}

/** The key the engine signs with for a Sender: the Sender itself, or a Multisig Sender's member key or executor. */
function engineKeyOf(spec: SenderSpec): string {
  if (spec.chain === 'solana') {
    return spec.settings.senderMode === 'multisig' ? spec.settings.memberAddress : spec.address;
  }
  return spec.handlerAddress;
}

/** The variables a senders file makes the engine ignore, if any are set for a chain the file describes. */
function ignoredVariables(chain: Chain, variables: SenderVariables): string[] {
  const set = (name: string, value: string | undefined): string[] =>
    value && value.trim() !== '' && value.trim() !== 'single' ? [name] : [];
  if (chain === 'solana') {
    const v = variables.solana;
    return [
      ...set('SOLANA_SENDER_ADDRESS', v.senderAddress),
      ...set('SOLANA_SENDER_MODE', v.senderMode),
      ...set('SOLANA_MULTISIG_ADDRESS', v.multisigAddress),
      ...set('SOLANA_MULTISIG_MEMBER_ADDRESS', v.memberAddress),
    ];
  }
  const v = variables.base;
  return [
    ...set('BASE_SENDER_ADDRESS', v.senderAddress),
    ...set('BASE_SENDER_MODE', v.senderMode),
    ...set('BASE_SAFE_ADDRESS', v.safeAddress),
    ...set('BASE_SAFE_EXECUTOR_ADDRESS', v.safeExecutorAddress),
  ];
}

function sendersFromFile(
  path: string,
  text: string,
  enabledChains: readonly Chain[],
  variables: SenderVariables,
): SendersConfig {
  const problems: string[] = [];
  const problem = (message: string): void => {
    problems.push(message);
  };
  const fail = (): never => {
    throw new Error(`invalid senders file ${path}:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  };

  let parsed: unknown;
  try {
    parsed = JSON.parse(text);
  } catch (cause) {
    problem(`not valid JSON: ${cause instanceof Error ? cause.message : String(cause)}`);
    return fail();
  }
  if (!isRecord(parsed)) {
    problem('the file must be a JSON object keyed by chain, e.g. { "solana": { … } }');
    return fail();
  }
  for (const key of duplicateKeys(text)) {
    const [chain, field, name] = key.split('.');
    problem(
      field === 'senders' && name !== undefined && key.split('.').length === 3
        ? `${chain} has two Senders named "${name}"; names must be unique per chain`
        : `"${key}" appears twice; JSON keeps only the last`,
    );
  }

  const chains: ChainSendersSpec[] = [];
  const warnings: string[] = [];
  for (const chain of enabledChains) {
    const block = parsed[chain];
    if (block === undefined) {
      problem(`${chain} is enabled (ENABLED_CHAINS) but the file has no Senders for it`);
      continue;
    }
    if (!isRecord(block)) {
      problem(`${chain} must be an object with "senders" and an optional "default"`);
      continue;
    }
    for (const key of Object.keys(block)) {
      if (key !== 'default' && key !== 'senders') {
        problem(
          `${chain}: "${key}" is not a field; a chain has "senders" and an optional "default"`,
        );
      }
    }
    const entries = block.senders;
    if (!isRecord(entries) || Object.keys(entries).length === 0) {
      problem(`${chain} is enabled (ENABLED_CHAINS) but has no Senders: add one under "senders"`);
      continue;
    }

    const senders: SenderSpec[] = [];
    for (const [rawName, entry] of Object.entries(entries)) {
      const name = parseSenderName(rawName);
      if (!name) {
        problem(
          `${chain} sender name "${rawName}" must be 1 to 40 lowercase letters, digits or hyphens`,
        );
        continue;
      }
      const spec = parseSenderEntry(chain, name, entry, variables, problem);
      if (spec) senders.push(spec);
    }

    const owner = new Map<string, string>();
    for (const spec of senders) {
      for (const address of new Set([spec.address, engineKeyOf(spec)])) {
        if (!address) continue;
        const key = sameAddressKey(chain, address);
        const first = owner.get(key);
        if (first !== undefined && first !== spec.name) {
          problem(
            `${chain} Senders "${first}" and "${spec.name}" share the address ${address}; each Sender needs its own keys and balances`,
          );
        } else {
          owner.set(key, spec.name);
        }
      }
    }

    let defaultName: SenderName | null = null;
    if (block.default !== undefined) {
      const named = typeof block.default === 'string' ? parseSenderName(block.default) : undefined;
      if (!named || !Object.hasOwn(entries, named)) {
        problem(
          `${chain} default ${JSON.stringify(block.default)} is not one of its Senders (${Object.keys(entries).join(', ')})`,
        );
      } else {
        defaultName = named;
      }
    }

    const ignored = ignoredVariables(chain, variables);
    if (ignored.length > 0) {
      warnings.push(
        `${ignored.join(', ')} ignored: the senders file ${path} describes ${chain}'s Senders`,
      );
    }
    chains.push({ chain, default: defaultName, senders });
  }

  if (problems.length > 0) return fail();
  return { source: 'file', chains, warnings };
}

/**
 * ADR-0060: the Senders of every enabled chain. Every problem in a senders
 * file is reported at once, one line each, and stops startup. Without a
 * file, today's variables describe one Sender per chain, named `default`.
 */
export function parseSendersConfig(input: {
  source: SendersSource;
  enabledChains: readonly Chain[];
  variables: SenderVariables;
}): SendersConfig {
  return input.source.kind === 'file'
    ? sendersFromFile(input.source.path, input.source.text, input.enabledChains, input.variables)
    : sendersFromVariables(input.enabledChains, input.variables);
}
