import { describe, expect, it } from 'vitest';

import { InMemoryNonceHistoryStore } from './in-memory-nonce-history-store.js';

describe('InMemoryNonceHistoryStore', () => {
  it('records and lists a Sender’s nonce history, ascending by nonce', async () => {
    const store = new InMemoryNonceHistoryStore();

    await store.recordNonce({ chain: 'base', senderAddress: '0xsender', nonce: 1, hash: '0xhash1' });
    await store.recordNonce({ chain: 'base', senderAddress: '0xsender', nonce: 0, hash: '0xhash0' });

    expect(await store.listNonceHistory('base', '0xsender')).toEqual([
      { chain: 'base', senderAddress: '0xsender', nonce: 0, hash: '0xhash0' },
      { chain: 'base', senderAddress: '0xsender', nonce: 1, hash: '0xhash1' },
    ]);
  });

  it('keeps different Senders’ histories separate', async () => {
    const store = new InMemoryNonceHistoryStore();

    await store.recordNonce({ chain: 'base', senderAddress: '0xa', nonce: 0, hash: '0xhash-a' });
    await store.recordNonce({ chain: 'base', senderAddress: '0xb', nonce: 0, hash: '0xhash-b' });

    expect(await store.listNonceHistory('base', '0xa')).toEqual([
      { chain: 'base', senderAddress: '0xa', nonce: 0, hash: '0xhash-a' },
    ]);
  });

  it('recording the same (chain, senderAddress, nonce) again is a no-op, keeping the first hash', async () => {
    const store = new InMemoryNonceHistoryStore();

    await store.recordNonce({ chain: 'base', senderAddress: '0xsender', nonce: 0, hash: '0xoriginal' });
    await store.recordNonce({ chain: 'base', senderAddress: '0xsender', nonce: 0, hash: '0xreplacement' });

    expect(await store.listNonceHistory('base', '0xsender')).toEqual([
      { chain: 'base', senderAddress: '0xsender', nonce: 0, hash: '0xoriginal' },
    ]);
  });

  it('returns an empty list for a Sender with no recorded history', async () => {
    const store = new InMemoryNonceHistoryStore();
    expect(await store.listNonceHistory('base', '0xnever-broadcast')).toEqual([]);
  });
});
