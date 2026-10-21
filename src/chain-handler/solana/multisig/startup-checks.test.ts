import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { Keypair, VersionedMessage } from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { SignerClient } from '../../../signer/client.js';
import fixture from './devnet-multisig-fixture.json' with { type: 'json' };
import type { MultisigAccount, MultisigOnChainState } from './multisig-account.js';
import { resolveSolanaMultisigConfig, SQUADS_PROGRAM_ID } from './multisig-config.js';
import {
  MultisigStartupError,
  probeSignerForSolanaAddress,
  runMultisigStartupChecks,
  type MultisigStartupDeps,
  type SignerProbe,
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

type Overrides = {
  config?: Partial<typeof config>;
  senderAddress?: string;
  multisig?: Partial<MultisigAccount>;
  owner?: string;
  state?: MultisigOnChainState | Error;
  signer?: SignerProbe | Error;
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
    probeSigner: () =>
      o.signer instanceof Error ? Promise.reject(o.signer) : Promise.resolve(o.signer ?? 'has-key'),
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
    const none = await failureOf({ signer: 'no-key' });
    expect(none.failures).toEqual([
      expect.objectContaining({ check: 'signer can sign for the member' }),
    ]);
    expect(none.message).toContain(`no key for ${MEMBER}`);

    for (const signer of ['unreachable', new Error('ECONNREFUSED')] as const) {
      const error = await failureOf({ signer });
      expect(error.message).toMatch(/could not ask the Signer.*SIGNER_AUTH_TOKEN/);
    }
  });

  it('refuses when the Sender address is not the derived vault', async () => {
    const error = await failureOf({ senderAddress: Keypair.generate().publicKey.toBase58() });
    expect(error.failures).toEqual([expect.objectContaining({ check: 'sender is the vault' })]);
    expect(error.message).toContain(config.vaultAddress);
  });

  it('lists every failed check at once', async () => {
    const error = await failureOf({
      state: { slot: 1, account: undefined },
      signer: 'no-key',
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

describe('probeSignerForSolanaAddress', () => {
  let server: Server | undefined;
  afterEach(() => server?.close());

  async function signerAnswering(status: number, body: unknown): Promise<SignerClient> {
    server = createServer((_req, res) => {
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    return new SignerClient(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'token',
      2000,
    );
  }

  it('maps a policy 403 and a decode 400 to has-key, 404 to no-key, anything else to unreachable', async () => {
    const answer = async (status: number, body: unknown) => {
      const result = await probeSignerForSolanaAddress(await signerAnswering(status, body), MEMBER);
      server?.close();
      return result;
    };
    expect(await answer(403, { error: 'policy refused', reason: 'cannot decode' })).toBe('has-key');
    expect(await answer(400, { error: 'bad' })).toBe('has-key');
    expect(await answer(404, { error: 'no key' })).toBe('no-key');
    expect(await answer(401, {})).toBe('unreachable');
    expect(await answer(503, {})).toBe('unreachable');
  });

  it('asks about the member on solana/ed25519 and sends bytes that are not a transaction', async () => {
    let received: {
      chain?: string;
      curve?: string;
      address?: string;
      unsignedTransaction?: string;
    } = {};
    server = createServer((req, res) => {
      let raw = '';
      req.on('data', (chunk) => (raw += chunk));
      req.on('end', () => {
        received = JSON.parse(raw) as typeof received;
        res.writeHead(403, { 'content-type': 'application/json' });
        res.end('{}');
      });
    });
    await new Promise<void>((resolve) => server!.listen(0, '127.0.0.1', resolve));
    const client = new SignerClient(
      `http://127.0.0.1:${(server.address() as AddressInfo).port}`,
      'token',
      2000,
    );
    await probeSignerForSolanaAddress(client, MEMBER);
    expect(received).toMatchObject({ chain: 'solana', curve: 'ed25519', address: MEMBER });
    const bytes = Buffer.from(received.unsignedTransaction ?? '', 'base64');
    expect(bytes.length).toBeLessThan(8);
    expect(() => VersionedMessage.deserialize(bytes)).toThrow();
  });
});
