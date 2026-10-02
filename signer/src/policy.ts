import bs58 from 'bs58';
import { isAddress } from 'viem';

import type { Curve } from './backends/key-backend.js';
import { decodeTransaction, type TransactionEffects } from './effects.js';

/**
 * What one address may sign, per transaction. Every rule is optional and
 * independent; addresses are normalized as `normalizeAddress` does, so they
 * compare with the decoded effects directly.
 */
export type Policy = {
  chainIds?: ReadonlySet<number>;
  allowedDestinations?: ReadonlySet<string>;
  maxNativePerTransaction?: bigint;
  maxTokenPerTransaction?: ReadonlyMap<string, bigint>;
};

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

const POLICY_KEYS = [
  'chainIds',
  'allowedDestinations',
  'maxNativePerTransaction',
  'maxTokenPerTransaction',
];

/** EVM addresses lowercase, as the decoder reports them; a Solana address must be 32 bytes of base58. */
function normalizeAddress(curve: Curve, value: unknown): string | undefined {
  if (typeof value !== 'string') return undefined;
  if (curve === 'secp256k1') {
    return isAddress(value, { strict: false }) ? value.toLowerCase() : undefined;
  }
  try {
    return bs58.decode(value).length === 32 ? value : undefined;
  } catch {
    return undefined;
  }
}

/** JSON numbers can't hold wei, so amounts are decimal strings. */
function parseAmount(value: unknown): bigint | undefined {
  return typeof value === 'string' && /^\d+$/.test(value) ? BigInt(value) : undefined;
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null && !Array.isArray(value);
}

/**
 * Parses one config entry's `policy`. Returns every problem rather than the
 * first, and treats an unknown key as one, so a misspelled rule can't
 * silently go unenforced.
 */
export function parsePolicy(curve: Curve, raw: unknown): Policy | string[] {
  if (!isRecord(raw)) return ['policy must be an object'];
  const problems: string[] = [];
  const policy: Policy = {};

  for (const key of Object.keys(raw)) {
    if (!POLICY_KEYS.includes(key))
      problems.push(`policy has an unknown rule ${JSON.stringify(key)}`);
  }

  const { chainIds, allowedDestinations, maxNativePerTransaction, maxTokenPerTransaction } = raw;

  if (chainIds !== undefined) {
    if (curve !== 'secp256k1') {
      problems.push('policy.chainIds applies only to secp256k1 (EVM) addresses');
    } else if (
      !Array.isArray(chainIds) ||
      !chainIds.every((id) => Number.isSafeInteger(id) && (id as number) > 0)
    ) {
      problems.push('policy.chainIds must be an array of positive integers');
    } else {
      policy.chainIds = new Set(chainIds as number[]);
    }
  }

  if (allowedDestinations !== undefined) {
    if (!Array.isArray(allowedDestinations)) {
      problems.push('policy.allowedDestinations must be an array of addresses');
    } else {
      const normalized = allowedDestinations.map((value) => normalizeAddress(curve, value));
      allowedDestinations.forEach((value, index) => {
        if (normalized[index] === undefined) {
          problems.push(`policy.allowedDestinations has a bad address ${JSON.stringify(value)}`);
        }
      });
      policy.allowedDestinations = new Set(normalized.filter((v) => v !== undefined));
    }
  }

  if (maxNativePerTransaction !== undefined) {
    const amount = parseAmount(maxNativePerTransaction);
    if (amount === undefined) {
      problems.push(
        `policy.maxNativePerTransaction must be a decimal string of base units, got ${JSON.stringify(maxNativePerTransaction)}`,
      );
    } else {
      policy.maxNativePerTransaction = amount;
    }
  }

  if (maxTokenPerTransaction !== undefined) {
    if (!isRecord(maxTokenPerTransaction)) {
      problems.push('policy.maxTokenPerTransaction must be an object of token -> amount');
    } else {
      const caps = new Map<string, bigint>();
      for (const [token, value] of Object.entries(maxTokenPerTransaction)) {
        const address = normalizeAddress(curve, token);
        const amount = parseAmount(value);
        if (address === undefined) {
          problems.push(
            `policy.maxTokenPerTransaction has a bad token address ${JSON.stringify(token)}`,
          );
        } else if (amount === undefined) {
          problems.push(
            `policy.maxTokenPerTransaction.${token} must be a decimal string of base units, got ${JSON.stringify(value)}`,
          );
        } else {
          caps.set(address, amount);
        }
      }
      policy.maxTokenPerTransaction = caps;
    }
  }

  return problems.length > 0 ? problems : policy;
}

/** Checks decoded effects against a policy. Pure: the reason is the whole story. */
export function checkPolicy(policy: Policy, effects: TransactionEffects): PolicyDecision {
  const refuse = (reason: string): PolicyDecision => ({ ok: false, reason });

  if (policy.chainIds) {
    if (effects.chainId === undefined) return refuse('the transaction names no chain id');
    if (!policy.chainIds.has(effects.chainId)) {
      return refuse(`chain id ${effects.chainId} is not in chainIds`);
    }
  }

  if (policy.allowedDestinations) {
    if (effects.createsContract) return refuse('a contract creation has no allowed destination');
    const allowed = policy.allowedDestinations;
    const outside = effects.destinations.find((destination) => !allowed.has(destination));
    if (outside !== undefined)
      return refuse(`destination ${outside} is not in allowedDestinations`);
  }

  if (
    policy.maxNativePerTransaction !== undefined &&
    effects.native > policy.maxNativePerTransaction
  ) {
    return refuse(
      `native ${effects.native} exceeds maxNativePerTransaction ${policy.maxNativePerTransaction}`,
    );
  }

  const caps = policy.maxTokenPerTransaction;
  if (caps && caps.size > 0) {
    const bypass = effects.uncountedTokenMoves.find(
      (move) => move.token === undefined || caps.has(move.token),
    );
    if (bypass) {
      return refuse(
        `${bypass.what}${bypass.token === undefined ? '' : ` to token ${bypass.token}`} can't be counted against maxTokenPerTransaction`,
      );
    }
    for (const [token, cap] of caps) {
      const amount = effects.tokens.get(token) ?? 0n;
      if (amount > cap) {
        return refuse(`token ${token} amount ${amount} exceeds maxTokenPerTransaction ${cap}`);
      }
    }
  }

  return { ok: true };
}

/** Decodes and checks; whatever the decoder can't read is refused, since no rule could vouch for it. */
export function evaluatePolicy(policy: Policy, curve: Curve, unsigned: Uint8Array): PolicyDecision {
  const effects = decodeTransaction(curve, unsigned);
  if ('undecodable' in effects) {
    return { ok: false, reason: `undecodable transaction: ${effects.undecodable}` };
  }
  return checkPolicy(policy, effects);
}
