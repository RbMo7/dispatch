import { Keypair } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import type { PolicyRead } from '../../../signer/client.js';
import fixture from './devnet-multisig-fixture.json' with { type: 'json' };
import type { MultisigAccount, MultisigOnChainState } from './multisig-account.js';
import { resolveSolanaMultisigConfig, SQUADS_PROGRAM_ID } from './multisig-config.js';
import {
  MultisigStartupError,
  runMultisigStartupChecks,
  type MultisigStartupDeps,
} from './startup-checks.js';

const MEMBER = fixture.member;
const config = resolveSolanaMultisigConfig({
  senderMode: 'multisig',
  senderAddress: '',
  multisigAddress: fixture.multisig,
  memberAddress: MEMBER,
  approvalDeadlineMs: '',
  approvalRewatchWindowMs: '',
})!;

const goodMultisig: MultisigAccount = {
  createKey: Keypair.generate().publicKey.toBase58(),
  configAuthority: '11111111111111111111111111111111',
  threshold: 2,
  timeLockSeconds: 0,
  transactionIndex: 0n,
  staleTransactionIndex: 0n,
  rentCollector: MEMBER,
  members: [
    { key: MEMBER, permissions: 5 },
    { key: fixture.v1, permissions: 7 },
    { key: fixture.v2, permissions: 7 },
  ],
};

/** What a correctly configured Signer reports for the member (ADR-0055). */
const pinned: PolicyRead = {
  kind: 'pins',
  pins: { address: MEMBER, curve: 'ed25519', allowedMultisig: fixture.multisig },
};
const NO_KEY: PolicyRead = { kind: 'no-key' };

type Overrides = {
  config?: Partial<typeof config>;
  senderAddress?: string;
  multisig?: Partial<MultisigAccount>;
  owner?: string;
  state?: MultisigOnChainState | Error;
  signer?: PolicyRead | Error;
};

function deps(o: Overrides = {}): MultisigStartupDeps {
  const state: MultisigOnChainState | Error = o.state ?? {
    slot: 10,
    account: {
      owner: o.owner ?? SQUADS_PROGRAM_ID.toBase58(),
      multisig: { ...goodMultisig, ...o.multisig },
    },
  };
  return {
    config: { ...config, ...o.config },
    senderAddress: o.senderAddress ?? config.vaultAddress,
    readMultisig: () => (state instanceof Error ? Promise.reject(state) : Promise.resolve(state)),
    readSignerPins: () =>
      o.signer instanceof Error ? Promise.reject(o.signer) : Promise.resolve(o.signer ?? pinned),
  };
}

async function failureOf(o: Overrides): Promise<MultisigStartupError> {
  const error = await runMultisigStartupChecks(deps(o)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(MultisigStartupError);
  return error as MultisigStartupError;
}

describe('runMultisigStartupChecks', () => {
  it('starts on a valid setup and returns no warnings', async () => {
    expect(await runMultisigStartupChecks(deps())).toEqual({ warnings: [] });
  });

  it('leaves the pin check to the worker in the API, which has no Signer (ADR-0059)', async () => {
    const withoutSigner = deps({ signer: NO_KEY });
    delete withoutSigner.readSignerPins;

    expect(await runMultisigStartupChecks(withoutSigner)).toEqual({ warnings: [] });
  });

  it('refuses a multisig that does not exist', async () => {
    const error = await failureOf({ state: { slot: 1, account: undefined } });
    expect(error.failures).toEqual([expect.objectContaining({ check: 'multisig exists' })]);
    expect(error.message).toMatch(/no account at .*SOLANA_MULTISIG_ADDRESS is wrong/);
  });

  it('refuses an account the Squads program does not own', async () => {
    const error = await failureOf({ owner: '11111111111111111111111111111111' });
    expect(error.failures).toEqual([
      expect.objectContaining({ check: 'multisig owned by Squads v4' }),
    ]);
    expect(error.message).toMatch(/not the Squads v4 program SQDS4ep65T/);
  });

  it('refuses a Squads-owned account that is not a Multisig (for example a proposal)', async () => {
    const error = await failureOf({
      state: {
        slot: 1,
        account: {
          owner: SQUADS_PROGRAM_ID.toBase58(),
          multisig: { undecodable: 'wrong discriminator' },
        },
      },
    });
    expect(error.message).toMatch(/\[multisig readable\].*not a Multisig account/);
  });

  it('refuses when the RPC read fails', async () => {
    const error = await failureOf({ state: new Error('fetch failed') });
    expect(error.message).toMatch(/\[multisig readable\].*fetch failed/);
  });

  it('refuses a member key that is not in the multisig', async () => {
    const error = await failureOf({
      multisig: { members: goodMultisig.members.filter((m) => m.key !== MEMBER) },
    });
    expect(error.failures).toEqual([
      expect.objectContaining({ check: 'member is in the multisig' }),
    ]);
  });

  it.each([
    ['Vote only on top of Initiate + Execute (7)', 7],
    ['Initiate + Vote (3)', 3],
    ['Execute + Vote (6)', 6],
    ['Vote alone (2)', 2],
  ])('refuses a member that can vote: %s', async (_name, permissions) => {
    const error = await failureOf({
      multisig: {
        members: goodMultisig.members.map((m) => (m.key === MEMBER ? { ...m, permissions } : m)),
      },
    });
    expect(error.failures.map((f) => f.check)).toContain('member cannot vote');
    expect(error.message).toMatch(/must never be able to approve/);
  });

  it.each([
    ['Initiate only (1)', 1, 'Execute'],
    ['Execute only (4)', 4, 'Initiate'],
    ['no permissions (0)', 0, 'Initiate and Execute'],
  ])('refuses a member missing a needed permission: %s', async (_name, permissions, missing) => {
    const error = await failureOf({
      multisig: {
        members: goodMultisig.members.map((m) => (m.key === MEMBER ? { ...m, permissions } : m)),
      },
    });
    expect(error.failures).toEqual([
      expect.objectContaining({ check: 'member can initiate and execute' }),
    ]);
    expect(error.message).toContain(`lacks the ${missing} permission`);
  });

  it('refuses a mask that is not exactly 5 even without the Vote bit', async () => {
    const error = await failureOf({
      multisig: {
        members: goodMultisig.members.map((m) =>
          m.key === MEMBER ? { ...m, permissions: 13 } : m,
        ),
      },
    });
    expect(error.failures).toEqual([
      expect.objectContaining({ check: 'member permission mask is exactly 5' }),
    ]);
  });

  it('refuses a Signer that has no key for the member, or cannot be reached', async () => {
    const none = await failureOf({ signer: NO_KEY });
    expect(none.failures).toEqual([
      expect.objectContaining({ check: 'signer can sign for the member' }),
    ]);
    expect(none.message).toContain(`no key for ${MEMBER}`);

    for (const signer of [
      { kind: 'unreachable', message: 'ECONNREFUSED' } as const,
      new Error('ECONNREFUSED'),
    ]) {
      const error = await failureOf({ signer });
      expect(error.message).toMatch(/could not ask the Signer.*SIGNER_AUTH_TOKEN/);
    }
  });

  it('refuses a key the Signer does not pin to this multisig, or pins to none', async () => {
    const other = Keypair.generate().publicKey.toBase58();
    const wrong = await failureOf({
      signer: { kind: 'pins', pins: { address: MEMBER, curve: 'ed25519', allowedMultisig: other } },
    });
    expect(wrong.failures).toEqual([
      expect.objectContaining({ check: 'signer pins the multisig' }),
    ]);
    expect(wrong.message).toContain(`pins ${other}`);
    expect(wrong.message).toContain(`SOLANA_MULTISIG_ADDRESS is ${fixture.multisig}`);

    const none = await failureOf({
      signer: { kind: 'pins', pins: { address: MEMBER, curve: 'ed25519' } },
    });
    expect(none.message).toMatch(/\[signer pins the multisig\].*pins no multisig/);
  });

  it('refuses a Signer without the policy route, and tells the operator to upgrade it', async () => {
    const error = await failureOf({ signer: { kind: 'old-signer' } });
    expect(error.failures).toEqual([
      expect.objectContaining({ check: 'signer pins the multisig' }),
    ]);
    expect(error.message).toMatch(/older Signer.*upgrade the Signer/);
  });

  it('refuses when the Sender address is not the derived vault', async () => {
    const error = await failureOf({ senderAddress: Keypair.generate().publicKey.toBase58() });
    expect(error.failures).toEqual([expect.objectContaining({ check: 'sender is the vault' })]);
    expect(error.message).toContain(config.vaultAddress);
  });

  it('lists every failed check at once', async () => {
    const error = await failureOf({
      state: { slot: 1, account: undefined },
      signer: NO_KEY,
      senderAddress: Keypair.generate().publicKey.toBase58(),
    });
    expect(error.failures.map((f) => f.check)).toEqual([
      'sender is the vault',
      'multisig exists',
      'signer can sign for the member',
    ]);
  });

  describe('warnings', () => {
    it('warns, but starts, at a threshold of 1', async () => {
      const { warnings } = await runMultisigStartupChecks(deps({ multisig: { threshold: 1 } }));
      expect(warnings).toEqual([expect.stringMatching(/threshold of 1.*no second approver/)]);
    });

    it('warns when no rent collector is set, since rent can never be reclaimed', async () => {
      const { warnings } = await runMultisigStartupChecks(
        deps({ multisig: { rentCollector: undefined } }),
      );
      expect(warnings).toEqual([expect.stringMatching(/no rent collector.*6032/)]);
    });

    it('warns when the rent collector is someone other than the member key', async () => {
      const other = Keypair.generate().publicKey.toBase58();
      const { warnings } = await runMultisigStartupChecks(
        deps({ multisig: { rentCollector: other } }),
      );
      expect(warnings).toEqual([expect.stringContaining(`rent collector is ${other}`)]);
    });

    it('warns when the time lock outlasts the approval deadline', async () => {
      const { warnings } = await runMultisigStartupChecks(
        deps({ config: { approvalDeadlineMs: 60_000 }, multisig: { timeLockSeconds: 61 } }),
      );
      expect(warnings).toEqual([
        expect.stringMatching(/time lock \(61s\).*SOLANA_APPROVAL_DEADLINE_MS/),
      ]);
      expect(
        (
          await runMultisigStartupChecks(
            deps({ config: { approvalDeadlineMs: 60_000 }, multisig: { timeLockSeconds: 60 } }),
          )
        ).warnings,
      ).toEqual([]);
    });

    it('warns when the threshold exceeds the voting members', async () => {
      const { warnings } = await runMultisigStartupChecks(deps({ multisig: { threshold: 3 } }));
      expect(warnings).toEqual([expect.stringMatching(/threshold \(3\).*voting members \(2\)/)]);
    });
  });
});
