import { sql } from 'drizzle-orm';
import { beforeEach, describe, expect, it } from 'vitest';

import { db } from '../db/client.js';
import { nonceHistory } from '../db/schema.js';
import { PostgresNonceHistoryStore } from './postgres-nonce-history-store.js';

/** ADR-0034: exercised against a real local Postgres, mirroring PostgresDispatchStore's own test tier. */
describe('PostgresNonceHistoryStore (real Postgres)', () => {
  let store: PostgresNonceHistoryStore;

  beforeEach(async () => {
    store = new PostgresNonceHistoryStore(db);
    await db.execute(sql`TRUNCATE TABLE ${nonceHistory} RESTART IDENTITY CASCADE`);
  });

  it('persists and lists a Sender’s nonce history, ascending by nonce', async () => {
    await store.recordNonce({
      chain: 'base',
      senderAddress: '0xsender',
      nonce: 1,
      hash: '0xhash1',
    });
    await store.recordNonce({
      chain: 'base',
      senderAddress: '0xsender',
      nonce: 0,
      hash: '0xhash0',
    });

    expect(await store.listNonceHistory('base', '0xsender')).toEqual([
      { chain: 'base', senderAddress: '0xsender', nonce: 0, hash: '0xhash0' },
      { chain: 'base', senderAddress: '0xsender', nonce: 1, hash: '0xhash1' },
    ]);
  });

  it('the real unique index makes recordNonce a no-op for an already-recorded (chain, sender, nonce)', async () => {
    await store.recordNonce({
      chain: 'base',
      senderAddress: '0xsender',
      nonce: 0,
      hash: '0xoriginal',
    });
    await store.recordNonce({
      chain: 'base',
      senderAddress: '0xsender',
      nonce: 0,
      hash: '0xreplacement',
    });

    expect(await store.listNonceHistory('base', '0xsender')).toEqual([
      { chain: 'base', senderAddress: '0xsender', nonce: 0, hash: '0xoriginal' },
    ]);
  });

  it('keeps different Senders’ histories separate', async () => {
    await store.recordNonce({ chain: 'base', senderAddress: '0xa', nonce: 0, hash: '0xhash-a' });
    await store.recordNonce({ chain: 'base', senderAddress: '0xb', nonce: 0, hash: '0xhash-b' });

    expect(await store.listNonceHistory('base', '0xa')).toEqual([
      { chain: 'base', senderAddress: '0xa', nonce: 0, hash: '0xhash-a' },
    ]);
  });

  it('highestNonce reports the highest recorded nonce, and forgetNonce removes a released one (#20)', async () => {
    
    const sender = `0xsender-${Math.random()}`;
    expect(await store.highestNonce('base', sender)).toBeNull();
    await store.recordNonce({ chain: 'base', senderAddress: sender, nonce: 4, hash: '0xa' });
    await store.recordNonce({ chain: 'base', senderAddress: sender, nonce: 7, hash: '0xb' });
    expect(await store.highestNonce('base', sender)).toBe(7);

    await store.forgetNonce('base', sender, 7);

    expect(await store.highestNonce('base', sender)).toBe(4);
    // A forgotten nonce can be recorded afresh — the reused nonce's new hash wins.
    await store.recordNonce({ chain: 'base', senderAddress: sender, nonce: 7, hash: '0xc' });
    expect((await store.listNonceHistory('base', sender)).map((r) => r.hash)).toEqual(['0xa', '0xc']);
  });
});
