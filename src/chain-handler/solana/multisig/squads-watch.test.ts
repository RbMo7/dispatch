import { createPrivateKey, sign as nodeSign } from 'node:crypto';

import {
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import pino from 'pino';
import { describe, expect, it, vi } from 'vitest';

import { checkMultisigMessage } from '../../../../signer/src/squads.js';
import type { DispatchError } from '../../../domain/errors.js';
import type { ChainProposalRef, Proposal } from '../../../domain/proposal.js';
import { err, ok, type Result } from '../../../domain/result.js';
import type { SignerClient } from '../../../signer/client.js';
import type { PreparedTransaction } from '../../chain-handler.js';
import { decodeInstruction, SolanaChainHandler } from '../solana-chain-handler.js';
import golden from './squads-watch-golden.json' with { type: 'json' };
import { MULTISIG_DISCRIMINATOR } from './multisig-account.js';
import { deriveVaultAddress, SQUADS_PROGRAM_ID } from './multisig-config.js';
import {
  decodeProposalAccount,
  PROPOSAL_DISCRIMINATOR,
  type ProposalStatusKind,
} from './proposal-account.js';
import { SquadsApproval, type SquadsConnection } from './squads-approval.js';
import {
  decodeVaultTransactionAccount,
  deriveProposalPda,
  deriveTransactionPda,
} from './vault-transaction.js';

const key = (n: number) => new PublicKey(Buffer.alloc(32, n));
const MEMBER = Keypair.generate();
const MULTISIG = Keypair.generate().publicKey;
const COLLECTOR = Keypair.generate().publicKey;
const SEED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');
const INDEX = 5n;
const PROPOSAL = deriveProposalPda(MULTISIG, INDEX);
const TRANSACTION = deriveTransactionPda(MULTISIG, INDEX);
const T0 = 1_700_000_000; // an approval time, in unix seconds
const NOW = new Date((T0 + 1_000) * 1000);

// ---- account fixtures -------------------------------------------------------------------------

function proposalBytes(o: {
  status: ProposalStatusKind;
  timestamp?: number;
  index?: bigint;
  multisig?: PublicKey;
  approved?: PublicKey[];
  rejected?: PublicKey[];
  cancelled?: PublicKey[];
}): Buffer {
  const tags: ProposalStatusKind[] = [
    'draft',
    'active',
    'rejected',
    'approved',
    'executing',
    'executed',
    'cancelled',
  ];
  const index = Buffer.alloc(8);
  index.writeBigUInt64LE(o.index ?? INDEX);
  const status = [Buffer.from([tags.indexOf(o.status)])];
  if (o.status !== 'executing') {
    const ts = Buffer.alloc(8);
    ts.writeBigInt64LE(BigInt(o.timestamp ?? T0));
    status.push(ts);
  }
  const vec = (keys: PublicKey[] = []) => {
    const n = Buffer.alloc(4);
    n.writeUInt32LE(keys.length);
    return Buffer.concat([n, ...keys.map((k) => k.toBuffer())]);
  };
  return Buffer.concat([
    PROPOSAL_DISCRIMINATOR,
    (o.multisig ?? MULTISIG).toBuffer(),
    index,
    ...status,
    Buffer.from([253]),
    vec(o.approved),
    vec(o.rejected),
    vec(o.cancelled),
  ]);
}

function multisigBytes(
  o: {
    threshold?: number;
    timeLock?: number;
    index?: bigint;
    stale?: bigint;
    rentCollector?: PublicKey | null;
  } = {},
): Buffer {
  const head = Buffer.alloc(2 + 4 + 8 + 8);
  head.writeUInt16LE(o.threshold ?? 2, 0);
  head.writeUInt32LE(o.timeLock ?? 0, 2);
  head.writeBigUInt64LE(o.index ?? 9n, 6);
  head.writeBigUInt64LE(o.stale ?? 0n, 14);
  const collector =
    o.rentCollector === undefined
      ? Buffer.concat([Buffer.from([1]), COLLECTOR.toBuffer()])
      : o.rentCollector === null
        ? Buffer.from([0])
        : Buffer.concat([Buffer.from([1]), o.rentCollector.toBuffer()]);
  const members = [
    { key: MEMBER.publicKey, permissions: 5 },
    { key: key(11), permissions: 7 },
    { key: key(12), permissions: 7 },
  ];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(members.length);
  return Buffer.concat([
    MULTISIG_DISCRIMINATOR,
    key(77).toBuffer(),
    PublicKey.default.toBuffer(),
    head,
    collector,
    Buffer.from([254]),
    count,
    ...members.map((m) => Buffer.concat([m.key.toBuffer(), Buffer.from([m.permissions])])),
  ]);
}

// ---- a fake RPC that serves real account bytes ------------------------------------------------

type Account = { owner: PublicKey; data: Buffer };
type HistoryEntry = { signature: string; err?: unknown; logs?: string[]; payer?: PublicKey };
type Sim = { err: unknown; logs?: string[]; unitsConsumed?: number };

function fakeRpc(
  opts: {
    accounts?: Map<string, Account>;
    history?: HistoryEntry[];
    simulation?: Sim;
    onSend?: (raw: Buffer) => void;
  } = {},
) {
  const accounts = opts.accounts ?? new Map<string, Account>();
  const history = opts.history ?? [];
  const sent: Buffer[] = [];
  const landed = new Set<string>();
  const state = {
    simulation: opts.simulation ?? { err: null, unitsConsumed: 100_000 },
    accountsError: undefined as Error | undefined,
    historyError: undefined as Error | undefined,
    simulateError: undefined as Error | undefined,
    sendError: undefined as Error | undefined,
  };
  const info = (k: PublicKey) => {
    const a = accounts.get(k.toBase58());
    return a ? { owner: a.owner, data: a.data, lamports: 1, executable: false } : null;
  };
  const connection = {
    getMultipleAccountsInfoAndContext: vi.fn((keys: PublicKey[]) => {
      if (state.accountsError) return Promise.reject(state.accountsError);
      return Promise.resolve({ context: { slot: 1 }, value: keys.map(info) });
    }),
    getAccountInfo: vi.fn((k: PublicKey) => {
      if (state.accountsError) return Promise.reject(state.accountsError);
      return Promise.resolve(info(k));
    }),
    getSignaturesForAddress: vi.fn(() => {
      if (state.historyError) return Promise.reject(state.historyError);
      return Promise.resolve(
        history.map((h) => ({ signature: h.signature, err: h.err ?? null, slot: 1 })),
      );
    }),
    getTransaction: vi.fn((signature: string) => {
      const entry = history.find((h) => h.signature === signature);
      if (!entry) return Promise.resolve(null);
      return Promise.resolve({
        meta: { err: entry.err ?? null, logMessages: entry.logs ?? [] },
        transaction: { message: { staticAccountKeys: [entry.payer ?? key(99)] } },
      });
    }),
    simulateTransaction: vi.fn(() => {
      if (state.simulateError) return Promise.reject(state.simulateError);
      return Promise.resolve({ context: { slot: 1 }, value: state.simulation });
    }),
    getLatestBlockhash: vi.fn(() =>
      Promise.resolve({ blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1000 }),
    ),
    getBlockHeight: vi.fn(() => Promise.resolve(900)),
    getSignatureStatuses: vi.fn((hashes: string[]) =>
      Promise.resolve({
        value: hashes.map((h) =>
          landed.has(h) ? { err: null, confirmationStatus: 'confirmed' } : null,
        ),
      }),
    ),
    sendRawTransaction: vi.fn((raw: Buffer) => {
      if (state.sendError) return Promise.reject(state.sendError);
      sent.push(Buffer.from(raw));
      landed.add(bs58.encode(VersionedTransaction.deserialize(raw).signatures[0]!));
      opts.onSend?.(raw);
      return Promise.resolve('sig');
    }),
    getMinimumBalanceForRentExemption: vi.fn(() => Promise.resolve(1)),
    getMultipleAccountsInfo: vi.fn(() => Promise.resolve([])),
  };
  return {
    connection: connection as unknown as SquadsConnection,
    raw: connection,
    sent,
    state,
    accounts,
  };
}

function accountsOf(o: {
  proposal?: Buffer | null;
  multisig?: Buffer;
  transaction?: Buffer;
  proposalOwner?: PublicKey;
}): Map<string, Account> {
  const map = new Map<string, Account>();
  map.set(MULTISIG.toBase58(), { owner: SQUADS_PROGRAM_ID, data: o.multisig ?? multisigBytes() });
  if (o.proposal !== null && o.proposal !== undefined) {
    map.set(PROPOSAL.toBase58(), { owner: o.proposalOwner ?? SQUADS_PROGRAM_ID, data: o.proposal });
  }
  if (o.transaction) {
    map.set(TRANSACTION.toBase58(), { owner: SQUADS_PROGRAM_ID, data: o.transaction });
  }
  return map;
}

function fakeSigner(behaviour?: () => Result<{ signature: string }, DispatchError>) {
  const requests: { address: string; unsignedTransaction: string }[] = [];
  const client = {
    requestSignature: vi.fn((request: { address: string; unsignedTransaction: string }) => {
      requests.push(request);
      if (behaviour) return Promise.resolve(behaviour());
      const privateKey = createPrivateKey({
        key: Buffer.concat([SEED_PKCS8, MEMBER.secretKey.subarray(0, 32)]),
        format: 'der',
        type: 'pkcs8',
      });
      const signature = nodeSign(
        null,
        Buffer.from(request.unsignedTransaction, 'base64'),
        privateKey,
      );
      return Promise.resolve(ok({ signature: signature.toString('base64') }));
    }),
  };
  return { client: client as unknown as SignerClient, requests };
}

function approvalFor(
  rpc: ReturnType<typeof fakeRpc>,
  signer = fakeSigner(),
  now: Date = NOW,
  multisig: PublicKey = MULTISIG,
  member: PublicKey = MEMBER.publicKey,
) {
  return new SquadsApproval({
    connection: rpc.connection,
    signerClient: signer.client,
    multisig: {
      multisigAddress: multisig.toBase58(),
      memberAddress: member.toBase58(),
      vaultAddress: deriveVaultAddress(multisig).toBase58(),
    },
    logger: pino({ level: 'silent' }),
    pollIntervalMs: 1,
    resendIntervalMs: 0,
    now: () => now,
  });
}

const ref = (
  over: Partial<Extract<ChainProposalRef, { kind: 'squads' }>> = {},
): ChainProposalRef => ({
  kind: 'squads',
  multisig: MULTISIG.toBase58(),
  proposal: PROPOSAL.toBase58(),
  transactionIndex: Number(INDEX),
  ...over,
});
const proposalRow = (chainRef: ChainProposalRef = ref()): Proposal =>
  ({ id: 'p1', chainRef, proposalRef: PROPOSAL.toBase58() }) as unknown as Proposal;

const EXECUTE_LOG = 'Program log: Instruction: VaultTransactionExecute';

// ---- account decoding, against what the SDK serializes ----------------------------------------

describe('Proposal and VaultTransaction account decoding, against @sqds/multisig 2.1.4', () => {
  const sdkMultisig = key(1);

  it('decodes every status the SDK serializes', () => {
    for (const [name, hex] of Object.entries(golden.proposals)) {
      const decoded = decodeProposalAccount(Buffer.from(hex, 'hex'));
      expect(decoded.status).toBe(name);
      expect(decoded.multisig).toBe(sdkMultisig.toBase58());
      expect(decoded.transactionIndex).toBe(7n);
      expect(decoded.statusTimestamp).toBe(name === 'executing' ? undefined : T0);
    }
    const cancelled = decodeProposalAccount(Buffer.from(golden.proposals.cancelled, 'hex'));
    expect([
      cancelled.approved.length,
      cancelled.rejected.length,
      cancelled.cancelled.length,
    ]).toEqual([2, 0, 2]);
    const rejected = decodeProposalAccount(Buffer.from(golden.proposals.rejected, 'hex'));
    expect([rejected.approved.length, rejected.rejected.length]).toEqual([0, 2]);
  });

  it('the fixture encoder here produces the SDK bytes byte for byte', () => {
    const base = { index: 7n, multisig: sdkMultisig, approved: [key(11), key(12)] };
    expect(proposalBytes({ status: 'approved', timestamp: T0, ...base }).toString('hex')).toBe(
      golden.proposals.approved,
    );
    expect(proposalBytes({ status: 'executing', ...base }).toString('hex')).toBe(
      golden.proposals.executing,
    );
  });

  it('decodes the vault transaction account the SDK serializes (plain Borsh, u32 lengths)', () => {
    const vt = decodeVaultTransactionAccount(Buffer.from(golden.vaultTxAccount, 'hex'));
    expect(vt.multisig).toBe(sdkMultisig.toBase58());
    expect(vt.index).toBe(7n);
    expect(vt.vaultIndex).toBe(0);
    expect(vt.message.accountKeys).toHaveLength(7);
    expect(vt.message.instructions).toHaveLength(2);
    expect(vt.message.addressTableLookupCount).toBe(0);
  });

  it('rejects bytes that are not these accounts, and truncated ones', () => {
    expect(() => decodeProposalAccount(Buffer.alloc(100))).toThrow(/discriminator/);
    expect(() =>
      decodeProposalAccount(Buffer.from(golden.proposals.active, 'hex').subarray(0, 60)),
    ).toThrow(/truncated/);
    expect(() => decodeVaultTransactionAccount(Buffer.alloc(100))).toThrow(/discriminator/);
    expect(() =>
      decodeVaultTransactionAccount(Buffer.from(golden.vaultTxAccount, 'hex').subarray(0, 120)),
    ).toThrow(/truncated/);
  });
});

// ---- readProposal -----------------------------------------------------------------------------

describe('SquadsApproval.readProposal', () => {
  const read = async (
    o: Parameters<typeof accountsOf>[0],
    extra: { history?: HistoryEntry[]; now?: Date } = {},
  ) => {
    const rpc = fakeRpc({ accounts: accountsOf(o), history: extra.history ?? [] });
    return { rpc, result: await approvalFor(rpc, fakeSigner(), extra.now).readProposal(ref()) };
  };

  it('an Active proposal has its approvals so far, the threshold, and cannot execute', async () => {
    const { result } = await read({
      proposal: proposalBytes({ status: 'active', approved: [key(11)] }),
    });
    expect(result).toEqual(
      ok({
        status: 'active',
        approvals: 1,
        threshold: 2,
        approvers: [
          { address: key(11).toBase58(), decision: 'approved' },
          { address: key(12).toBase58(), decision: 'pending' },
        ],
        executable: false,
      }),
    );
  });

  it('lists only the members who can vote, in member order, each with their decision', async () => {
    const { result } = await read({
      proposal: proposalBytes({ status: 'active', approved: [key(12)], rejected: [key(11)] }),
    });
    // The engine's own member (Initiate and Execute, no Vote) is never an Approver.
    expect(result.ok && result.value.approvers).toEqual([
      { address: key(11).toBase58(), decision: 'rejected' },
      { address: key(12).toBase58(), decision: 'approved' },
    ]);
  });

  it('a Draft proposal is still waiting for its approvers', async () => {
    const { result } = await read({ proposal: proposalBytes({ status: 'draft' }) });
    expect(result.ok && result.value.status).toBe('active');
  });

  it('reads the proposal and the multisig together, at the pinned commitment', async () => {
    const { rpc } = await read({ proposal: proposalBytes({ status: 'active' }) });
    expect(rpc.raw.getMultipleAccountsInfoAndContext).toHaveBeenCalledTimes(1);
    expect(rpc.raw.getMultipleAccountsInfoAndContext).toHaveBeenCalledWith(
      [PROPOSAL, MULTISIG],
      'confirmed',
    );
  });

  it('an Approved proposal without a time lock is executable at once, with no executeAfter', async () => {
    const { result } = await read({
      proposal: proposalBytes({ status: 'approved', approved: [key(11), key(12)] }),
    });
    expect(result).toEqual(
      ok({
        status: 'approved',
        approvals: 2,
        threshold: 2,
        approvers: [
          { address: key(11).toBase58(), decision: 'approved' },
          { address: key(12).toBase58(), decision: 'approved' },
        ],
        executable: true,
      }),
    );
  });

  it('counts the time lock from the Approved timestamp, not from the proposal creation', async () => {
    const accounts = {
      proposal: proposalBytes({ status: 'approved', timestamp: T0, approved: [key(11), key(12)] }),
      multisig: multisigBytes({ timeLock: 3_600 }),
    };
    const waiting = await read(accounts, { now: new Date((T0 + 3_599) * 1000) });
    expect(waiting.result).toEqual(
      ok({
        status: 'approved',
        approvals: 2,
        threshold: 2,
        approvers: [
          { address: key(11).toBase58(), decision: 'approved' },
          { address: key(12).toBase58(), decision: 'approved' },
        ],
        executeAfter: new Date((T0 + 3_600) * 1000),
        executable: false,
      }),
    );
    const released = await read(accounts, { now: new Date((T0 + 3_600) * 1000) });
    expect(released.result.ok && released.result.value.executable).toBe(true);
    expect(released.result.ok && released.result.value.executeAfter).toEqual(
      new Date((T0 + 3_600) * 1000),
    );
  });

  it('a Rejected and a Cancelled proposal say so', async () => {
    const rejected = await read({
      proposal: proposalBytes({ status: 'rejected', rejected: [key(11), key(12)] }),
    });
    expect(rejected.result.ok && rejected.result.value.status).toBe('rejected');
    expect(rejected.result.ok && rejected.result.value.approvers?.map((a) => a.decision)).toEqual([
      'rejected',
      'rejected',
    ]);
    const cancelled = await read({
      proposal: proposalBytes({
        status: 'cancelled',
        approved: [key(11), key(12)],
        cancelled: [key(11), key(12)],
      }),
    });
    expect(cancelled.result.ok && cancelled.result.value.status).toBe('cancelled');
    // Approved, then voted to cancel: the cancel is their last word.
    expect(cancelled.result.ok && cancelled.result.value.approvers?.map((a) => a.decision)).toEqual(
      ['rejected', 'rejected'],
    );
  });

  it('an Executed proposal names the successful execute in its history', async () => {
    const { result } = await read(
      { proposal: proposalBytes({ status: 'executed', approved: [key(11), key(12)] }) },
      {
        history: [
          {
            signature: 'close-sig',
            logs: ['Program log: Instruction: VaultTransactionAccountsClose'],
          },
          {
            signature: 'failed-exec',
            err: { InstructionError: [2, { Custom: 6021 }] },
            logs: [EXECUTE_LOG],
          },
          { signature: 'exec-sig', logs: ['Program x invoke [1]', EXECUTE_LOG], payer: key(55) },
          { signature: 'vote-sig', logs: ['Program log: Instruction: ProposalApprove'] },
        ],
      },
    );
    expect(result).toEqual(
      ok({
        status: 'executed',
        approvals: 2,
        threshold: 2,
        approvers: [
          { address: key(11).toBase58(), decision: 'approved' },
          { address: key(12).toBase58(), decision: 'approved' },
        ],
        executedHash: 'exec-sig',
        executable: false,
      }),
    );
  });

  it('an Executed proposal whose history shows no execute is still executed, without a hash', async () => {
    const { result } = await read({ proposal: proposalBytes({ status: 'executed' }) });
    expect(result.ok && result.value.status).toBe('executed');
    expect(result.ok && result.value.executedHash).toBeUndefined();
  });

  it('a failed execute transaction in the history is never taken for the execution', async () => {
    const { result } = await read(
      { proposal: proposalBytes({ status: 'executed' }) },
      {
        history: [
          { signature: 'failed', logs: [EXECUTE_LOG], err: { InstructionError: [0, 'Custom'] } },
        ],
      },
    );
    expect(result.ok && result.value.executedHash).toBeUndefined();
  });

  it('a closed proposal (account missing) is executed when the history holds the execute, even by someone else', async () => {
    const { result } = await read(
      { proposal: null },
      {
        history: [
          {
            signature: 'close-sig',
            logs: ['Program log: Instruction: VaultTransactionAccountsClose'],
          },
          { signature: 'human-exec', logs: [EXECUTE_LOG], payer: key(55) },
        ],
      },
    );
    expect(result).toEqual(
      ok({
        status: 'executed',
        approvals: 2,
        threshold: 2,
        executedHash: 'human-exec',
        executable: false,
      }),
    );
  });

  it('a missing proposal with no execute in its history is unknown, never an invented outcome', async () => {
    const { result } = await read(
      { proposal: null },
      { history: [{ signature: 'create', logs: ['Program log: Instruction: ProposalCreate'] }] },
    );
    expect(result).toEqual(
      ok({ status: 'unknown', approvals: 0, threshold: 2, executable: false }),
    );
    const empty = await read({ proposal: null });
    expect(empty.result.ok && empty.result.value.status).toBe('unknown');
  });

  describe('stale (index at or below the multisig staleTransactionIndex)', () => {
    const multisig = multisigBytes({ stale: INDEX });

    it('Active and stale is dead', async () => {
      const { result } = await read({
        proposal: proposalBytes({ status: 'active', approved: [key(11)] }),
        multisig,
      });
      expect(result.ok && result.value.status).toBe('stale');
    });

    it('Approved and stale still executes: it stays approved', async () => {
      const { result } = await read({
        proposal: proposalBytes({ status: 'approved', approved: [key(11), key(12)] }),
        multisig,
      });
      expect(result.ok && [result.value.status, result.value.executable]).toEqual([
        'approved',
        true,
      ]);
    });

    it('Rejected, Cancelled and Executed keep their own, more specific status', async () => {
      for (const status of ['rejected', 'cancelled', 'executed'] as const) {
        const { result } = await read({ proposal: proposalBytes({ status }), multisig });
        expect(result.ok && result.value.status).toBe(status);
      }
    });

    it('a proposal above the stale index is not stale', async () => {
      const { result } = await read({
        proposal: proposalBytes({ status: 'active' }),
        multisig: multisigBytes({ stale: INDEX - 1n }),
      });
      expect(result.ok && result.value.status).toBe('active');
    });
  });

  it('the deprecated Executing status is unknown, not something to act on', async () => {
    const { result } = await read({ proposal: proposalBytes({ status: 'executing' }) });
    expect(result.ok && result.value.status).toBe('unknown');
  });

  describe('errors', () => {
    it('maps an RPC failure reading the accounts to RPC_UNAVAILABLE', async () => {
      const rpc = fakeRpc({
        accounts: accountsOf({ proposal: proposalBytes({ status: 'active' }) }),
      });
      rpc.state.accountsError = new Error('503 Service Unavailable');
      const result = await approvalFor(rpc).readProposal(ref());
      expect(!result.ok && result.error.code).toBe('RPC_UNAVAILABLE');
    });

    it('maps an RPC failure reading the history to RPC_UNAVAILABLE, rather than settling without the hash', async () => {
      const rpc = fakeRpc({
        accounts: accountsOf({ proposal: proposalBytes({ status: 'executed' }) }),
      });
      rpc.state.historyError = new Error('timed out');
      const result = await approvalFor(rpc).readProposal(ref());
      expect(!result.ok && result.error.code).toBe('RPC_UNAVAILABLE');
      const gone = fakeRpc({ accounts: accountsOf({ proposal: null }) });
      gone.state.historyError = new Error('timed out');
      const missing = await approvalFor(gone).readProposal(ref());
      expect(!missing.ok && missing.error.code).toBe('RPC_UNAVAILABLE');
    });

    it('refuses a ref for another multisig, a Safe ref, an unreadable multisig and a foreign proposal', async () => {
      const rpc = fakeRpc({
        accounts: accountsOf({ proposal: proposalBytes({ status: 'active' }) }),
      });
      const a = approvalFor(rpc);
      expect((await a.readProposal(ref({ multisig: key(3).toBase58() }))).ok).toBe(false);
      expect(
        (await a.readProposal({ kind: 'safe', safe: 's', safeTxHash: 'h', nonce: 1 })).ok,
      ).toBe(false);
      expect((await a.readProposal(ref({ proposal: 'not-a-key' }))).ok).toBe(false);

      const noMultisig = fakeRpc({ accounts: new Map() });
      expect((await approvalFor(noMultisig).readProposal(ref())).ok).toBe(false);
      const foreign = fakeRpc({
        accounts: accountsOf({ proposal: proposalBytes({ status: 'active', multisig: key(3) }) }),
      });
      expect((await approvalFor(foreign).readProposal(ref())).ok).toBe(false);
      const wrongOwner = fakeRpc({
        accounts: accountsOf({
          proposal: proposalBytes({ status: 'active' }),
          proposalOwner: key(4),
        }),
      });
      expect((await approvalFor(wrongOwner).readProposal(ref())).ok).toBe(false);
      const junk = fakeRpc({ accounts: accountsOf({ proposal: Buffer.alloc(80) }) });
      expect((await approvalFor(junk).readProposal(ref())).ok).toBe(false);
    });
  });
});

// ---- prepareExecution -------------------------------------------------------------------------

describe('SquadsApproval.prepareExecution', () => {
  /** The SDK's own execute for the golden vault transaction (index 7 of multisig key(1)). */
  const GM = key(1);
  const GMEMBER = key(2);
  const goldenRpc = (extra: Partial<Parameters<typeof fakeRpc>[0]> = {}) => {
    const accounts = new Map<string, Account>();
    accounts.set(golden.txPda, {
      owner: SQUADS_PROGRAM_ID,
      data: Buffer.from(golden.vaultTxAccount, 'hex'),
    });
    return fakeRpc({ accounts, ...extra });
  };
  const goldenApproval = (rpc: ReturnType<typeof fakeRpc>, signer = fakeSigner()) =>
    approvalFor(rpc, signer, NOW, GM, GMEMBER);
  const goldenProposal = () =>
    proposalRow({
      kind: 'squads',
      multisig: GM.toBase58(),
      proposal: golden.propPda,
      transactionIndex: 7,
    });
  type Decoded = {
    chunkNonce: string;
    feePayer: string;
    instructions: {
      programId: string;
      keys: { pubkey: string; isSigner: boolean; isWritable: boolean }[];
      data: string;
    }[];
  };
  const decode = (prepared: PreparedTransaction) =>
    JSON.parse(Buffer.from(prepared.unsignedTransaction, 'base64').toString('utf8')) as Decoded;
  const metas = (keys: Decoded['instructions'][number]['keys']) =>
    keys.map((k) => `${k.pubkey}:${k.isSigner ? 's' : ''}${k.isWritable ? 'w' : ''}`);

  it('builds the SDK execute instruction, preceded by the 256 KB heap frame and a compute-unit limit, member paying', async () => {
    const prepared = await goldenApproval(goldenRpc()).prepareExecution(goldenProposal());
    expect(prepared.ok).toBe(true);
    if (!prepared.ok) return;
    const tx = decode(prepared.value);

    expect(prepared.value.callIndex).toBe(0);
    expect(tx.feePayer).toBe(GMEMBER.toBase58());
    expect(tx.instructions).toHaveLength(3);

    const [heap, limit, execute] = tx.instructions.map((i) => ({
      ...i,
      data: Buffer.from(i.data, 'base64'),
    }));
    expect(heap!.programId).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(heap!.data[0]).toBe(1); // RequestHeapFrame
    expect(heap!.data.readUInt32LE(1)).toBe(256 * 1024);
    expect(limit!.programId).toBe(ComputeBudgetProgram.programId.toBase58());
    expect(limit!.data[0]).toBe(2); // SetComputeUnitLimit
    expect(limit!.data.readUInt32LE(1)).toBe(150_000); // 100k simulated, with 50% room

    expect(execute!.programId).toBe(SQUADS_PROGRAM_ID.toBase58());
    expect(execute!.data.toString('hex')).toBe(golden.executeData);
    expect(metas(execute!.keys)).toEqual(golden.executeKeys);
  });

  it('simulates without a signature, with a replaced blockhash', async () => {
    const rpc = goldenRpc();
    await goldenApproval(rpc).prepareExecution(goldenProposal());
    expect(rpc.raw.simulateTransaction).toHaveBeenCalledTimes(1);
    const calls = rpc.raw.simulateTransaction.mock.calls as unknown as [
      VersionedTransaction,
      Record<string, unknown>,
    ][];
    expect(calls[0]![1]).toMatchObject({ sigVerify: false, replaceRecentBlockhash: true });
  });

  it('passes the Signer policy for the multisig: fee payer is the member, ComputeBudget 1 and 2, one Squads execute', async () => {
    const prepared = await goldenApproval(goldenRpc()).prepareExecution(goldenProposal());
    if (!prepared.ok) throw new Error('prepare failed');
    const tx = decode(prepared.value);
    const message = new Transaction({
      feePayer: GMEMBER,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 0,
    })
      .add(...tx.instructions.map(decodeInstruction))
      .compileMessage()
      .serialize();
    expect(checkMultisigMessage(GM.toBase58(), GMEMBER.toBase58(), message)).toEqual({ ok: true });
    // And the Signer would refuse it for another multisig or another fee payer.
    expect(checkMultisigMessage(key(3).toBase58(), GMEMBER.toBase58(), message).ok).toBe(false);
    expect(checkMultisigMessage(GM.toBase58(), key(3).toBase58(), message).ok).toBe(false);
  });

  it('the Solana handler signs it as the member, unchanged, over its own fresh blockhash', async () => {
    const signer = fakeSigner();
    const rpc = goldenRpc();
    const a = approvalFor(rpc, signer, NOW, GM, MEMBER.publicKey);
    const prepared = await a.prepareExecution(goldenProposal());
    if (!prepared.ok) throw new Error('prepare failed');
    const handler = new SolanaChainHandler({
      connection: rpc.connection as never,
      signerClient: signer.client,
      senderAddress: deriveVaultAddress(GM).toBase58(),
      logger: pino({ level: 'silent' }),
    });

    const signed = await handler.sign(prepared.value, MEMBER.publicKey.toBase58());
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const tx = VersionedTransaction.deserialize(Buffer.from(signed.value, 'base64'));
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(MEMBER.publicKey.toBase58());
    // The policy accepts exactly what the Signer was asked to sign.
    const asked = Buffer.from(signer.requests.at(-1)!.unsignedTransaction, 'base64');
    expect(checkMultisigMessage(GM.toBase58(), MEMBER.publicKey.toBase58(), asked)).toEqual({
      ok: true,
    });
    // And the handler's hash is the signature the engine tracks.
    expect(handler.transactionHash(signed.value)).toEqual(ok(bs58.encode(tx.signatures[0]!)));
  });

  it('a new chunk nonce each time, so a resubmitted execute is signed afresh', async () => {
    const a = goldenApproval(goldenRpc());
    const one = await a.prepareExecution(goldenProposal());
    const two = await a.prepareExecution(goldenProposal());
    if (!one.ok || !two.ok) throw new Error('prepare failed');
    expect(decode(one.value).chunkNonce).not.toBe(decode(two.value).chunkNonce);
  });

  it('sizes the compute-unit limit from the simulation, within bounds', async () => {
    const limitFor = async (sim: Sim) => {
      const prepared = await goldenApproval(goldenRpc({ simulation: sim })).prepareExecution(
        goldenProposal(),
      );
      if (!prepared.ok) throw new Error('prepare failed');
      return Buffer.from(decode(prepared.value).instructions[1]!.data, 'base64').readUInt32LE(1);
    };
    expect(await limitFor({ err: null, unitsConsumed: 200_000 })).toBe(300_000);
    expect(await limitFor({ err: null, unitsConsumed: 1_000 })).toBe(100_000);
    expect(await limitFor({ err: null, unitsConsumed: 1_300_000 })).toBe(1_400_000);
    expect(await limitFor({ err: null })).toBe(1_400_000);
  });

  it('a simulation failing with TimeLockNotReleased (6021) is a retry, not a failure of the proposal', async () => {
    const rpc = goldenRpc({
      simulation: {
        err: { InstructionError: [2, { Custom: 6021 }] },
        logs: ['Error Message: Proposal time lock has not been released.'],
      },
    });
    const result = await goldenApproval(rpc).prepareExecution(goldenProposal());
    expect(!result.ok && result.error.code).toBe('RPC_UNAVAILABLE');
    expect(!result.ok && result.error.chainDetail).toMatchObject({
      reason: 'TIME_LOCK_NOT_RELEASED',
    });
  });

  it('any other simulation failure returns the program error and its logs', async () => {
    const error = { InstructionError: [2, { Custom: 6008 }] };
    const logs = ['Program log: InvalidProposalStatus'];
    const rpc = goldenRpc({ simulation: { err: error, logs } });
    const result = await goldenApproval(rpc).prepareExecution(goldenProposal());
    expect(!result.ok && result.error.code).toBe('CHAIN_REJECTED');
    expect(!result.ok && result.error.chainDetail).toEqual({ error, logs });
  });

  it('an inner failure (the vault cannot pay) is a refusal with the logs, not mistaken for the time lock', async () => {
    const rpc = goldenRpc({
      simulation: {
        err: { InstructionError: [2, { Custom: 1 }] },
        logs: ['Transfer: insufficient lamports 5, need 1234567'],
      },
    });
    const result = await goldenApproval(rpc).prepareExecution(goldenProposal());
    expect(!result.ok && result.error.code).toBe('CHAIN_REJECTED');
  });

  it('maps an RPC failure to RPC_UNAVAILABLE, in the read and in the simulation', async () => {
    const readFails = goldenRpc();
    readFails.state.accountsError = new Error('503');
    const first = await goldenApproval(readFails).prepareExecution(goldenProposal());
    expect(!first.ok && first.error.code).toBe('RPC_UNAVAILABLE');
    const simFails = goldenRpc();
    simFails.state.simulateError = new Error('fetch failed');
    const second = await goldenApproval(simFails).prepareExecution(goldenProposal());
    expect(!second.ok && second.error.code).toBe('RPC_UNAVAILABLE');
  });

  it('a vault transaction that is gone (closed) is a structured refusal', async () => {
    const result = await goldenApproval(fakeRpc({ accounts: new Map() })).prepareExecution(
      goldenProposal(),
    );
    expect(!result.ok && result.error.chainDetail).toMatchObject({
      reason: 'VAULT_TRANSACTION_MISSING',
    });
  });

  it("refuses a vault transaction that is not this proposal's, a foreign ref, and one with lookup tables", async () => {
    // The golden account is index 7: a ref to index 8 whose account holds those bytes must not execute it.
    const rpc = goldenRpc();
    rpc.accounts.set(deriveTransactionPda(GM, 8n).toBase58(), {
      owner: SQUADS_PROGRAM_ID,
      data: Buffer.from(golden.vaultTxAccount, 'hex'),
    });
    const a = goldenApproval(rpc);
    const wrongIndex = await a.prepareExecution(
      proposalRow({
        kind: 'squads',
        multisig: GM.toBase58(),
        proposal: golden.propPda,
        transactionIndex: 8,
      }),
    );
    expect(wrongIndex.ok).toBe(false);
    expect((await a.prepareExecution(proposalRow(ref()))).ok).toBe(false);
    expect(
      (
        await a.prepareExecution(
          proposalRow({ kind: 'safe', safe: 's', safeTxHash: 'h', nonce: 1 }),
        )
      ).ok,
    ).toBe(false);

    // One address-table lookup: patch the trailing count of the golden bytes.
    const withLookup = Buffer.from(golden.vaultTxAccount, 'hex');
    withLookup.writeUInt32LE(1, withLookup.length - 4);
    const lookups = goldenRpc();
    lookups.accounts.set(golden.txPda, { owner: SQUADS_PROGRAM_ID, data: withLookup });
    const refused = await goldenApproval(lookups).prepareExecution(goldenProposal());
    expect(!refused.ok && refused.error.message).toMatch(/cannot be executed/);
  });
});

// ---- closeProposal ----------------------------------------------------------------------------

describe('SquadsApproval.closeProposal', () => {
  const closable = (o: Partial<Parameters<typeof accountsOf>[0]> = {}) =>
    accountsOf({
      proposal: proposalBytes({ status: 'executed', approved: [key(11), key(12)] }),
      ...o,
    });
  const closedBy = (accounts: Map<string, Account>) => () => {
    accounts.delete(PROPOSAL.toBase58());
    accounts.delete(TRANSACTION.toBase58());
  };

  it('sends the permissionless close, signed by the member, naming the multisig rent collector', async () => {
    const accounts = closable();
    const rpc = fakeRpc({ accounts, onSend: closedBy(accounts) });
    const signer = fakeSigner();
    const result = await approvalFor(rpc, signer).closeProposal(proposalRow());
    expect(result).toEqual(ok(undefined));

    expect(rpc.sent).toHaveLength(1);
    const tx = VersionedTransaction.deserialize(rpc.sent[0]!);
    expect(tx.message.staticAccountKeys[0]!.toBase58()).toBe(MEMBER.publicKey.toBase58());
    expect(tx.message.compiledInstructions).toHaveLength(1);
    const instruction = tx.message.compiledInstructions[0]!;
    const keys = instruction.accountKeyIndexes.map((i) =>
      tx.message.staticAccountKeys[i]!.toBase58(),
    );
    expect(keys).toEqual([
      MULTISIG.toBase58(),
      PROPOSAL.toBase58(),
      TRANSACTION.toBase58(),
      COLLECTOR.toBase58(),
      '11111111111111111111111111111111',
    ]);
    expect(Buffer.from(instruction.data).toString('hex')).toBe(golden.closeData);
    expect(
      checkMultisigMessage(
        MULTISIG.toBase58(),
        MEMBER.publicKey.toBase58(),
        tx.message.serialize(),
      ),
    ).toEqual({ ok: true });
    expect(signer.requests).toHaveLength(1);
    expect(signer.requests[0]!.address).toBe(MEMBER.publicKey.toBase58());
  });

  it('closes the Rejected, the Cancelled and the stale-and-not-Approved', async () => {
    for (const [status, multisig] of [
      ['rejected', undefined],
      ['cancelled', undefined],
      ['active', multisigBytes({ stale: INDEX })],
    ] as const) {
      const accounts = accountsOf({
        proposal: proposalBytes({ status }),
        ...(multisig ? { multisig } : {}),
      });
      const rpc = fakeRpc({ accounts, onSend: closedBy(accounts) });
      expect(await approvalFor(rpc).closeProposal(proposalRow())).toEqual(ok(undefined));
      expect(rpc.sent).toHaveLength(1);
    }
  });

  it('never sends for a state that cannot be closed: Active, a fresh Approved, a stale Approved', async () => {
    for (const [status, multisig] of [
      ['active', undefined],
      ['approved', undefined],
      ['approved', multisigBytes({ stale: INDEX })],
      ['draft', undefined],
    ] as const) {
      const rpc = fakeRpc({
        accounts: accountsOf({
          proposal: proposalBytes({ status }),
          ...(multisig ? { multisig } : {}),
        }),
      });
      const result = await approvalFor(rpc).closeProposal(proposalRow());
      expect(!result.ok && result.error.chainDetail).toMatchObject({ reason: 'NOT_CLOSABLE' });
      expect(rpc.sent).toHaveLength(0);
    }
  });

  it('without a rent collector says so and sends nothing', async () => {
    const rpc = fakeRpc({
      accounts: closable({ multisig: multisigBytes({ rentCollector: null }) }),
    });
    const signer = fakeSigner();
    const result = await approvalFor(rpc, signer).closeProposal(proposalRow());
    expect(!result.ok && result.error.chainDetail).toMatchObject({
      reason: 'RENT_RECLAMATION_DISABLED',
    });
    expect(rpc.sent).toHaveLength(0);
    expect(signer.requests).toHaveLength(0);
  });

  it('an already closed proposal is success, with nothing sent or signed', async () => {
    const rpc = fakeRpc({ accounts: accountsOf({ proposal: null }) });
    const signer = fakeSigner();
    expect(await approvalFor(rpc, signer).closeProposal(proposalRow())).toEqual(ok(undefined));
    expect(rpc.sent).toHaveLength(0);
    expect(signer.requests).toHaveLength(0);
  });

  it('a send that fails because someone else closed it first is success', async () => {
    const accounts = closable();
    const rpc = fakeRpc({ accounts });
    rpc.raw.sendRawTransaction.mockImplementationOnce(() => {
      accounts.delete(PROPOSAL.toBase58());
      return Promise.reject(new Error('Transaction simulation failed: AccountNotInitialized'));
    });
    expect(await approvalFor(rpc).closeProposal(proposalRow())).toEqual(ok(undefined));
  });

  it('a close the chain rejects, with the proposal still there, is an error', async () => {
    const rpc = fakeRpc({ accounts: closable() });
    rpc.state.sendError = new Error('Transaction simulation failed: custom program error: 0x1788');
    const result = await approvalFor(rpc).closeProposal(proposalRow());
    expect(result.ok).toBe(false);
  });

  it('passes a Signer refusal through, with nothing sent', async () => {
    const refused: DispatchError = { code: 'SIGNER_REFUSED', message: 'policy' };
    const rpc = fakeRpc({ accounts: closable() });
    const result = await approvalFor(
      rpc,
      fakeSigner(() => err(refused)),
    ).closeProposal(proposalRow());
    expect(result).toEqual(err(refused));
    expect(rpc.sent).toHaveLength(0);
  });

  it('maps an RPC failure reading the accounts to RPC_UNAVAILABLE', async () => {
    const rpc = fakeRpc({ accounts: closable() });
    rpc.state.accountsError = new Error('503');
    const result = await approvalFor(rpc).closeProposal(proposalRow());
    expect(!result.ok && result.error.code).toBe('RPC_UNAVAILABLE');
  });
});
