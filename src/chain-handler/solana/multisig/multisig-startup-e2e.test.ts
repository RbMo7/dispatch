import { Connection } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { DEVNET_RPC_URL } from '../test-support/devnet-fixtures.js';
import fixture from './devnet-multisig-fixture.json' with { type: 'json' };
import { readMultisigState } from './multisig-account.js';
import { resolveSolanaMultisigConfig } from './multisig-config.js';
import { MultisigStartupError, runMultisigStartupChecks } from './startup-checks.js';

/**
 * Live, read-only (ADR-0013): the startup checks against a real throwaway
 * devnet 2-of-3 Squads v4 multisig (member = Initiate + Execute, rent
 * collector = member). Spends nothing and needs no keys; the Signer is the one
 * fake, since the member's key was discarded.
 */
const raw = {
  senderMode: 'multisig',
  senderAddress: '',
  multisigAddress: fixture.multisig,
  memberAddress: fixture.member,
  approvalDeadlineMs: '',
  approvalRewatchWindowMs: '',
};

function liveDeps(overrides: Partial<typeof raw> = {}) {
  const config = resolveSolanaMultisigConfig({ ...raw, ...overrides })!;
  const connection = new Connection(DEVNET_RPC_URL, 'confirmed');
  return {
    config,
    senderAddress: config.vaultAddress,
    readMultisig: (address: string) => readMultisigState(connection, address),
    readSignerPins: () =>
      Promise.resolve({
        kind: 'pins' as const,
        pins: {
          address: config.memberAddress,
          curve: 'ed25519' as const,
          allowedMultisig: config.multisigAddress,
        },
      }),
  };
}

describe('Multisig Sender startup checks against a real devnet Squads multisig', () => {
  it('reads the multisig, matches the fixture bytes, and passes with no warnings', async () => {
    const state = await readMultisigState(
      new Connection(DEVNET_RPC_URL, 'confirmed'),
      fixture.multisig,
    );
    expect(state.account).toMatchObject({
      owner: fixture.owner,
      multisig: { threshold: 2, timeLockSeconds: 0, rentCollector: fixture.member },
    });

    expect(await runMultisigStartupChecks(liveDeps())).toEqual({ warnings: [] });
  }, 60_000);

  it('refuses a member that can vote, and an address that holds no multisig', async () => {
    const stranger = await runMultisigStartupChecks(liveDeps({ memberAddress: fixture.v1 })).catch(
      (e: unknown) => e,
    );
    // v1 is a real member, but it holds Vote: that is what refuses it.
    expect(stranger).toBeInstanceOf(MultisigStartupError);
    expect((stranger as MultisigStartupError).failures.map((f) => f.check)).toContain(
      'member cannot vote',
    );

    const notMultisig = await runMultisigStartupChecks(
      liveDeps({ multisigAddress: fixture.v2 }),
    ).catch((e: unknown) => e);
    expect((notMultisig as MultisigStartupError).failures.map((f) => f.check)).toContain(
      'multisig exists',
    );
  }, 60_000);
});
