import bs58 from 'bs58';
import { isAddress, parseTransaction, toHex } from 'viem';

import type { Curve } from './backends/key-backend.js';
import { decodeTransaction, type TransactionEffects } from './effects.js';
import {
  decodeExecTransaction,
  EXEC_TRANSACTION_SELECTOR,
  type SafeCall,
  type SafeTransaction,
} from './safe-transaction.js';
import { checkMultisigMessage } from './squads.js';

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
  /** EVM: the one Safe this key may execute and propose for (ADR-0052); setting it makes every other transaction refused. */
  allowedSafe?: string;
  /** With `allowedSafe`: the MultiSendCallOnly contracts a Safe transaction may delegatecall. */
  allowedMultiSend?: ReadonlySet<string>;
  /** Solana: the one Squads multisig this key may propose, execute and close for (ADR-0049); every other transaction is refused. */
  allowedMultisig?: string;
};

/** MultiSendCallOnly per Safe version (spike #79): 1.4.1, then 1.3.0 eip155 and canonical. */
export const DEFAULT_MULTI_SEND_CALL_ONLY: readonly string[] = [
  '0x9641d764fc13c8b624c04430c7356c1c7c8102e2',
  '0xa1dabef33b3b82c7814b6d82a79e50f4ac44102b',
  '0x40a2accbd92bca938b02010e17a5b8929b49130d',
];

const ZERO_ADDRESS = '0x0000000000000000000000000000000000000000';

export type PolicyDecision = { ok: true } | { ok: false; reason: string };

const POLICY_KEYS = [
  'chainIds',
  'allowedDestinations',
  'maxNativePerTransaction',
  'maxTokenPerTransaction',
  'allowedSafe',
  'allowedMultiSend',
  'allowedMultisig',
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

  const {
    chainIds,
    allowedDestinations,
    maxNativePerTransaction,
    maxTokenPerTransaction,
    allowedSafe,
    allowedMultiSend,
    allowedMultisig,
  } = raw;

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

  if (allowedSafe !== undefined) {
    const safe = normalizeAddress(curve, allowedSafe);
    if (curve !== 'secp256k1') {
      problems.push('policy.allowedSafe applies only to secp256k1 (EVM) addresses');
    } else if (safe === undefined) {
      problems.push(
        `policy.allowedSafe must be an EVM address, got ${JSON.stringify(allowedSafe)}`,
      );
    } else {
      policy.allowedSafe = safe;
      // A Safe address means nothing without its chain, so the config must name it.
      if (chainIds === undefined) problems.push('policy.allowedSafe requires policy.chainIds');
    }
  }

  if (allowedMultiSend !== undefined) {
    if (curve !== 'secp256k1' || allowedSafe === undefined) {
      problems.push('policy.allowedMultiSend applies only with policy.allowedSafe');
    } else if (!Array.isArray(allowedMultiSend) || allowedMultiSend.length === 0) {
      problems.push('policy.allowedMultiSend must be a non-empty array of addresses');
    } else {
      const normalized = allowedMultiSend.map((value) => normalizeAddress(curve, value));
      allowedMultiSend.forEach((value, index) => {
        if (normalized[index] === undefined) {
          problems.push(`policy.allowedMultiSend has a bad address ${JSON.stringify(value)}`);
        }
      });
      policy.allowedMultiSend = new Set(normalized.filter((v) => v !== undefined));
    }
  } else if (policy.allowedSafe !== undefined) {
    policy.allowedMultiSend = new Set(DEFAULT_MULTI_SEND_CALL_ONLY);
  }

  if (allowedMultisig !== undefined) {
    const multisig = normalizeAddress(curve, allowedMultisig);
    if (curve !== 'ed25519') {
      problems.push('policy.allowedMultisig applies only to ed25519 (Solana) addresses');
    } else if (multisig === undefined) {
      problems.push(
        `policy.allowedMultisig must be a Solana address, got ${JSON.stringify(allowedMultisig)}`,
      );
    } else {
      policy.allowedMultisig = multisig;
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
export function evaluatePolicy(
  policy: Policy,
  curve: Curve,
  unsigned: Uint8Array,
  /** The address being signed for; `allowedMultisig` needs it to check the fee payer. */
  signer?: string,
): PolicyDecision {
  if (policy.allowedMultisig !== undefined) {
    const decision = checkMultisigMessage(policy.allowedMultisig, signer, unsigned);
    if (!decision.ok) return decision;
  }
  if (policy.allowedSafe !== undefined) {
    const decision = checkSafeExecution(policy, unsigned);
    if (!decision.ok) return decision;
  }
  const effects = decodeTransaction(curve, unsigned);
  if ('undecodable' in effects) {
    return { ok: false, reason: `undecodable transaction: ${effects.undecodable}` };
  }
  return checkPolicy(policy, effects);
}

/** The Safe transaction's own fields: a delegatecall to MultiSendCallOnly that never refunds the executor (ADR-0051). */
function checkSafeCall(policy: Policy, call: SafeCall): PolicyDecision {
  const refuse = (reason: string): PolicyDecision => ({ ok: false, reason });

  if (call.operation !== 1) {
    return refuse(
      'the Safe transaction is a call; only a delegatecall to MultiSendCallOnly is allowed',
    );
  }
  if (!policy.allowedMultiSend?.has(call.to.toLowerCase())) {
    return refuse(
      `the Safe transaction delegatecalls ${call.to}, which is not an allowed MultiSendCallOnly`,
    );
  }
  for (const field of ['safeTxGas', 'baseGas', 'gasPrice'] as const) {
    if (call[field] !== 0n) return refuse(`the Safe transaction's ${field} is not zero`);
  }
  for (const field of ['gasToken', 'refundReceiver'] as const) {
    if (call[field].toLowerCase() !== ZERO_ADDRESS) {
      return refuse(`the Safe transaction's ${field} is not the zero address`);
    }
  }
  return { ok: true };
}

/** An EIP-1559 `execTransaction` to the pinned Safe, on an allowed chain, with checked fields. Never reads the nested payments (ADR-0049). */
function checkSafeExecution(policy: Policy, unsigned: Uint8Array): PolicyDecision {
  const refuse = (reason: string): PolicyDecision => ({ ok: false, reason });
  let tx: ReturnType<typeof parseTransaction>;
  try {
    tx = parseTransaction(toHex(unsigned));
  } catch (cause) {
    return refuse(
      `undecodable transaction: ${cause instanceof Error ? cause.message : String(cause)}`,
    );
  }
  if (tx.type !== 'eip1559') {
    return refuse(
      `a key pinned to a Safe signs only EIP-1559 transactions, not ${String(tx.type)}`,
    );
  }
  if (tx.chainId === undefined || !policy.chainIds?.has(tx.chainId)) {
    return refuse(`chain id ${String(tx.chainId)} is not in chainIds`);
  }
  if (tx.to?.toLowerCase() !== policy.allowedSafe) {
    return refuse(`destination ${String(tx.to?.toLowerCase())} is not the allowedSafe`);
  }
  const data = tx.data ?? '0x';
  if (data.slice(0, 10).toLowerCase() !== EXEC_TRANSACTION_SELECTOR) {
    return refuse(`call ${data === '0x' ? '(none)' : data.slice(0, 10)} is not execTransaction`);
  }
  const call = decodeExecTransaction(data);
  if (typeof call === 'string') return refuse(`undecodable transaction: ${call}`);
  return checkSafeCall(policy, call);
}

/**
 * A Safe transaction as typed data (ADR-0052). A key with no policy never
 * reaches here. A key with one signs it only if the policy pins the Safe
 * with `allowedSafe`, and then only the same transaction `execTransaction`
 * may carry: this Safe, an allowed chain, the checked fields.
 */
export function evaluateSafeTransactionPolicy(
  policy: Policy,
  transaction: SafeTransaction,
): PolicyDecision {
  if (policy.allowedSafe === undefined) {
    return {
      ok: false,
      reason: 'the policy has no allowedSafe, so it does not sign Safe transactions',
    };
  }
  if (transaction.safe.toLowerCase() !== policy.allowedSafe) {
    return { ok: false, reason: `the Safe ${transaction.safe} is not the allowedSafe` };
  }
  if (!policy.chainIds?.has(transaction.chainId)) {
    return { ok: false, reason: `chain id ${transaction.chainId} is not in chainIds` };
  }
  return checkSafeCall(policy, transaction);
}
