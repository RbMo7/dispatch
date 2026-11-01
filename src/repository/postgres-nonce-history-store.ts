import { and, asc, eq, gte, lt } from 'drizzle-orm';

import type { Database } from '../db/client.js';
import { nonceHistory } from '../db/schema.js';
import type { Chain } from '../domain/chain.js';
import type { NonceHistoryRecord, NonceHistoryStore, NonceRange } from './nonce-history-store.js';

type NonceHistoryRow = typeof nonceHistory.$inferSelect;

function toRecord(row: NonceHistoryRow): NonceHistoryRecord {
  return {
    chain: row.chain as Chain,
    senderAddress: row.senderAddress,
    nonce: row.nonce,
    hash: row.hash,
  };
}

/** The real persistence behind NonceHistoryStore (ADR-0008/ADR-0011). */
export class PostgresNonceHistoryStore implements NonceHistoryStore {
  constructor(private readonly db: Database) {}

  async recordNonce(record: NonceHistoryRecord): Promise<void> {
    await this.db
      .insert(nonceHistory)
      .values(record)
      .onConflictDoNothing({
        target: [nonceHistory.chain, nonceHistory.senderAddress, nonceHistory.nonce],
      });
  }

  async listNonceHistory(
    chain: Chain,
    senderAddress: string,
    range?: NonceRange,
  ): Promise<NonceHistoryRecord[]> {
    const rows = await this.db
      .select()
      .from(nonceHistory)
      .where(
        and(
          eq(nonceHistory.chain, chain),
          eq(nonceHistory.senderAddress, senderAddress),
          range ? gte(nonceHistory.nonce, range.from) : undefined,
          range ? lt(nonceHistory.nonce, range.to) : undefined,
        ),
      )
      .orderBy(asc(nonceHistory.nonce));
    return rows.map(toRecord);
  }
}
