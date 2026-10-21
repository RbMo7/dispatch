import { PublicKey } from '@solana/web3.js';

import {
  DEFAULT_APPROVAL_DEADLINE_MS,
  DEFAULT_APPROVAL_REWATCH_WINDOW_MS,
} from '../../base/safe/safe-config.js';

export { DEFAULT_APPROVAL_DEADLINE_MS, DEFAULT_APPROVAL_REWATCH_WINDOW_MS };

/** The Squads v4 program, on mainnet and devnet alike (spike #70). */
export const SQUADS_PROGRAM_ID = new PublicKey('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');

/** ADR-0049: the Sender is vault index 0 of the multisig. */
export const SENDER_VAULT_INDEX = 0;

/**
 * The vault PDA `["multisig", multisig, "vault", u8 index]`: the address that
 * holds the funds and is the payments' source. Hand-derived (it is four seeds)
 * and checked against the SDK's `getVaultPda` and a real devnet vault in the tests.
 */
export function deriveVaultAddress(multisig: PublicKey, index = SENDER_VAULT_INDEX): PublicKey {
  const [vault] = PublicKey.findProgramAddressSync(
    [Buffer.from('multisig'), multisig.toBytes(), Buffer.from('vault'), Buffer.from([index])],
    SQUADS_PROGRAM_ID,
  );
  return vault;
}

/** ADR-0049: the engine's Multisig Sender config on Solana, validated once at startup. */
export type SolanaMultisigConfig = {
  /** The Squads multisig account. */
  multisigAddress: string;
  /** The ordinary key the engine proposes and executes with: pays fees, is never an Approver. */
  memberAddress: string;
  /** Vault index 0 of the multisig: the Sender, where the payments come from. */
  vaultAddress: string;
  /** ADR-0053: how long a proposal waits for approval before its Calls are `ABANDONED`. */
  approvalDeadlineMs: number;
  /** ADR-0053: how long an abandoned proposal is still watched for a late execution. */
  approvalRewatchWindowMs: number;
};

/** The unparsed `SOLANA_*` settings, exactly as config.ts reads them. */
export type RawSolanaMultisigSettings = {
  senderMode: string;
  senderAddress: string;
  multisigAddress: string;
  memberAddress: string;
  approvalDeadlineMs: string;
  approvalRewatchWindowMs: string;
};

/**
 * `single` (the default) is today's behavior and returns `undefined`.
 * `multisig` returns the validated config, or throws one error naming every
 * problem: a misconfiguration stops startup, never a payment.
 */
export function resolveSolanaMultisigConfig(
  raw: RawSolanaMultisigSettings,
): SolanaMultisigConfig | undefined {
  const mode = raw.senderMode.trim() === '' ? 'single' : raw.senderMode.trim();
  if (mode !== 'single' && mode !== 'multisig') {
    throw new Error(`SOLANA_SENDER_MODE must be "single" or "multisig", got "${raw.senderMode}"`);
  }

  if (mode === 'single') {
    const stray = (
      [
        ['SOLANA_MULTISIG_ADDRESS', raw.multisigAddress],
        ['SOLANA_MULTISIG_MEMBER_ADDRESS', raw.memberAddress],
      ] as const
    )
      .filter(([, value]) => value.trim() !== '')
      .map(([name]) => name);
    if (stray.length > 0) {
      throw new Error(
        `${stray.join(', ')} set while SOLANA_SENDER_MODE is "single" — set SOLANA_SENDER_MODE=multisig, or unset them`,
      );
    }
    return undefined;
  }

  const problems: string[] = [];
  const address = (name: string, value: string): PublicKey | undefined => {
    if (value.trim() === '') {
      problems.push(`${name} is required when SOLANA_SENDER_MODE=multisig`);
      return undefined;
    }
    const parsed = parsePublicKey(value.trim());
    if (!parsed) problems.push(`${name} is not a valid base58 Solana address: ${value}`);
    return parsed;
  };

  const multisig = address('SOLANA_MULTISIG_ADDRESS', raw.multisigAddress);
  const member = address('SOLANA_MULTISIG_MEMBER_ADDRESS', raw.memberAddress);
  const vault = multisig ? deriveVaultAddress(multisig) : undefined;

  if (member && !PublicKey.isOnCurve(member.toBytes())) {
    problems.push(
      `SOLANA_MULTISIG_MEMBER_ADDRESS (${member.toBase58()}) is not an ordinary key (it is off the ed25519 curve, so nothing can sign for it): it must be a wallet key, not a program address`,
    );
  }
  if (multisig && member && multisig.equals(member)) {
    problems.push(
      'SOLANA_MULTISIG_ADDRESS and SOLANA_MULTISIG_MEMBER_ADDRESS must be different addresses: the multisig cannot sign for itself',
    );
  }
  if (raw.senderAddress.trim() !== '') {
    const sender = address('SOLANA_SENDER_ADDRESS', raw.senderAddress);
    if (sender && vault && !sender.equals(vault)) {
      problems.push(
        `SOLANA_SENDER_ADDRESS (${sender.toBase58()}) must equal the multisig's vault (${vault.toBase58()}, derived from SOLANA_MULTISIG_ADDRESS): in multisig mode the vault is the Sender. Unset SOLANA_SENDER_ADDRESS to use it.`,
      );
    }
  }

  const duration = (name: string, value: string, fallback: number): number => {
    if (value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      problems.push(`${name} must be a positive whole number of milliseconds, got "${value}"`);
      return fallback;
    }
    return parsed;
  };
  const approvalDeadlineMs = duration(
    'SOLANA_APPROVAL_DEADLINE_MS',
    raw.approvalDeadlineMs,
    DEFAULT_APPROVAL_DEADLINE_MS,
  );
  const approvalRewatchWindowMs = duration(
    'SOLANA_APPROVAL_REWATCH_WINDOW_MS',
    raw.approvalRewatchWindowMs,
    DEFAULT_APPROVAL_REWATCH_WINDOW_MS,
  );

  if (problems.length > 0 || !multisig || !member || !vault) {
    throw new Error(
      `invalid Solana multisig sender config:\n${problems.map((p) => `  - ${p}`).join('\n')}`,
    );
  }

  return {
    multisigAddress: multisig.toBase58(),
    memberAddress: member.toBase58(),
    vaultAddress: vault.toBase58(),
    approvalDeadlineMs,
    approvalRewatchWindowMs,
  };
}

/** A canonical base58 32-byte address, or undefined. */
export function parsePublicKey(value: string): PublicKey | undefined {
  try {
    const key = new PublicKey(value);
    return key.toBase58() === value ? key : undefined;
  } catch {
    return undefined;
  }
}
