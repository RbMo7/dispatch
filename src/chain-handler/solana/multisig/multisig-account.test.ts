import { Keypair, PublicKey } from '@solana/web3.js';
import { describe, expect, it, vi } from 'vitest';

import fixture from './devnet-multisig-fixture.json' with { type: 'json' };
import {
  decodeMultisigAccount,
  MULTISIG_DISCRIMINATOR,
  MULTISIG_READ_COMMITMENT,
  readMultisigState,
  type MultisigAccount,
} from './multisig-account.js';

const REAL = Buffer.from(fixture.dataBase64, 'base64');

/** Builds Multisig account bytes the way the program lays them out, for cases the devnet fixture does not cover. */
function encode(account: Omit<MultisigAccount, 'createKey' | 'configAuthority'>): Buffer {
  const key = (value: string) => new PublicKey(value).toBuffer();
  const head = Buffer.alloc(2 + 4 + 8 + 8);
  head.writeUInt16LE(account.threshold, 0);
  head.writeUInt32LE(account.timeLockSeconds, 2);
  head.writeBigUInt64LE(account.transactionIndex, 6);
  head.writeBigUInt64LE(account.staleTransactionIndex, 14);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(account.members.length);
  return Buffer.concat([
    MULTISIG_DISCRIMINATOR,
    key(Keypair.generate().publicKey.toBase58()),
    key(PublicKey.default.toBase58()),
    head,
    account.rentCollector
      ? Buffer.concat([Buffer.from([1]), key(account.rentCollector)])
      : Buffer.from([0]),
    Buffer.from([254]),
    count,
    ...account.members.map((m) => Buffer.concat([key(m.key), Buffer.from([m.permissions])])),
    Buffer.alloc(40), // room the program allocates for more members
  ]);
}

describe('decodeMultisigAccount', () => {
  it('decodes a real devnet 2-of-3 Squads multisig (fixture bytes read from the chain)', () => {
    const decoded = decodeMultisigAccount(REAL);
    expect(new PublicKey(decoded.createKey).toBase58()).toBe(decoded.createKey);
    expect({ ...decoded, createKey: '' }).toEqual({
      createKey: '',
      configAuthority: PublicKey.default.toBase58(),
      threshold: 2,
      timeLockSeconds: 0,
      transactionIndex: 0n,
      staleTransactionIndex: 0n,
      rentCollector: fixture.member,
      // Squads keeps members sorted by key; compare as sets.
      members: decoded.members,
    });
    expect([...decoded.members].sort((a, b) => a.key.localeCompare(b.key))).toEqual(
      [
        { key: fixture.member, permissions: 5 },
        { key: fixture.v1, permissions: 7 },
        { key: fixture.v2, permissions: 7 },
      ].sort((a, b) => a.key.localeCompare(b.key)),
    );
  });

  it('uses the Anchor discriminator the program writes', () => {
    expect(REAL.subarray(0, 8).toString('hex')).toBe(MULTISIG_DISCRIMINATOR.toString('hex'));
    expect(MULTISIG_DISCRIMINATOR.toString('hex')).toBe('e07479ba44a14fec');
  });

  it('reads an unset rent collector, a time lock and the indexes, and ignores trailing space', () => {
    const member = Keypair.generate().publicKey.toBase58();
    const decoded = decodeMultisigAccount(
      encode({
        threshold: 1,
        timeLockSeconds: 86_400,
        transactionIndex: 12n,
        staleTransactionIndex: 4n,
        rentCollector: undefined,
        members: [{ key: member, permissions: 5 }],
      }),
    );
    expect(decoded).toMatchObject({
      threshold: 1,
      timeLockSeconds: 86_400,
      transactionIndex: 12n,
      staleTransactionIndex: 4n,
      rentCollector: undefined,
      members: [{ key: member, permissions: 5 }],
    });
  });

  it('throws on another account type, on truncated bytes and on a bad option tag', () => {
    expect(() => decodeMultisigAccount(Buffer.alloc(300))).toThrow(/wrong discriminator/);
    expect(() => decodeMultisigAccount(REAL.subarray(0, 100))).toThrow(/truncated/);
    expect(() => decodeMultisigAccount(REAL.subarray(0, REAL.length - 80))).toThrow(/truncated/);
    const badTag = Buffer.from(REAL);
    badTag[8 + 64 + 22] = 7;
    expect(() => decodeMultisigAccount(badTag)).toThrow(/bad rentCollector tag/);
  });
});

describe('readMultisigState', () => {
  const owner = new PublicKey(fixture.owner);

  it('reads at one pinned commitment and reports the slot', async () => {
    const getAccountInfoAndContext = vi.fn().mockResolvedValue({
      context: { slot: 77 },
      value: { owner, data: REAL, lamports: 1, executable: false },
    });
    const state = await readMultisigState({ getAccountInfoAndContext }, fixture.multisig);
    expect(getAccountInfoAndContext).toHaveBeenCalledWith(
      new PublicKey(fixture.multisig),
      MULTISIG_READ_COMMITMENT,
    );
    expect(MULTISIG_READ_COMMITMENT).toBe('confirmed');
    expect(state).toMatchObject({
      slot: 77,
      account: { owner: fixture.owner, multisig: { threshold: 2 } },
    });
  });

  it('reports a missing account, and bytes that are not a Multisig as data, not a throw', async () => {
    const missing = await readMultisigState(
      { getAccountInfoAndContext: () => Promise.resolve({ context: { slot: 1 }, value: null }) },
      fixture.multisig,
    );
    expect(missing).toEqual({ slot: 1, account: undefined });

    const junk = await readMultisigState(
      {
        getAccountInfoAndContext: () =>
          Promise.resolve({
            context: { slot: 2 },
            value: { owner, data: Buffer.alloc(40), lamports: 1, executable: false },
          }),
      },
      fixture.multisig,
    );
    expect(junk.account?.owner).toBe(fixture.owner);
    expect(JSON.stringify(junk.account?.multisig)).toMatch(/undecodable.*discriminator/);
  });
});
