import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import fixture from './devnet-multisig-fixture.json' with { type: 'json' };
import {
  DEFAULT_APPROVAL_DEADLINE_MS,
  DEFAULT_APPROVAL_REWATCH_WINDOW_MS,
  deriveVaultAddress,
  resolveSolanaMultisigConfig,
  SQUADS_PROGRAM_ID,
  type RawSolanaMultisigSettings,
} from './multisig-config.js';

const MULTISIG = fixture.multisig;
const MEMBER = fixture.member;
const VAULT = fixture.vault;

const single: RawSolanaMultisigSettings = {
  senderMode: '',
  senderAddress: '',
  multisigAddress: '',
  memberAddress: '',
  approvalDeadlineMs: '',
  approvalRewatchWindowMs: '',
};
const multisig: RawSolanaMultisigSettings = {
  ...single,
  senderMode: 'multisig',
  multisigAddress: MULTISIG,
  memberAddress: MEMBER,
};

describe('deriveVaultAddress', () => {
  it('derives the real devnet vault of a real Squads multisig (the SDK computed the fixture)', () => {
    expect(deriveVaultAddress(new PublicKey(MULTISIG)).toBase58()).toBe(VAULT);
  });

  it('is the PDA of ["multisig", multisig, "vault", index] under the Squads v4 program, and off the curve', () => {
    const vault = deriveVaultAddress(new PublicKey(MULTISIG), 1);
    expect(vault.toBase58()).not.toBe(VAULT);
    expect(PublicKey.isOnCurve(vault.toBytes())).toBe(false);
    expect(SQUADS_PROGRAM_ID.toBase58()).toBe('SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf');
  });
});

describe('resolveSolanaMultisigConfig', () => {
  it('single mode (the default) is a no-op, whether the mode is unset or explicit', () => {
    expect(resolveSolanaMultisigConfig(single)).toBeUndefined();
    expect(resolveSolanaMultisigConfig({ ...single, senderMode: 'single' })).toBeUndefined();
    // A Sender address alone is today's configuration.
    expect(
      resolveSolanaMultisigConfig({
        ...single,
        senderAddress: Keypair.generate().publicKey.toBase58(),
      }),
    ).toBeUndefined();
  });

  it('refuses multisig settings left in single mode rather than silently ignoring them', () => {
    expect(() => resolveSolanaMultisigConfig({ ...single, multisigAddress: MULTISIG })).toThrow(
      /SOLANA_MULTISIG_ADDRESS set while SOLANA_SENDER_MODE is "single"/,
    );
    expect(() => resolveSolanaMultisigConfig({ ...single, memberAddress: MEMBER })).toThrow(
      /SOLANA_MULTISIG_MEMBER_ADDRESS set while SOLANA_SENDER_MODE is "single"/,
    );
  });

  it('single mode ignores the documented deadline defaults, so a copied .env.example still starts', () => {
    expect(
      resolveSolanaMultisigConfig({
        ...single,
        approvalDeadlineMs: '259200000',
        approvalRewatchWindowMs: '2592000000',
      }),
    ).toBeUndefined();
  });

  it('rejects an unknown mode', () => {
    expect(() => resolveSolanaMultisigConfig({ ...single, senderMode: 'squads' })).toThrow(
      /SOLANA_SENDER_MODE must be "single" or "multisig", got "squads"/,
    );
  });

  it('resolves a valid setup, deriving the vault as the Sender and applying the defaults', () => {
    expect(resolveSolanaMultisigConfig(multisig)).toEqual({
      multisigAddress: MULTISIG,
      memberAddress: MEMBER,
      vaultAddress: VAULT,
      approvalDeadlineMs: DEFAULT_APPROVAL_DEADLINE_MS,
      approvalRewatchWindowMs: DEFAULT_APPROVAL_REWATCH_WINDOW_MS,
    });
    expect(DEFAULT_APPROVAL_DEADLINE_MS).toBe(259_200_000);
    expect(DEFAULT_APPROVAL_REWATCH_WINDOW_MS).toBe(30 * 24 * 60 * 60 * 1000);
  });

  it('accepts a Sender address that is the vault, and overrides for both durations', () => {
    expect(
      resolveSolanaMultisigConfig({
        ...multisig,
        senderAddress: VAULT,
        approvalDeadlineMs: '3600000',
        approvalRewatchWindowMs: '7200000',
      }),
    ).toMatchObject({ approvalDeadlineMs: 3_600_000, approvalRewatchWindowMs: 7_200_000 });
  });

  it('refuses a Sender address that is not the vault, naming both', () => {
    const other = Keypair.generate().publicKey.toBase58();
    const attempt = () => resolveSolanaMultisigConfig({ ...multisig, senderAddress: other });
    expect(attempt).toThrow(/SOLANA_SENDER_ADDRESS/);
    expect(attempt).toThrow(new RegExp(VAULT));
  });

  it('requires both addresses, and names every problem at once', () => {
    const attempt = () => resolveSolanaMultisigConfig({ ...single, senderMode: 'multisig' });
    expect(attempt).toThrow(/SOLANA_MULTISIG_ADDRESS is required/);
    expect(attempt).toThrow(/SOLANA_MULTISIG_MEMBER_ADDRESS is required/);
  });

  it.each(['not-base58-0OIl', 'abc', '0x2d0b8242f5675eb51965488AC3C2f4038Ad8658E'])(
    'rejects %j as an address',
    (bad) => {
      expect(() => resolveSolanaMultisigConfig({ ...multisig, multisigAddress: bad })).toThrow(
        /SOLANA_MULTISIG_ADDRESS is not a valid base58 Solana address/,
      );
      expect(() => resolveSolanaMultisigConfig({ ...multisig, memberAddress: bad })).toThrow(
        /SOLANA_MULTISIG_MEMBER_ADDRESS is not a valid base58 Solana address/,
      );
    },
  );

  it('refuses a member that is the multisig itself, or an address nothing can sign for', () => {
    expect(() => resolveSolanaMultisigConfig({ ...multisig, memberAddress: MULTISIG })).toThrow(
      /must be different addresses/,
    );
    expect(() => resolveSolanaMultisigConfig({ ...multisig, memberAddress: VAULT })).toThrow(
      /off the ed25519 curve/,
    );
  });

  it.each(['0', '-5', '1.5', 'soon'])('rejects %j as a duration', (bad) => {
    expect(() => resolveSolanaMultisigConfig({ ...multisig, approvalDeadlineMs: bad })).toThrow(
      /SOLANA_APPROVAL_DEADLINE_MS must be a positive whole number of milliseconds/,
    );
    expect(() =>
      resolveSolanaMultisigConfig({ ...multisig, approvalRewatchWindowMs: bad }),
    ).toThrow(/SOLANA_APPROVAL_REWATCH_WINDOW_MS must be a positive whole number/);
  });
});
