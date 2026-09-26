import type { Chain } from '../domain/chain.js';
import type { NonceHistoryRecord, NonceHistoryStore } from './nonce-history-store.js';

function key(chain: Chain, senderAddress: string, nonce: number): string {
  return `${chain}\u0000${senderAddress}\u0000${nonce}`;
}

/** The fake ADR-0011 calls for: same interface as PostgresNonceHistoryStore, no I/O. */
export class InMemoryNonceHistoryStore implements NonceHistoryStore {
  private readonly records = new Map<string, NonceHistoryRecord>();

  recordNonce(record: NonceHistoryRecord): Promise<void> {
    const existingKey = key(record.chain, record.senderAddress, record.nonce);
    if (!this.records.has(existingKey)) this.records.set(existingKey, record);
    return Promise.resolve();
  }

  listNonceHistory(chain: Chain, senderAddress: string): Promise<NonceHistoryRecord[]> {
    const matches = [...this.records.values()]
      .filter((record) => record.chain === chain && record.senderAddress === senderAddress)
      .sort((a, b) => a.nonce - b.nonce);
    return Promise.resolve(matches);
  }

  highestNonce(chain: Chain, senderAddress: string): Promise<number | null> {
    const nonces = [...this.records.values()]
      .filter((r) => r.chain === chain && r.senderAddress === senderAddress)
      .map((r) => r.nonce);
    return Promise.resolve(nonces.length ? Math.max(...nonces) : null);
  }

  forgetNonce(chain: Chain, senderAddress: string, nonce: number): Promise<void> {
    this.records.delete(key(chain, senderAddress, nonce));
    return Promise.resolve();
  }
}
