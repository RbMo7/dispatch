import { describe, expect, it } from 'vitest';

import fixture from '../../chain-handler/solana/multisig/devnet-multisig-fixture.json' with { type: 'json' };
import type {
  MultisigAccount,
  MultisigOnChainState,
} from '../../chain-handler/solana/multisig/multisig-account.js';
import { SQUADS_PROGRAM_ID } from '../../chain-handler/solana/multisig/multisig-config.js';
import type { SafeOnChainState } from '../../chain-handler/base/safe/safe-reads.js';
import type { PolicyRead } from '../../signer/client.js';
import type { CheckContext } from '../check.js';
import { safeStartup, squadsStartup } from '../multisig-startup.js';
import { fakeContext, goodEnv, result, token } from '../test-support/fake-context.js';

const squadsEnv = goodEnv({
  ENABLED_CHAINS: 'solana',
  BASE_SENDER_ADDRESS: '',
  SOLANA_SENDER_ADDRESS: '',
  SOLANA_SENDER_MODE: 'multisig',
  SOLANA_MULTISIG_ADDRESS: fixture.multisig,
  SOLANA_MULTISIG_MEMBER_ADDRESS: fixture.member,
});

const goodMultisig: MultisigAccount = {
  createKey: fixture.v2,
  configAuthority: '11111111111111111111111111111111',
  threshold: 2,
  timeLockSeconds: 0,
  transactionIndex: 0n,
  staleTransactionIndex: 0n,
  rentCollector: fixture.member,
  members: [
    { key: fixture.member, permissions: 5 },
    { key: fixture.v1, permissions: 7 },
    { key: fixture.v2, permissions: 7 },
  ],
};

const pinned: PolicyRead = {
  kind: 'pins',
  pins: { address: fixture.member, curve: 'ed25519', allowedMultisig: fixture.multisig },
};

/** The engine's real Squads startup checks, over a fake multisig read and Signer. */
function squads({
  multisig = {},
  state,
  pins = pinned,
}: {
  multisig?: Partial<MultisigAccount>;
  state?: MultisigOnChainState | Error;
  pins?: PolicyRead;
} = {}): CheckContext {
  const read: MultisigOnChainState | Error = state ?? {
    slot: 1,
    account: { owner: SQUADS_PROGRAM_ID.toBase58(), multisig: { ...goodMultisig, ...multisig } },
  };
  const readPins = () => Promise.resolve(pins);
  return fakeContext(squadsEnv, {
    signer: { readPins },
    multisigStartup: ({ multisig: setup, sender }) => {
      if (setup?.kind !== 'squads' || !sender) throw new Error('not a Squads Sender');
      return squadsStartup({
        config: setup.config,
        senderAddress: sender.address,
        readMultisig: () => (read instanceof Error ? Promise.reject(read) : Promise.resolve(read)),
        readSignerPins: readPins,
      });
    },
  });
}

describe('Multisig checks on a Squads Sender', () => {
  it('pass on a multisig the engine can act for', async () => {
    const context = squads();

    expect(await result(context, 'multisig.account:solana')).toEqual({
      status: 'pass',
      finding: `the Squads multisig ${fixture.multisig} exists, and its vault ${fixture.vault} is the Sender`,
    });
    expect((await result(context, 'multisig.member:solana')).status).toBe('pass');
    expect(await result(context, 'signer.pinned:solana')).toEqual({
      status: 'pass',
      finding: `the Signer pins ${fixture.member} to ${fixture.multisig}`,
    });
  });

  it('check the fee balance of the engine key, which pays the fees', async () => {
    expect((await result(squads(), 'sender.fees:solana')).finding).toContain(fixture.member);
    expect((await result(squads(), 'sender.tokens:solana')).finding).not.toContain(fixture.member);
  });

  it('fail a missing account, and leave the member unchecked', async () => {
    const context = squads({ state: { slot: 1, account: undefined } });

    expect(await result(context, 'multisig.account:solana')).toMatchObject({
      status: 'fail',
      fix: { setting: 'SOLANA_MULTISIG_ADDRESS' },
    });
    expect((await result(context, 'multisig.member:solana')).status).toBe('warn');
  });

  it('fail an engine key that is not a member, with the step in the Squads app', async () => {
    const context = squads({ multisig: { members: goodMultisig.members.slice(1) } });

    expect(await result(context, 'multisig.member:solana')).toMatchObject({
      status: 'fail',
      fix: {
        step: `In the Squads app, add ${fixture.member} as a member with Initiate and Execute only`,
      },
    });
    expect((await result(context, 'multisig.account:solana')).status).toBe('pass');
  });

  it('fail an engine key that can vote', async () => {
    const context = squads({
      multisig: {
        members: [{ key: fixture.member, permissions: 7 }, ...goodMultisig.members.slice(1)],
      },
    });

    expect((await result(context, 'multisig.member:solana')).status).toBe('fail');
  });

  it('warn on what the startup checks only warn about', async () => {
    expect(
      await result(squads({ multisig: { threshold: 1 } }), 'multisig.account:solana'),
    ).toMatchObject({
      status: 'warn',
      finding: expect.stringContaining('threshold of 1') as string,
    });
  });

  it('fail a key pinned to another multisig, with the Signer policy to set', async () => {
    const context = squads({
      pins: { kind: 'pins', pins: { ...pinned.pins, allowedMultisig: fixture.v1 } },
    });

    expect(await result(context, 'signer.pinned:solana')).toMatchObject({
      status: 'fail',
      fix: {
        step: `In the Signer's config, set policy.allowedMultisig to ${fixture.multisig} for ${fixture.member}, then restart the Signer (docs/self-hosting/signer.md)`,
      },
    });
  });

  it('fail a Signer too old to report pins', async () => {
    expect(
      (await result(squads({ pins: { kind: 'old-signer' } }), 'signer.pinned:solana')).status,
    ).toBe('fail');
  });

  it('leave the pin unchecked when the Signer has no key, which Key held fails', async () => {
    const context = squads({ pins: { kind: 'no-key' } });

    expect((await result(context, 'signer.pinned:solana')).status).toBe('warn');
    expect((await result(context, 'signer.key:solana')).status).toBe('fail');
  });

  it('never repeat the RPC URL a failed read carried', async () => {
    const secret = token();
    const context = squads({
      state: new Error(`request to https://rpc.example.com/?api-key=${secret} failed`),
    });

    const checked = await result(context, 'multisig.account:solana');

    expect(checked.status).toBe('fail');
    expect(JSON.stringify(checked)).not.toContain(secret);
  });
});

const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const EXECUTOR = '0x2d0b8242f5675eb51965488AC3C2f4038Ad8658E';
const OWNERS = [
  '0xE3372Dbf65B13291094F0A3520cb03dB155d8586',
  '0xA849e67B662129912513E2A8017B437f4251c0a5',
] as const;
const ZERO = '0x0000000000000000000000000000000000000000';

/** The engine's real Safe startup checks, over a fake chain read, Transaction Service and Signer. */
function safe({ delegated = true }: { delegated?: boolean } = {}): CheckContext {
  const env = goodEnv({
    ENABLED_CHAINS: 'base',
    SOLANA_SENDER_ADDRESS: '',
    BASE_SENDER_ADDRESS: '',
    BASE_SENDER_MODE: 'safe',
    BASE_SAFE_ADDRESS: SAFE,
    BASE_SAFE_EXECUTOR_ADDRESS: EXECUTOR,
    BASE_SAFE_API_KEY: token(),
  });
  const chain: SafeOnChainState = {
    blockNumber: 1n,
    chainId: 84532,
    hasCode: true,
    version: '1.4.1',
    owners: [...OWNERS],
    threshold: 2,
    nonce: 0n,
    guard: ZERO,
    modules: [],
  };
  const readPins = () =>
    Promise.resolve<PolicyRead>({
      kind: 'pins',
      pins: {
        address: EXECUTOR,
        curve: 'secp256k1',
        allowedSafe: SAFE.toLowerCase(),
        chainIds: [84532],
      },
    });
  return fakeContext(env, {
    signer: { readPins },
    multisigStartup: ({ multisig }) => {
      if (multisig?.kind !== 'safe') throw new Error('not a Safe Sender');
      return safeStartup({
        config: multisig.config,
        chainId: 84532,
        readSafe: () => Promise.resolve(chain),
        service: {
          about: () => Promise.resolve({ name: 'Safe Transaction Service', version: '5' }),
          getSafe: () =>
            Promise.resolve({
              address: SAFE,
              nonce: '0',
              threshold: 2,
              owners: [...OWNERS],
              modules: [],
              guard: ZERO,
              version: '1.4.1+L2',
            }),
          getDelegates: () =>
            Promise.resolve(
              delegated
                ? [
                    {
                      safe: SAFE,
                      delegate: EXECUTOR,
                      delegator: OWNERS[0],
                      label: 'engine',
                      expiryDate: null,
                    },
                  ]
                : [],
            ),
        },
        readSignerPins: readPins,
      });
    },
  });
}

describe('Multisig checks on a Safe Sender', () => {
  it('pass on a Safe the engine can act for', async () => {
    const context = safe();

    expect((await result(context, 'multisig.account:base')).status).toBe('pass');
    expect(await result(context, 'multisig.member:base')).toEqual({
      status: 'pass',
      finding: `${EXECUTOR} is a registered delegate and not an owner`,
    });
    expect((await result(context, 'signer.pinned:base')).status).toBe('pass');
  });

  it('fail an executor that is not a delegate, with the step for an owner', async () => {
    expect(await result(safe({ delegated: false }), 'multisig.member:base')).toMatchObject({
      status: 'fail',
      fix: {
        step: `Have a Safe owner register ${EXECUTOR} as a delegate of ${SAFE} (docs/self-hosting/multisig.md)`,
      },
    });
  });
});
