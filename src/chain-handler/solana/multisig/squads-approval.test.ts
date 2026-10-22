import { createPrivateKey, sign as nodeSign } from 'node:crypto';

import { TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  Transaction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import { describe, expect, it, vi } from 'vitest';

import { checkMultisigMessage } from '../../../../signer/src/squads.js';
import type { SolanaCall } from '../../../domain/call.js';
import type { DispatchError } from '../../../domain/errors.js';
import { err, ok, type Result } from '../../../domain/result.js';
import type { SignerClient } from '../../../signer/client.js';
import { deriveAssociatedTokenAddress } from '../account-resolution.js';
import { fromTransactionInstruction } from '../instruction-codec.js';
import { buildSplTransferCall } from '../spl-transfer.js';
import { buildNativeTransferCall } from '../native-transfer.js';
import { MULTISIG_DISCRIMINATOR } from './multisig-account.js';
import { deriveVaultAddress, SQUADS_PROGRAM_ID } from './multisig-config.js';
import {
  MAX_TRANSFERS_PER_PROPOSAL,
  SquadsApproval,
  type SquadsConnection,
} from './squads-approval.js';
import { deriveProposalPda, deriveTransactionPda } from './vault-transaction.js';

const MULTISIG = Keypair.generate().publicKey;
const VAULT = deriveVaultAddress(MULTISIG);
const MEMBER = Keypair.generate();
const MINT = Keypair.generate().publicKey;
const SEED_PKCS8 = Buffer.from('302e020100300506032b657004220420', 'hex');

function multisigBytes(index: bigint, permissions = 5): Buffer {
  const key = (k: PublicKey) => k.toBuffer();
  const head = Buffer.alloc(2 + 4 + 8 + 8);
  head.writeUInt16LE(2, 0);
  head.writeBigUInt64LE(index, 6);
  const members = [
    { key: MEMBER.publicKey, permissions },
    { key: Keypair.generate().publicKey, permissions: 7 },
    { key: Keypair.generate().publicKey, permissions: 7 },
  ];
  const count = Buffer.alloc(4);
  count.writeUInt32LE(members.length);
  return Buffer.concat([
    MULTISIG_DISCRIMINATOR,
    key(Keypair.generate().publicKey),
    key(PublicKey.default),
    head,
    Buffer.from([0, 254]),
    count,
    ...members.map((m) => Buffer.concat([key(m.key), Buffer.from([m.permissions])])),
  ]);
}

type Status = { err: unknown; confirmationStatus: string } | null;

function fakeConnection(
  opts: {
    index?: bigint;
    permissions?: number;
    existingAccounts?: Set<string>;
    statuses?: Status[];
    sendError?: Error;
    height?: number;
  } = {},
) {
  const sent: Buffer[] = [];
  const statuses = [...(opts.statuses ?? [])];
  const connection = {
    getAccountInfoAndContext: vi.fn(() =>
      Promise.resolve({
        context: { slot: 1 },
        value: {
          owner: SQUADS_PROGRAM_ID,
          data: multisigBytes(opts.index ?? 4n, opts.permissions),
          lamports: 1,
          executable: false,
        },
      }),
    ),
    getAccountInfo: vi.fn(() => Promise.resolve(null)),
    getMinimumBalanceForRentExemption: vi.fn((size: number) => Promise.resolve(size * 1000)),
    getMultipleAccountsInfo: vi.fn((keys: PublicKey[]) =>
      Promise.resolve(
        keys.map((k) =>
          opts.existingAccounts?.has(k.toBase58()) ? { data: Buffer.alloc(0) } : null,
        ),
      ),
    ),
    getLatestBlockhash: vi.fn(() =>
      Promise.resolve({ blockhash: PublicKey.unique().toBase58(), lastValidBlockHeight: 1000 }),
    ),
    getBlockHeight: vi.fn(() => Promise.resolve(opts.height ?? 900)),
    getSignatureStatuses: vi.fn(() =>
      Promise.resolve({ value: [statuses.length > 1 ? statuses.shift()! : (statuses[0] ?? null)] }),
    ),
    sendRawTransaction: vi.fn((raw: Buffer) => {
      sent.push(Buffer.from(raw));
      return opts.sendError ? Promise.reject(opts.sendError) : Promise.resolve('sig');
    }),
  };
  return { connection: connection as unknown as SquadsConnection, raw: connection, sent };
}

function fakeSigner(behaviour?: () => Result<{ signature: string }, DispatchError>) {
  const requests: { address: string; unsignedTransaction: string }[] = [];
  const client = {
    requestSignature: vi.fn((request: { address: string; unsignedTransaction: string }) => {
      requests.push(request);
      if (behaviour) return Promise.resolve(behaviour());
      const key = createPrivateKey({
        key: Buffer.concat([SEED_PKCS8, MEMBER.secretKey.subarray(0, 32)]),
        format: 'der',
        type: 'pkcs8',
      });
      const signature = nodeSign(null, Buffer.from(request.unsignedTransaction, 'base64'), key);
      return Promise.resolve(ok({ signature: signature.toString('base64') }));
    }),
  };
  return { client: client as unknown as SignerClient, requests };
}

function approval(
  c = fakeConnection(),
  s = fakeSigner(),
  extra: {
    knownTokens?: Record<string, { mint: string; decimals: number; tokenProgram?: 'token-2022' }>;
    price?: number;
  } = {},
) {
  return new SquadsApproval({
    connection: c.connection,
    signerClient: s.client,
    multisig: {
      multisigAddress: MULTISIG.toBase58(),
      memberAddress: MEMBER.publicKey.toBase58(),
      vaultAddress: VAULT.toBase58(),
    },
    knownTokens: extra.knownTokens ?? { USDC: { mint: MINT.toBase58(), decimals: 6 } },
    ...(extra.price ? { computeUnitPriceMicroLamports: extra.price } : {}),
    pollIntervalMs: 1,
    resendIntervalMs: 0,
  });
}

const sol = (to: PublicKey, lamports: bigint): SolanaCall => {
  const call = buildNativeTransferCall(VAULT.toBase58(), to.toBase58(), lamports);
  if (!call.ok) throw new Error('bad call');
  return call.value;
};
const spl = (
  to: PublicKey,
  amount: bigint,
  mint = MINT,
  program = TOKEN_PROGRAM_ID,
): SolanaCall => {
  const call = buildSplTransferCall(
    VAULT.toBase58(),
    to.toBase58(),
    mint.toBase58(),
    6,
    amount,
    program,
  );
  if (!call.ok) throw new Error('bad call');
  return call.value;
};
const wallet = () => Keypair.generate().publicKey;

/** A test-only reader of the Squads compact message: header, keys, instructions (u16 data length). */
function decodeCompact(bytes: Buffer) {
  let at = 0;
  const numSigners = bytes[at++]!;
  const numWritableSigners = bytes[at++]!;
  const numWritableNonSigners = bytes[at++]!;
  const keyCount = bytes[at++]!;
  const keys: string[] = [];
  for (let i = 0; i < keyCount; i++, at += 32)
    keys.push(new PublicKey(bytes.subarray(at, at + 32)).toBase58());
  const instructions: { program: string; accounts: string[]; data: Buffer }[] = [];
  const count = bytes[at++]!;
  for (let i = 0; i < count; i++) {
    const program = keys[bytes[at++]!]!;
    const n = bytes[at++]!;
    const accounts = [...bytes.subarray(at, at + n)].map((x) => keys[x]!);
    at += n;
    const length = bytes.readUInt16LE(at);
    at += 2;
    instructions.push({ program, accounts, data: bytes.subarray(at, at + length) });
    at += length;
  }
  expect(bytes[at++]).toBe(0); // no address-table lookups
  expect(at).toBe(bytes.length);
  return { numSigners, numWritableSigners, numWritableNonSigners, keys, instructions };
}

async function built(a: SquadsApproval, calls: SolanaCall[]) {
  const result = await a.buildProposal({ calls, sender: VAULT.toBase58() });
  if (!result.ok) throw new Error(`build failed: ${result.error.message}`);
  return result.value;
}

describe('token accounts of a vault', () => {
  it('derives a token account for an off-curve owner such as the vault', () => {
    expect(PublicKey.isOnCurve(VAULT.toBytes())).toBe(false);
    expect(() => deriveAssociatedTokenAddress(VAULT, MINT)).not.toThrow();
  });
});

describe('SquadsApproval.planBundles', () => {
  it('puts up to 12 transfers in a proposal and splits the rest, keeping every position once', () => {
    const calls = Array.from({ length: 30 }, () => sol(wallet(), 1_000_000n));
    const plan = approval().planBundles(calls);
    expect(plan.ok && plan.value.map((b) => b.length)).toEqual([12, 12, 6]);
    expect(plan.ok && plan.value.flat()).toEqual(calls.map((_, i) => i));
    expect(MAX_TRANSFERS_PER_PROPOSAL).toBe(12);
  });

  it('splits earlier than 12 when mints, token accounts and the compute budget fill the transaction', () => {
    const calls = Array.from({ length: 12 }, () => spl(wallet(), 5n, Keypair.generate().publicKey));
    const plan = approval().planBundles(calls);
    expect(plan.ok).toBe(true);
    if (!plan.ok) return;
    expect(plan.value.length).toBeGreaterThan(1);
    expect(plan.value.flat()).toEqual(calls.map((_, i) => i));
  });

  it('accepts mixed SOL and token transfers, and Token-2022', () => {
    const calls = [
      sol(wallet(), 5n),
      spl(wallet(), 5n),
      spl(wallet(), 5n, MINT, new PublicKey('TokenzQdBNbLqP5VEhdkAS6EPFLC1PHnBqCXEpPxuEb')),
    ];
    const plan = approval().planBundles(calls);
    expect(plan.ok && plan.value).toEqual([[0, 1, 2]]);
  });

  it('refuses a call it cannot propose: a contract call, a payment from another account, another signer', () => {
    const contract: SolanaCall = {
      programId: Keypair.generate().publicKey.toBase58(),
      accounts: [],
      data: '',
    };
    const other = buildNativeTransferCall(wallet().toBase58(), wallet().toBase58(), 5n);
    const stranger: SolanaCall = {
      ...sol(wallet(), 5n),
      accounts: [
        ...sol(wallet(), 5n).accounts,
        { pubkey: wallet().toBase58(), isSigner: true, isWritable: false },
      ],
    };
    for (const call of [contract, other.ok ? other.value : contract, stranger]) {
      const plan = approval().planBundles([sol(wallet(), 5n), call]);
      expect(plan.ok).toBe(false);
      if (!plan.ok) expect(plan.error.code).toBe('CHAIN_REJECTED');
    }
  });

  it('refuses a System call that is not a transfer', () => {
    const allocate = SystemProgram.allocate({ accountPubkey: VAULT, space: 10 });
    const plan = approval().planBundles([fromTransactionInstruction(allocate)]);
    expect(plan.ok).toBe(false);
  });
});

describe('SquadsApproval.buildProposal', () => {
  it('builds one create transaction: index last + 1, the vault as inner payer, expected and committed', async () => {
    const a = approval(fakeConnection({ index: 4n }));
    const r1 = wallet();
    const r2 = wallet();
    const result = await built(a, [sol(r1, 1_000n), spl(r2, 30n), spl(r2, 12n)]);

    const transaction = deriveTransactionPda(MULTISIG, 5n);
    const proposal = deriveProposalPda(MULTISIG, 5n);
    expect(result.sequence).toBe(5);
    expect(result.proposalRef).toBe(proposal.toBase58());
    expect(result.chainRef).toEqual({
      kind: 'squads',
      multisig: MULTISIG.toBase58(),
      proposal: proposal.toBase58(),
      transactionIndex: 5,
    });
    expect(result.threshold).toBe(2);
    expect(result.executeAfter).toBeNull();
    expect(result.expected).toEqual({
      recipients: 2,
      totals: [
        { asset: 'SOL', amount: '1000' },
        { asset: 'USDC', amount: '42' },
      ],
    });

    // Decode the payload's instructions back into a transaction.
    const signed = await a.signProposal(result);
    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const tx = VersionedTransaction.deserialize(Buffer.from(signed.value.signedBytes, 'base64'));
    const keys = tx.message.staticAccountKeys;
    expect(keys[0]!.toBase58()).toBe(MEMBER.publicKey.toBase58());
    const instructions = tx.message.compiledInstructions.map((i) => ({
      program: keys[i.programIdIndex]!.toBase58(),
      accounts: i.accountKeyIndexes.map((x) => keys[x]!.toBase58()),
      data: Buffer.from(i.data),
    }));
    expect(instructions.map((i) => i.program)).toEqual([
      SQUADS_PROGRAM_ID.toBase58(),
      SQUADS_PROGRAM_ID.toBase58(),
    ]);
    expect(instructions[0]!.accounts.slice(0, 3)).toEqual([
      MULTISIG.toBase58(),
      transaction.toBase58(),
      MEMBER.publicKey.toBase58(),
    ]);
    expect(instructions[1]!.accounts.slice(0, 3)).toEqual([
      MULTISIG.toBase58(),
      proposal.toBase58(),
      MEMBER.publicKey.toBase58(),
    ]);
    expect(instructions[1]!.data.readBigUInt64LE(8)).toBe(5n);
    expect(instructions[1]!.data[16]).toBe(0); // not a draft

    // The vault transaction message: the vault pays and signs, then the transfers.
    const data = instructions[0]!.data;
    const messageLength = data.readUInt32LE(10);
    const message = decodeCompact(data.subarray(14, 14 + messageLength));
    expect(message.keys[0]).toBe(VAULT.toBase58());
    expect(message).toMatchObject({ numSigners: 1, numWritableSigners: 1 });
    const ata = deriveAssociatedTokenAddress(r2, MINT).toBase58();
    expect(message.instructions.map((i) => i.program)).toEqual([
      SystemProgram.programId.toBase58(),
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      TOKEN_PROGRAM_ID.toBase58(),
      'ATokenGPvbdGVxr1b2hvZbsiqW5xWH25efTNsLJA8knL',
      TOKEN_PROGRAM_ID.toBase58(),
    ]);
    expect(message.instructions[0]!.accounts).toEqual([VAULT.toBase58(), r1.toBase58()]);
    expect(message.instructions[0]!.data.readBigUInt64LE(4)).toBe(1000n);
    expect(message.instructions[2]!.accounts).toEqual([
      deriveAssociatedTokenAddress(VAULT, MINT).toBase58(),
      MINT.toBase58(),
      ata,
      VAULT.toBase58(),
    ]);
    expect(message.instructions[2]!.data.readBigUInt64LE(1)).toBe(30n);

    // The Signer would accept it.
    expect(
      checkMultisigMessage(
        MULTISIG.toBase58(),
        MEMBER.publicKey.toBase58(),
        tx.message.serialize(),
      ),
    ).toEqual({ ok: true });
  });

  it('prices rent from the RPC with the real account sizes, and counts token accounts that must be created', async () => {
    const r2 = wallet();
    const r3 = wallet();
    const existing = new Set([deriveAssociatedTokenAddress(r3, MINT).toBase58()]);
    const c = fakeConnection({ existingAccounts: existing });
    const a = approval(c);
    const result = await built(a, [sol(wallet(), 1_000n), spl(r2, 30n), spl(r3, 10n)]);

    const sizes = c.raw.getMinimumBalanceForRentExemption.mock.calls.map((x) => x[0]);
    expect(sizes).toContain(58 + 3 * (4 + 32 * 3)); // the proposal, three members
    const vaultTxSize = sizes[0]!;
    expect(vaultTxSize).toBeGreaterThan(221);
    // ATA rent (165 bytes) only for r2's missing account.
    const proposalRent = (58 + 3 * (4 + 32 * 3)) * 1000;
    expect(result.committed.proposer).toEqual([
      { asset: 'SOL', amount: String(5000 + vaultTxSize * 1000 + proposalRent) },
    ]);
    expect(result.committed.sender).toEqual([
      { asset: 'SOL', amount: String(1000 + 165 * 1000) },
      { asset: 'USDC', amount: '40' },
    ]);
  });

  it('names an unconfigured token by its mint, and counts a recipient once', async () => {
    const other = Keypair.generate().publicKey;
    const r = wallet();
    const result = await built(approval(), [spl(r, 3n, other), spl(r, 4n, other)]);
    expect(result.expected).toEqual({
      recipients: 1,
      totals: [{ asset: other.toBase58(), amount: '7' }],
    });
  });

  it('adds the compute limit and price only with a priority fee, and charges it', async () => {
    const plain = await built(approval(), [sol(wallet(), 1n)]);
    const priced = await built(approval(fakeConnection(), fakeSigner(), { price: 1000 }), [
      sol(wallet(), 1n),
    ]);
    const programs = (b: typeof plain) =>
      (
        JSON.parse(Buffer.from(b.payload, 'base64').toString()) as {
          instructions: { programId: string }[];
        }
      ).instructions.map((i) => i.programId);
    expect(programs(plain)).toHaveLength(2);
    expect(programs(priced)).toHaveLength(4);
    expect(Number(priced.committed.proposer[0]!.amount)).toBeGreaterThan(
      Number(plain.committed.proposer[0]!.amount),
    );
  });

  it('refuses a vault that is not the Sender, a member that cannot propose, and an oversize bundle', async () => {
    const a = approval();
    const wrong = await a.buildProposal({
      calls: [sol(wallet(), 1n)],
      sender: wallet().toBase58(),
    });
    expect(wrong.ok).toBe(false);

    const voter = await approval(fakeConnection({ permissions: 6 })).buildProposal({
      calls: [sol(wallet(), 1n)],
      sender: VAULT.toBase58(),
    });
    expect(!voter.ok && voter.error.code).toBe('CHAIN_REJECTED');

    const many = await a.buildProposal({
      calls: Array.from({ length: 13 }, () => sol(wallet(), 1n)),
      sender: VAULT.toBase58(),
    });
    expect(many.ok).toBe(false);
  });

  it('maps an unreadable RPC to RPC_UNAVAILABLE', async () => {
    const c = fakeConnection();
    c.raw.getAccountInfoAndContext.mockRejectedValueOnce(new Error('fetch failed'));
    const result = await approval(c).buildProposal({
      calls: [sol(wallet(), 1n)],
      sender: VAULT.toBase58(),
    });
    expect(!result.ok && result.error.code).toBe('RPC_UNAVAILABLE');
  });
});

describe('SquadsApproval.signProposal', () => {
  it('asks the Signer to sign as the member, and returns a verified signed transaction and its hash', async () => {
    const s = fakeSigner();
    const a = approval(fakeConnection(), s);
    const result = await a.signProposal(await built(a, [sol(wallet(), 1n)]));
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(s.requests[0]!.address).toBe(MEMBER.publicKey.toBase58());
    const tx = Transaction.from(Buffer.from(result.value.signedBytes, 'base64'));
    expect(tx.verifySignatures()).toBe(true);
    expect(result.value.hash).toBe(bs58.encode(tx.signature!));
  });

  it('re-signs the same payload with a fresh blockhash', async () => {
    const c = fakeConnection();
    const a = approval(c);
    const b = await built(a, [sol(wallet(), 1n)]);
    const first = await a.signProposal(b);
    const second = await a.signProposal(b);
    expect(first.ok && second.ok && first.value.hash !== second.value.hash).toBe(true);
  });

  it.each(['SIGNER_REFUSED', 'SIGNER_UNREACHABLE'] as const)(
    'passes %s through unchanged',
    async (code) => {
      const failure: DispatchError = { code, message: 'no' };
      const a = approval(
        fakeConnection(),
        fakeSigner(() => err(failure)),
      );
      const result = await a.signProposal(await built(a, [sol(wallet(), 1n)]));
      expect(result).toEqual(err(failure));
    },
  );

  it('treats a signature that does not verify as an unreachable Signer', async () => {
    const a = approval(
      fakeConnection(),
      fakeSigner(() => ok({ signature: Buffer.alloc(64, 1).toString('base64') })),
    );
    const result = await a.signProposal(await built(a, [sol(wallet(), 1n)]));
    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });

  it('maps an unreadable blockhash to RPC_UNAVAILABLE and a foreign payload to CHAIN_REJECTED', async () => {
    const c = fakeConnection();
    const a = approval(c);
    const b = await built(a, [sol(wallet(), 1n)]);
    c.raw.getLatestBlockhash.mockRejectedValueOnce(new Error('timed out'));
    const down = await a.signProposal(b);
    expect(!down.ok && down.error.code).toBe('RPC_UNAVAILABLE');
    const bad = await a.signProposal({ ...b, payload: 'bm90IGpzb24=' });
    expect(!bad.ok && bad.error.code).toBe('CHAIN_REJECTED');
  });
});

describe('SquadsApproval.submitProposal', () => {
  const confirmed: Status = { err: null, confirmationStatus: 'confirmed' };

  async function signedWith(c: ReturnType<typeof fakeConnection>) {
    const a = approval(c);
    const signed = await a.signProposal(await built(a, [sol(wallet(), 1n)]));
    if (!signed.ok) throw new Error('sign failed');
    return { a, signed: signed.value };
  }

  it('sends and waits for confirmation by polling', async () => {
    const c = fakeConnection({
      statuses: [null, { err: null, confirmationStatus: 'processed' }, confirmed],
    });
    const { a, signed } = await signedWith(c);
    expect((await a.submitProposal(signed)).ok).toBe(true);
    expect(c.sent.length).toBeGreaterThanOrEqual(1);
    expect(c.sent[0]!.toString('base64')).toBe(signed.signedBytes);
  });

  it('is idempotent: an already landed transaction is success, and sending again does no harm', async () => {
    const c = fakeConnection({
      statuses: [confirmed],
      sendError: new Error('This transaction has already been processed'),
    });
    const { a, signed } = await signedWith(c);
    expect((await a.submitProposal(signed)).ok).toBe(true);
    expect((await a.submitProposal(signed)).ok).toBe(true);
  });

  it('treats "already processed" at send as landed, then confirms by status', async () => {
    const c = fakeConnection({
      statuses: [null, confirmed],
      sendError: new Error(
        'Transaction simulation failed: This transaction has already been processed',
      ),
    });
    const { a, signed } = await signedWith(c);
    expect((await a.submitProposal(signed)).ok).toBe(true);
  });

  it('returns a transient BLOCKHASH_EXPIRED error once the blockhash is provably expired', async () => {
    const c = fakeConnection({
      statuses: [null],
      height: 5000,
      sendError: new Error('Blockhash not found'),
    });
    const { a, signed } = await signedWith(c);
    const result = await a.submitProposal(signed);
    expect(!result.ok && result.error.code).toBe('RPC_UNAVAILABLE');
    expect(!result.ok && result.error.chainDetail).toMatchObject({ reason: 'BLOCKHASH_EXPIRED' });
  });

  it('after a restart bounds expiry from the tip, and never calls a fresh transaction expired', async () => {
    const c = fakeConnection({ statuses: [null, confirmed], height: 900 });
    const { signed } = await signedWith(c);
    const restarted = approval(c);
    expect((await restarted.submitProposal(signed)).ok).toBe(true);
  });

  it('maps a failure on chain and a refusal at send to CHAIN_REJECTED, funds to INSUFFICIENT_FUNDS, an RPC outage to RPC_UNAVAILABLE', async () => {
    const failed = fakeConnection({
      statuses: [{ err: { InstructionError: [0, 'Custom'] }, confirmationStatus: 'confirmed' }],
    });
    const f = await signedWith(failed);
    const onChain = await f.a.submitProposal(f.signed);
    expect(!onChain.ok && onChain.error.code).toBe('CHAIN_REJECTED');

    const refused = fakeConnection({
      statuses: [null],
      sendError: new Error('Transaction simulation failed: custom program error: 0x0'),
    });
    const r = await signedWith(refused);
    expect((await r.a.submitProposal(r.signed)).ok).toBe(false);

    const poor = fakeConnection({
      statuses: [null],
      sendError: new Error(
        'Attempt to debit an account but found no record of a prior credit. insufficient funds',
      ),
    });
    const p = await signedWith(poor);
    const funds = await p.a.submitProposal(p.signed);
    expect(!funds.ok && funds.error.code).toBe('INSUFFICIENT_FUNDS');

    const down = fakeConnection({ statuses: [null], sendError: new Error('fetch failed') });
    const d = await signedWith(down);
    const outage = await d.a.submitProposal(d.signed);
    expect(!outage.ok && outage.error.code).toBe('RPC_UNAVAILABLE');

    const unreadable = fakeConnection({ statuses: [confirmed] });
    const u = await signedWith(unreadable);
    unreadable.raw.getSignatureStatuses.mockRejectedValueOnce(new Error('timed out'));
    expect((await u.a.submitProposal(u.signed)).ok).toBe(false);
  });

  it('refuses bytes that are not a transaction, or do not match their hash', async () => {
    const c = fakeConnection({ statuses: [confirmed] });
    const { a, signed } = await signedWith(c);
    const junk = await a.submitProposal({ signedBytes: 'AAAA', hash: 'x' });
    expect(!junk.ok && junk.error.code).toBe('CHAIN_REJECTED');
    const mismatch = await a.submitProposal({ ...signed, hash: bs58.encode(Buffer.alloc(64, 2)) });
    expect(!mismatch.ok && mismatch.error.code).toBe('CHAIN_REJECTED');
  });
});

describe('SquadsApproval.estimateApprovalCost', () => {
  it('sums the fees and rent of every proposal, and reports the rent that is locked', async () => {
    const a = approval();
    const calls = Array.from({ length: 13 }, () => sol(wallet(), 1n)); // two proposals
    const cost = await a.estimateApprovalCost(calls, VAULT.toBase58());
    expect(cost.ok).toBe(true);
    if (!cost.ok) return;
    const one = await a.estimateApprovalCost([calls[0]!], VAULT.toBase58());
    expect(cost.value.asset).toBe('SOL');
    expect(BigInt(cost.value.rentLocked)).toBeGreaterThan(
      BigInt(one.ok ? one.value.rentLocked : '0') * 2n - 1n,
    );
    expect(BigInt(cost.value.amount)).toBeGreaterThan(BigInt(cost.value.rentLocked));
  });

  it('reports its holders and limits', () => {
    const a = approval();
    expect(a.holders).toEqual({ sender: 'vault', proposer: 'memberKey' });
    expect(a.openProposalLimit).toBe(Infinity);
    expect(a.reexecuteOnFailure).toBe(true);
  });
});
