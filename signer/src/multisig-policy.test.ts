import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js';
import { afterEach, describe, expect, it } from 'vitest';

import { createKeyfileBackend } from './backends/keyfile.js';
import { lookupKey, parseSignerConfig } from './config.js';
import { evaluatePolicy, parsePolicy, type Policy } from './policy.js';
import { createSignerServer, type AuditRecord } from './server.js';
import { SQUADS_PROGRAM } from './squads.js';

const program = new PublicKey(SQUADS_PROGRAM);
const member = Keypair.generate().publicKey;
const multisig = Keypair.generate().publicKey;
const otherMultisig = Keypair.generate().publicKey;
const blockhash = Keypair.generate().publicKey.toBase58();

/** Anchor discriminators, from the #70 spike. */
const DISCRIMINATOR = {
  vaultTransactionCreate: '30fa4ea8d0e2dad3',
  proposalCreate: 'dc3c49e01e6c4f9f',
  vaultTransactionExecute: 'c208a15799a419ab',
  vaultTransactionAccountsClose: 'c447bbb00223aaa5',
  proposalApprove: '9025a488bcd82af8',
  proposalReject: 'f33e869ce66af687',
  proposalCancelV2: 'cd29c23ddc8b10f7',
  proposalCancel: '1b2a7fed26a354cb',
  proposalActivate: '0b225cf89a1b336a',
};

const meta = (pubkey: PublicKey, isSigner = false, isWritable = false) => ({
  pubkey,
  isSigner,
  isWritable,
});

/** A Squads instruction with the account order the spike measured, on `target` as the multisig. */
function squads(
  name: keyof typeof DISCRIMINATOR,
  target: PublicKey = multisig,
  args: Buffer = Buffer.alloc(0),
  programId: PublicKey = program,
): TransactionInstruction {
  const account = () => Keypair.generate().publicKey;
  const accounts = {
    vaultTransactionCreate: [
      meta(target, false, true),
      meta(account(), false, true),
      meta(member, true),
      meta(member, true, true),
      meta(SystemProgram.programId),
    ],
    proposalCreate: [
      meta(target),
      meta(account(), false, true),
      meta(member, true),
      meta(member, true, true),
      meta(SystemProgram.programId),
    ],
    vaultTransactionExecute: [
      meta(target),
      meta(account(), false, true),
      meta(account()),
      meta(member, true),
    ],
    vaultTransactionAccountsClose: [
      meta(target),
      meta(account(), false, true),
      meta(account(), false, true),
      meta(account(), false, true),
      meta(SystemProgram.programId),
    ],
    proposalApprove: [meta(target), meta(member, true, true), meta(account(), false, true)],
    proposalReject: [meta(target), meta(member, true, true), meta(account(), false, true)],
    proposalCancelV2: [
      meta(target),
      meta(member, true, true),
      meta(account(), false, true),
      meta(SystemProgram.programId),
    ],
    proposalCancel: [meta(target), meta(member, true, true), meta(account(), false, true)],
    proposalActivate: [meta(target), meta(member, true, true), meta(account(), false, true)],
  }[name];
  return new TransactionInstruction({
    programId,
    keys: accounts,
    data: Buffer.concat([Buffer.from(DISCRIMINATOR[name], 'hex'), args]),
  });
}

function message(instructions: TransactionInstruction[], payer: PublicKey = member): Uint8Array {
  return new TransactionMessage({ payerKey: payer, recentBlockhash: blockhash, instructions })
    .compileToLegacyMessage()
    .serialize();
}

function policy(raw: Record<string, unknown>): Policy {
  const parsed = parsePolicy('ed25519', raw);
  if (Array.isArray(parsed)) throw new Error(parsed.join('; '));
  return parsed;
}

const pinned = policy({ allowedMultisig: multisig.toBase58() });
const evaluate = (tx: Uint8Array, p: Policy = pinned, signer: string = member.toBase58()) =>
  evaluatePolicy(p, 'ed25519', tx, signer);
const refusal = (reason: string | RegExp) => ({
  ok: false,
  reason: typeof reason === 'string' ? reason : (expect.stringMatching(reason) as string),
});

const ALLOWED = [
  'vaultTransactionCreate',
  'proposalCreate',
  'vaultTransactionExecute',
  'vaultTransactionAccountsClose',
] as const;

describe('allowedMultisig', () => {
  it.each(ALLOWED)('signs %s on the pinned multisig', (name) => {
    expect(evaluate(message([squads(name)]))).toEqual({ ok: true });
  });

  it('signs the engine’s propose transaction: budget instructions, create and proposal together', () => {
    const tx = message([
      ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
      ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 10 }),
      squads('vaultTransactionCreate', multisig, Buffer.from([0, 0, 1, 2, 3])),
      squads('proposalCreate', multisig, Buffer.alloc(9)),
    ]);

    expect(evaluate(tx)).toEqual({ ok: true });
  });

  it('signs an execute with requestHeapFrame and a compute limit', () => {
    const tx = message([
      ComputeBudgetProgram.requestHeapFrame({ bytes: 256 * 1024 }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: 400_000 }),
      squads('vaultTransactionExecute'),
    ]);

    expect(evaluate(tx)).toEqual({ ok: true });
  });

  it.each(ALLOWED)('refuses %s on any other multisig', (name) => {
    expect(evaluate(message([squads(name, otherMultisig)]))).toEqual(
      refusal(`Squads ${name} targets ${otherMultisig.toBase58()}, not the allowedMultisig`),
    );
  });

  it('refuses a transaction whose second Squads instruction targets another multisig', () => {
    const tx = message([squads('vaultTransactionCreate'), squads('proposalCreate', otherMultisig)]);

    expect(evaluate(tx)).toEqual(refusal(/proposalCreate targets/));
  });

  it.each(['proposalApprove', 'proposalReject', 'proposalCancelV2', 'proposalCancel'] as const)(
    'refuses a vote, %s, even on the pinned multisig',
    (name) => {
      expect(evaluate(message([squads(name)]))).toEqual(
        refusal(
          `Squads ${name} is not allowed with allowedMultisig: this key only proposes, executes and closes`,
        ),
      );
    },
  );

  it('refuses an instruction it does not recognise, such as a config transaction or an activation', () => {
    const configCreate = new TransactionInstruction({
      programId: program,
      keys: [meta(multisig), meta(member, true)],
      data: Buffer.from('0102030405060708', 'hex'),
    });

    expect(evaluate(message([configCreate]))).toEqual(
      refusal('Squads instruction 0102030405060708 is not allowed with allowedMultisig'),
    );
    expect(evaluate(message([squads('proposalActivate')]))).toEqual(
      refusal(/Squads instruction 0b225cf89a1b336a is not allowed/),
    );
  });

  it('refuses a Squads instruction with no data', () => {
    const empty = new TransactionInstruction({
      programId: program,
      keys: [],
      data: Buffer.alloc(0),
    });

    expect(evaluate(message([empty]))).toEqual(refusal(/Squads instruction \(empty\)/));
  });

  it('refuses another program, whatever else rides along', () => {
    const other = Keypair.generate().publicKey;
    const tx = message([
      squads('vaultTransactionCreate'),
      squads('proposalCreate', multisig, Buffer.alloc(0), other),
    ]);

    expect(evaluate(tx)).toEqual(
      refusal(`program ${other.toBase58()} is not allowed with allowedMultisig`),
    );
  });

  it('refuses a plain SOL transfer', () => {
    const transfer = SystemProgram.transfer({
      fromPubkey: member,
      toPubkey: otherMultisig,
      lamports: 1,
    });

    expect(evaluate(message([transfer]))).toEqual(
      refusal(`program ${SystemProgram.programId.toBase58()} is not allowed with allowedMultisig`),
    );
  });

  it('refuses a ComputeBudget instruction it does not expect', () => {
    const tx = message([
      new TransactionInstruction({
        programId: ComputeBudgetProgram.programId,
        keys: [],
        data: Buffer.from([4, 0xe8, 3, 0, 0]),
      }),
      squads('proposalCreate'),
    ]);

    expect(evaluate(tx)).toEqual(
      refusal('ComputeBudget instruction 4 is not allowed with allowedMultisig'),
    );
  });

  it('refuses a transaction with only budget instructions', () => {
    expect(evaluate(message([ComputeBudgetProgram.setComputeUnitLimit({ units: 1 })]))).toEqual(
      refusal('the transaction has no Squads instruction'),
    );
  });

  it('refuses a fee payer that is not the signing address', () => {
    const tx = message([squads('proposalCreate')], otherMultisig);

    expect(evaluate(tx)).toEqual(refusal('the fee payer is not the signing address'));
    expect(evaluatePolicy(pinned, 'ed25519', tx, undefined)).toEqual(
      refusal('the fee payer is not the signing address'),
    );
  });

  it('refuses what it cannot decode', () => {
    expect(evaluate(Uint8Array.from([1, 2, 3]))).toEqual(refusal(/^undecodable transaction/));
    const padded = Uint8Array.from([...message([squads('proposalCreate')]), 0]);
    expect(evaluate(padded)).toEqual(refusal(/^undecodable transaction/));
  });

  it('refuses a Squads instruction whose multisig comes from a lookup table', () => {
    const table = Keypair.generate().publicKey;
    const v0 = new TransactionMessage({
      payerKey: member,
      recentBlockhash: blockhash,
      instructions: [squads('proposalCreate')],
    }).compileToV0Message([
      new AddressLookupTableAccount({
        key: table,
        state: {
          deactivationSlot: 2n ** 64n - 1n,
          lastExtendedSlot: 0,
          lastExtendedSlotStartIndex: 0,
          addresses: [multisig],
        },
      }),
    ]);

    expect(evaluate(v0.serialize())).toEqual(refusal(/proposalCreate targets/));
  });

  it('leaves an address without allowedMultisig as it was: Squads is just another program', () => {
    const tx = message([squads('proposalApprove', otherMultisig)]);

    expect(evaluate(tx, policy({}))).toEqual({ ok: true });
    expect(evaluate(tx, policy({ allowedDestinations: [SQUADS_PROGRAM] }))).toEqual({ ok: true });
    expect(evaluate(tx, policy({ allowedDestinations: [] }))).toEqual(
      refusal(`destination ${SQUADS_PROGRAM} is not in allowedDestinations`),
    );
  });

  it('still applies the other rules of the policy to a pinned key', () => {
    const narrow = policy({ allowedMultisig: multisig.toBase58(), allowedDestinations: [] });

    expect(evaluate(message([squads('proposalCreate')]), narrow)).toEqual(
      refusal(`destination ${SQUADS_PROGRAM} is not in allowedDestinations`),
    );
  });
});

describe('parsePolicy: allowedMultisig', () => {
  it('keeps the multisig address', () => {
    expect(policy({ allowedMultisig: multisig.toBase58() })).toEqual({
      allowedMultisig: multisig.toBase58(),
    });
  });

  it('rejects it on a secp256k1 address', () => {
    expect(parsePolicy('secp256k1', { allowedMultisig: multisig.toBase58() })).toEqual([
      'policy.allowedMultisig applies only to ed25519 (Solana) addresses',
    ]);
  });

  it.each([['not base58!'], ['0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A'], [7], [null]])(
    'rejects a malformed address %j',
    (bad) => {
      expect(parsePolicy('ed25519', { allowedMultisig: bad })).toEqual([
        `policy.allowedMultisig must be a Solana address, got ${JSON.stringify(bad)}`,
      ]);
    },
  );
});

describe('the Signer with allowedMultisig', () => {
  const key = Keypair.generate();
  const dir = mkdtempSync(path.join(tmpdir(), 'signer-multisig-'));
  const keyfilePath = path.join(dir, 'keys.json');
  writeFileSync(
    keyfilePath,
    JSON.stringify({
      secp256k1: {},
      ed25519: { sender: Buffer.from(key.secretKey.subarray(0, 32)).toString('hex') },
    }),
  );
  const signer = key.publicKey;
  let close: (() => Promise<void>) | undefined;
  afterEach(async () => {
    await close?.();
  });

  it('refuses a vote with 403 { error, reason } and audits the decision and reason, without signing', async () => {
    const audited: AuditRecord[] = [];
    const config = parseSignerConfig({
      [signer.toBase58()]: {
        curve: 'ed25519',
        backend: 'keyfile',
        keyRef: 'sender',
        policy: { allowedMultisig: multisig.toBase58() },
      },
    });
    const server = createSignerServer({
      keyring: new Map(
        [...config.values()].map((entry) => [
          lookupKey(entry.curve, entry.address),
          { entry, backend: createKeyfileBackend(keyfilePath, () => {}) },
        ]),
      ),
      authToken: 'test-token',
      audit: (line) => audited.push(JSON.parse(line) as AuditRecord),
    });
    await new Promise<void>((resolve) => server.listen(0, resolve));
    close = () => new Promise((resolve) => server.close(() => resolve()));
    const { port } = server.address() as AddressInfo;

    const sign = (tx: Uint8Array) =>
      fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
        body: JSON.stringify({
          chain: 'solana',
          curve: 'ed25519',
          address: signer.toBase58(),
          unsignedTransaction: Buffer.from(tx).toString('base64'),
        }),
      });
    const build = (instruction: TransactionInstruction) => message([instruction], signer);

    const vote = await sign(build(squads('proposalApprove')));
    expect(vote.status).toBe(403);
    const reason =
      'Squads proposalApprove is not allowed with allowedMultisig: this key only proposes, executes and closes';
    expect(await vote.json()).toEqual({ error: 'policy refused', reason });

    const create = await sign(build(squads('proposalCreate')));
    expect(create.status).toBe(200);

    expect(audited).toEqual([
      expect.objectContaining({ decision: 'refused', status: 403, reason }),
      expect.objectContaining({ decision: 'signed', status: 200 }),
    ]);
    expect(audited[0]).not.toHaveProperty('transactionId');
  });
});
