// Generates PUBLIC-DATA Squads fixtures with @sqds/multisig 2.1.4. No network, no secrets:
// every key is derived from a public label, none ever signs anything.
import crypto from 'node:crypto';
import fs from 'node:fs';
import * as web3 from '@solana/web3.js';
import * as spl from '@solana/spl-token';
import * as sq from '@sqds/multisig';

const { PublicKey, SystemProgram, TransactionMessage, Keypair } = web3;
const { Multisig, Proposal, VaultTransaction } = sq.accounts; const { PROGRAM_ID } = sq;

const pk = (label) => Keypair.fromSeed(crypto.createHash('sha256').update(label).digest()).publicKey;

const createKey = pk('verifier-fixture-createKey');
const [multisigPda] = sq.getMultisigPda({ createKey });
const [vaultPda, vaultBump] = sq.getVaultPda({ multisigPda, index: 0 });
const members = ['m1', 'm2', 'm3', 'engine'].map((l) => pk('verifier-fixture-' + l));
const engine = members[3];

const accounts = {}; // address -> {owner, data(base64)}
const put = (address, owner, buf) => {
  accounts[address.toBase58()] = { owner: owner.toBase58(), data: Buffer.from(buf).toString('base64') };
};

// --- multisig account
const ms = Multisig.fromArgs({
  createKey,
  configAuthority: PublicKey.default,
  threshold: 2,
  timeLock: 3600,
  transactionIndex: 6,
  staleTransactionIndex: 0,
  rentCollector: engine,
  bump: 255,
  members: members.map((key, i) => ({ key, permissions: { mask: i === 3 ? 5 : 2 } })),
});
put(multisigPda, PROGRAM_ID, ms.serialize()[0]);

// --- token mints and token accounts
const tokenAcct = (mint, owner, amount) => {
  const b = Buffer.alloc(165);
  mint.toBuffer().copy(b, 0);
  owner.toBuffer().copy(b, 32);
  b.writeBigUInt64LE(BigInt(amount), 64);
  b[108] = 1; // initialized
  return b;
};
const mintClassic = pk('verifier-fixture-mint-classic');
const mint22 = pk('verifier-fixture-mint-2022');
const r = Object.fromEntries(['r1', 'r2', 'r3', 'r4', 'r5', 'r6', 'r7'].map((l) => [l, pk('verifier-fixture-' + l)]));
const vaultAta = (mint, prog) => spl.getAssociatedTokenAddressSync(mint, vaultPda, true, prog);
const ata = (mint, owner, prog) => spl.getAssociatedTokenAddressSync(mint, owner, true, prog);
const T = spl.TOKEN_PROGRAM_ID;
const T22 = spl.TOKEN_2022_PROGRAM_ID;

put(vaultAta(mintClassic, T), T, tokenAcct(mintClassic, vaultPda, 10_000_000));
put(vaultAta(mint22, T22), T22, tokenAcct(mint22, vaultPda, 10_000_000));
put(ata(mintClassic, r.r3, T), T, tokenAcct(mintClassic, r.r3, 0));
put(ata(mintClassic, r.r4, T), T, tokenAcct(mintClassic, r.r4, 0));
put(ata(mint22, r.r5, T22), T22, tokenAcct(mint22, r.r5, 0));
// r6's token account does NOT exist on chain (the message creates it); r7's is absent and never created.

// --- vault transactions + proposals
const compact = (ixs) =>
  sq.utils.transactionMessageToMultisigTransactionMessageBytes({
    message: new TransactionMessage({
      payerKey: vaultPda,
      recentBlockhash: PublicKey.default.toBase58(),
      instructions: ixs,
    }),
    addressLookupTableAccounts: [],
    vaultPda,
  });

const transfer = (to, lamports) =>
  SystemProgram.transfer({ fromPubkey: vaultPda, toPubkey: to, lamports });
const splChecked = (mint, owner, amount, prog, decimals = 6) =>
  spl.createTransferCheckedInstruction(vaultAta(mint, prog), mint, ata(mint, owner, prog), vaultPda, amount, decimals, [], prog);
const splPlain = (mint, owner, amount, prog) =>
  spl.createTransferInstruction(vaultAta(mint, prog), ata(mint, owner, prog), vaultPda, amount, [], prog);

const cases = {
  // index 1: Active, 1 of 2 approved. 2 SOL + SPL transferChecked + SPL plain transfer
  'sol-spl': {
    index: 1,
    status: { __kind: 'Active', timestamp: 1_760_000_000 },
    approved: [members[0]],
    ixs: [
      transfer(r.r1, 1_000_000),
      transfer(r.r2, 2_000_000),
      splChecked(mintClassic, r.r3, 500, T),
      splPlain(mintClassic, r.r4, 700, T),
    ],
  },
  // index 2: Approved, Token-2022 transferChecked
  token2022: {
    index: 2,
    status: { __kind: 'Approved', timestamp: 1_760_000_100 },
    approved: [members[0], members[1]],
    ixs: [splChecked(mint22, r.r5, 900, T22)],
  },
  // index 3: Active, a System assign: not a payment
  'unknown-instruction': {
    index: 3,
    status: { __kind: 'Active', timestamp: 1_760_000_200 },
    approved: [],
    ixs: [transfer(r.r1, 1_000_000), SystemProgram.assign({ accountPubkey: vaultPda, programId: r.r7 })],
  },
  // index 4: Executed, creates r6's ATA in the same message then pays it
  'ata-create': {
    index: 4,
    status: { __kind: 'Executed', timestamp: 1_760_000_300 },
    approved: [members[0], members[1]],
    ixs: [
      spl.createAssociatedTokenAccountIdempotentInstruction(vaultPda, ata(mintClassic, r.r6, T), r.r6, mintClassic, T),
      splChecked(mintClassic, r.r6, 250, T),
    ],
  },
  // index 5: Active, pays a token account that is neither on chain nor created
  unresolved: {
    index: 5,
    status: { __kind: 'Active', timestamp: 1_760_000_400 },
    approved: [],
    ixs: [splPlain(mintClassic, r.r7, 100, T)],
  },
  // index 6: Cancelled, same as sol-spl's first transfer
  cancelled: {
    index: 6,
    status: { __kind: 'Cancelled', timestamp: 1_760_000_500 },
    approved: [members[0], members[1]],
    ixs: [transfer(r.r1, 1_000_000)],
  },
};

const out = {};
for (const [name, c] of Object.entries(cases)) {
  const compactBytes = compact(c.ixs);
  const [m] = sq.types.transactionMessageBeet.deserialize(Buffer.from(compactBytes));
  const message = {
    numSigners: m.numSigners,
    numWritableSigners: m.numWritableSigners,
    numWritableNonSigners: m.numWritableNonSigners,
    accountKeys: m.accountKeys,
    instructions: m.instructions.map((i) => ({
      programIdIndex: i.programIdIndex,
      accountIndexes: Uint8Array.from(i.accountIndexes),
      data: Uint8Array.from(i.data),
    })),
    addressTableLookups: m.addressTableLookups,
  };
  const [txPda, txBump] = sq.getTransactionPda({ multisigPda, index: BigInt(c.index) });
  const [propPda, propBump] = sq.getProposalPda({ multisigPda, transactionIndex: BigInt(c.index) });
  const vt = VaultTransaction.fromArgs({
    multisig: multisigPda,
    creator: engine,
    index: BigInt(c.index),
    bump: txBump,
    vaultIndex: 0,
    vaultBump,
    ephemeralSignerBumps: new Uint8Array(),
    message,
  });
  put(txPda, PROGRAM_ID, vt.serialize()[0]);
  const pr = Proposal.fromArgs({
    multisig: multisigPda,
    transactionIndex: BigInt(c.index),
    status: c.status,
    bump: propBump,
    approved: c.approved,
    rejected: [],
    cancelled: [],
  });
  put(propPda, PROGRAM_ID, pr.serialize()[0]);
  out[name] = { index: c.index, proposal: propPda.toBase58(), transaction: txPda.toBase58() };
}

const result = {
  programId: PROGRAM_ID.toBase58(),
  multisig: multisigPda.toBase58(),
  vault: vaultPda.toBase58(),
  mints: { classic: mintClassic.toBase58(), token2022: mint22.toBase58() },
  recipients: Object.fromEntries(Object.entries(r).map(([k, v]) => [k, v.toBase58()])),
  cases: out,
  accounts,
};
fs.writeFileSync(process.argv[2], JSON.stringify(result, null, 2) + '\n');
console.log('wrote', process.argv[2], Object.keys(accounts).length, 'accounts');
