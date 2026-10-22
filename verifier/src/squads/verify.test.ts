import { readFileSync } from 'node:fs';
import { PublicKey } from '@solana/web3.js';
import { describe, expect, it } from 'vitest';
import { RpcError } from '../errors.js';
import type { Payment } from '../payments.js';
import { verifySquads } from './verify.js';
import type { AccountReader } from './instructions.js';
import { decodeMultisig, decodeProposal, decodeVaultTransaction } from './layout.js';

// Public-data fixtures built with @sqds/multisig 2.1.4 (see ../../fixtures/generate-squads.mjs).
interface Fixture {
  programId: string;
  multisig: string;
  vault: string;
  mints: { classic: string; token2022: string };
  recipients: Record<'r1' | 'r2' | 'r3' | 'r4' | 'r5' | 'r6' | 'r7', string>;
  cases: Record<string, { index: number; proposal: string; transaction: string }>;
  accounts: Record<string, { owner: string; data: string }>;
}
const fx = JSON.parse(
  readFileSync(new URL('../../fixtures/squads.json', import.meta.url), 'utf8'),
) as Fixture;

function reader(
  overrides: Record<string, { owner: string; data: string } | null> = {},
): AccountReader {
  return (addresses) =>
    Promise.resolve(
      addresses.map((a) => {
        const acc = a in overrides ? overrides[a] : fx.accounts[a];
        return acc
          ? { owner: acc.owner, data: Uint8Array.from(Buffer.from(acc.data, 'base64')) }
          : null;
      }),
    );
}

const { r1, r2, r3, r4, r5, r6, r7 } = fx.recipients;
const pay = (recipient: string, asset: string, amount: bigint, line: number): Payment => ({
  recipient,
  asset,
  amount,
  line,
});

/** The file a caller would hold for the `sol-spl` proposal, plus two payments the proposal does not carry. */
const mainFile = (): Payment[] => [
  pay(r1, 'native', 1_000_000n, 1),
  pay(r2, 'native', 2_000_000n, 2),
  pay(r3, fx.mints.classic, 500n, 3),
  pay(r4, fx.mints.classic, 700n, 4),
  pay(r5, fx.mints.token2022, 900n, 5),
  pay(r6, fx.mints.classic, 250n, 6),
];

const run = (name: string, payments: Payment[], read = reader()) => {
  const c = fx.cases[name];
  if (!c) throw new Error(`no fixture ${name}`);
  return verifySquads({ proposal: c.proposal, payments, read });
};

describe('Squads account decoding (against SDK-built bytes)', () => {
  it('decodes the multisig, a proposal and a vault transaction', () => {
    const ms = decodeMultisig(Buffer.from(fx.accounts[fx.multisig]!.data, 'base64'));
    expect(ms.threshold).toBe(2);
    expect(ms.timeLockSeconds).toBe(3600);
    expect(ms.members).toHaveLength(4);
    const c = fx.cases['sol-spl']!;
    const p = decodeProposal(Buffer.from(fx.accounts[c.proposal]!.data, 'base64'));
    expect(p).toMatchObject({ status: 'Active', transactionIndex: 1n, multisig: fx.multisig });
    expect(p.approved).toHaveLength(1);
    const vt = decodeVaultTransaction(Buffer.from(fx.accounts[c.transaction]!.data, 'base64'));
    expect(vt.message.instructions).toHaveLength(4);
  });
});

describe('verifySquads', () => {
  it('MATCH: every proposal payment is in the file; reports status, approvals and coverage', async () => {
    const r = await run('sol-spl', mainFile());
    expect(r.verdict).toBe('MATCH');
    expect(r.problems).toEqual([]);
    expect(r.comparison?.matched).toHaveLength(4);
    expect(r.comparison?.uncovered.map((u) => u.position)).toEqual([5, 6]);
    const facts = Object.fromEntries(r.facts);
    expect(facts['Status']).toMatch(/^Active/);
    expect(facts['Approvals']).toBe('1 of 2 needed');
    expect(facts['Time lock']).toBe('3600 seconds');
    expect(facts['Vault (pays)']).toBe(fx.vault);
    expect(facts['Multisig']).toBe(fx.multisig);
  });

  it('MATCH: a subset is fine, and file order does not matter', async () => {
    const file = mainFile().reverse();
    const r = await run('sol-spl', file);
    expect(r.verdict).toBe('MATCH');
  });

  it('MISMATCH: a changed amount is reported against the file line', async () => {
    const file = mainFile();
    file[1] = pay(r2, 'native', 1_999_999n, 2);
    const r = await run('sol-spl', file);
    expect(r.verdict).toBe('MISMATCH');
    expect(r.comparison?.mismatches).toHaveLength(1);
    expect(r.comparison?.mismatches[0]).toMatchObject({
      kind: 'amount',
      proposal: { recipient: r2, amount: 2_000_000n },
      file: { position: 2, amount: 1_999_999n },
    });
  });

  it('MISMATCH: an extra recipient the file does not have', async () => {
    const file = mainFile().filter((p) => p.recipient !== r2);
    const r = await run('sol-spl', file);
    expect(r.verdict).toBe('MISMATCH');
    expect(r.comparison?.mismatches).toMatchObject([
      { kind: 'extra', proposal: { recipient: r2 } },
    ]);
  });

  it('MISMATCH: a proposal payment with no counterpart in the file', async () => {
    const file = mainFile();
    // the cancelled fixture pays r1 1_000_000 once; pair it with a file holding it once: ok
    const ok = await run('cancelled', file);
    expect(ok.verdict).toBe('MATCH');
    // and with no such payment at all: not ok
    const none = await run('cancelled', file.slice(1));
    expect(none.verdict).toBe('MISMATCH');
  });

  it('MATCH when a recipient is missing from the proposal (subset), with coverage below 100%', async () => {
    const r = await run('sol-spl', mainFile().slice(0, 4));
    expect(r.verdict).toBe('MATCH');
    expect(r.comparison?.uncovered).toHaveLength(0);
  });

  it('MISMATCH: an unrecognized instruction', async () => {
    const r = await run('unknown-instruction', mainFile());
    expect(r.verdict).toBe('MISMATCH');
    expect(r.problems.join('\n')).toMatch(/instruction 2: unrecognized instruction/);
  });

  it('MISMATCH: a wrong asset (SOL stated in the file where the proposal pays a token)', async () => {
    const file = mainFile();
    file[2] = pay(r3, 'native', 500n, 3);
    const r = await run('sol-spl', file);
    expect(r.verdict).toBe('MISMATCH');
    expect(
      r.comparison?.mismatches.some((m) => m.kind === 'asset' && m.proposal.recipient === r3),
    ).toBe(true);
  });

  it('MISMATCH: the right amount in the wrong mint', async () => {
    const file = mainFile();
    file[2] = pay(r3, fx.mints.token2022, 500n, 3);
    const r = await run('sol-spl', file);
    expect(r.verdict).toBe('MISMATCH');
  });

  it('decodes a Token-2022 transferChecked and reads the Approved status and time lock', async () => {
    const r = await run('token2022', mainFile());
    expect(r.verdict).toBe('MATCH');
    expect(r.proposalItems).toMatchObject([
      { recipient: r5, asset: fx.mints.token2022, amount: 900n },
    ]);
    const facts = Object.fromEntries(r.facts);
    expect(facts['Status']).toMatch(/^Approved/);
    expect(facts['Approvals']).toBe('2 of 2 needed');
    expect(facts['Executable from']).toBeDefined();
  });

  it('resolves a destination through a token-account creation in the same proposal', async () => {
    const r = await run('ata-create', mainFile());
    expect(r.verdict).toBe('MATCH');
    expect(r.proposalItems).toMatchObject([
      { recipient: r6, asset: fx.mints.classic, amount: 250n },
    ]);
    expect(r.notes.join('\n')).toMatch(/creates the token account/);
    expect(Object.fromEntries(r.facts)['Status']).toMatch(/^Executed/);
  });

  it('MISMATCH, plainly, when a destination token account cannot be resolved', async () => {
    const r = await run('unresolved', [pay(r7, fx.mints.classic, 100n, 1)]);
    expect(r.verdict).toBe('MISMATCH');
    expect(r.problems.join('\n')).toMatch(/cannot be resolved to an owner/);
  });

  it('MISMATCH: a destination token account that holds a different mint than the instruction states', async () => {
    // r3's token account is served as holding the Token-2022 mint
    const key = Object.keys(fx.accounts).find((k) => {
      const d = Buffer.from(fx.accounts[k]!.data, 'base64');
      return d.length === 165 && new PublicKey(d.subarray(32, 64)).toBase58() === r3;
    })!;
    const acc = fx.accounts[key]!;
    const d = Buffer.from(acc.data, 'base64');
    new PublicKey(fx.mints.token2022).toBuffer().copy(d, 0);
    const r = await run(
      'sol-spl',
      mainFile(),
      reader({ [key]: { ...acc, data: d.toString('base64') } }),
    );
    expect(r.verdict).toBe('MISMATCH');
    expect(r.problems.join('\n')).toMatch(/holds mint/);
  });

  it('exit-2 conditions: unknown proposal, wrong owner, closed vault transaction', async () => {
    const c = fx.cases['sol-spl']!;
    await expect(run('sol-spl', mainFile(), reader({ [c.proposal]: null }))).rejects.toBeInstanceOf(
      RpcError,
    );
    const prop = fx.accounts[c.proposal]!;
    await expect(
      run(
        'sol-spl',
        mainFile(),
        reader({ [c.proposal]: { ...prop, owner: '11111111111111111111111111111111' } }),
      ),
    ).rejects.toThrow(/not owned by the Squads v4 program|owned by/);
    await expect(run('sol-spl', mainFile(), reader({ [c.transaction]: null }))).rejects.toThrow(
      /no longer exists/,
    );
  });

  it('rejects a proposal account that is not the PDA for its own index', async () => {
    const a = fx.cases['sol-spl']!;
    const b = fx.cases['token2022']!;
    // serve proposal B's bytes at proposal A's address
    const read = reader({ [a.proposal]: fx.accounts[b.proposal]! });
    await expect(run('sol-spl', mainFile(), read)).rejects.toThrow(/not the proposal PDA/);
  });
});
