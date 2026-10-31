import { getAddress, isAddress } from 'viem';

import { parsePublicKey } from '../chain-handler/solana/multisig/multisig-config.js';
import { CHAINS, type Chain } from '../domain/chain.js';
import type {
  AssetLimit,
  FlagRule,
  FlagRuleDefinition,
  FlagRuleKind,
  FlagRuleSpec,
  FlagRuleVersion,
} from '../domain/flag-rule.js';
import { err, ok, type Result } from '../domain/result.js';
import type { AssetDecimals } from './asset-decimals.js';

/** Each kind's own parameters: anything else in the body is refused, so a typo never goes unnoticed. */
const PARAMETERS: Record<FlagRuleKind, readonly string[]> = {
  item_over: ['asset', 'limit'],
  dispatch_total_over: ['asset', 'limit'],
  daily_volume_over: ['asset', 'limit'],
  first_time_recipient: [],
  recipient_not_allowlisted: ['addresses'],
  call_target_not_allowlisted: ['addresses'],
};
const KINDS = Object.keys(PARAMETERS) as FlagRuleKind[];
const COMMON = ['name', 'chain', 'enabled', 'kind', 'reason'];

const DECIMAL = /^(\d+)(?:\.(\d+))?$/;

function parseAssetLimit(
  chain: Chain,
  body: Record<string, unknown>,
  decimalsOf: AssetDecimals,
): Result<AssetLimit, string> {
  const { asset, limit } = body;
  if (typeof asset !== 'string') return err('asset: required, a string');
  const decimals = decimalsOf(chain, asset);
  if (decimals === undefined) return err(`asset: ${asset} is not a known asset on ${chain}`);
  const match = typeof limit === 'string' ? DECIMAL.exec(limit) : null;
  if (!match)
    return err('limit: required, a decimal string in whole units, such as "5000" or "12.5"');
  const [, whole = '', fraction = ''] = match;
  if (fraction.length > decimals) {
    return err(
      `limit: ${asset} has ${decimals} decimal places, so "${String(limit)}" is too precise`,
    );
  }
  const limitUnits = BigInt(whole + fraction.padEnd(decimals, '0'));
  if (limitUnits === 0n) return err('limit: must be more than zero');
  return ok({ asset, limit: limit as string, limitUnits });
}

/** The canonical form a rule stores: checksummed on Base, exact base58 on Solana. */
function parseAddress(chain: Chain, address: string): string | undefined {
  if (chain === 'base')
    return isAddress(address, { strict: false }) ? getAddress(address) : undefined;
  return parsePublicKey(address)?.toBase58();
}

function parseAddresses(chain: Chain, raw: unknown): Result<string[], string> {
  if (!Array.isArray(raw)) return err('addresses: required, an array of addresses');
  const addresses: string[] = [];
  for (const [i, value] of raw.entries()) {
    const address = typeof value === 'string' ? parseAddress(chain, value) : undefined;
    if (!address) return err(`addresses[${i}]: not a valid ${chain} address`);
    if (!addresses.includes(address)) addresses.push(address);
  }
  return ok(addresses);
}

function parseDefinition(
  kind: FlagRuleKind,
  chain: Chain,
  body: Record<string, unknown>,
  decimalsOf: AssetDecimals,
): Result<FlagRuleDefinition, string> {
  switch (kind) {
    case 'item_over':
    case 'dispatch_total_over':
    case 'daily_volume_over': {
      const limit = parseAssetLimit(chain, body, decimalsOf);
      return limit.ok ? ok({ kind, ...limit.value }) : limit;
    }
    case 'first_time_recipient':
      return ok({ kind });
    case 'recipient_not_allowlisted':
    case 'call_target_not_allowlisted': {
      const addresses = parseAddresses(chain, body.addresses);
      return addresses.ok ? ok({ kind, addresses: addresses.value }) : addresses;
    }
  }
}

/**
 * A request body to a Flag Rule, or a message naming the field at fault.
 * Limits become integers in the asset's smallest unit here, with the
 * decimals the engine is configured with (ADR-0058).
 */
export function parseFlagRuleSpec(
  raw: unknown,
  decimalsOf: AssetDecimals,
): Result<FlagRuleSpec, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('the body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const { name, chain, enabled = true, kind } = body;
  if (typeof name !== 'string' || name.trim().length === 0) {
    return err('name: required, a non-empty string');
  }
  if (!CHAINS.includes(chain as Chain)) return err(`chain: must be one of ${CHAINS.join(', ')}`);
  if (typeof enabled !== 'boolean') return err('enabled: must be true or false');
  if (!KINDS.includes(kind as FlagRuleKind)) return err(`kind: must be one of ${KINDS.join(', ')}`);
  const ruleKind = kind as FlagRuleKind;
  const extra = Object.keys(body).find(
    (key) => !COMMON.includes(key) && !PARAMETERS[ruleKind].includes(key),
  );
  if (extra !== undefined) return err(`${extra}: not a parameter of ${ruleKind}`);
  const definition = parseDefinition(ruleKind, chain as Chain, body, decimalsOf);
  if (!definition.ok) return definition;
  return ok({ name: name.trim(), chain: chain as Chain, enabled, definition: definition.value });
}

/** A definition as the wire shows it: whole units only. */
export function toWireDefinition(definition: FlagRuleDefinition) {
  if ('limitUnits' in definition) {
    const { kind, asset, limit } = definition;
    return { kind, asset, limit };
  }
  return definition;
}

function toWireVersion(version: FlagRuleVersion) {
  return {
    version: version.version,
    name: version.name,
    chain: version.chain,
    enabled: version.enabled,
    ...toWireDefinition(version.definition),
    createdAt: version.createdAt.toISOString(),
  };
}

export function toWireRule(rule: FlagRule) {
  const { createdAt, ...current } = toWireVersion(rule.current);
  return {
    ruleId: rule.id,
    ...current,
    createdAt: rule.createdAt.toISOString(),
    updatedAt: createdAt,
    deletedAt: rule.deletedAt?.toISOString() ?? null,
    versions: rule.versions.map(toWireVersion),
  };
}
