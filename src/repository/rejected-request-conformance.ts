import { describe, expect, it } from 'vitest';

import type { NewRejectedRequest } from '../domain/rejected-request.js';
import type { DispatchStore } from './dispatch-store.js';

const unknownAsset = (key: string): NewRejectedRequest => ({
  status: 400,
  chain: 'base',
  idempotencyKey: key,
  tokenKind: 'auth',
  error: {
    code: 'UNKNOWN_ASSET',
    message: 'no known token configured for asset "DAI"',
    chainDetail: { asset: 'DAI' },
  },
  body: {
    chain: 'base',
    items: [
      {
        type: 'payment',
        recipient: '0x8ba1f109551bD432803012645Ac136ddd64DBA72',
        asset: 'DAI',
        amount: '1000000000000000000',
      },
    ],
  },
});

const notJson: NewRejectedRequest = {
  status: 400,
  chain: null,
  idempotencyKey: null,
  tokenKind: 'operator',
  error: { code: 'FST_ERR_CTP_INVALID_JSON_BODY', message: 'Body is not valid JSON' },
  body: null,
};

const HOUR = 3_600_000;

/** ADR-0062: the refused-request record, the same against both stores. */
export function runRejectedRequestConformanceSuite(makeStore: () => DispatchStore): void {
  describe('refused requests (ADR-0062)', () => {
    it('keeps what was refused, body included, and lists it newest first', async () => {
      const store = makeStore();
      await store.recordRejectedRequest(unknownAsset('first'));
      await store.recordRejectedRequest(notJson);

      const listed = await store.listRejectedRequests({ after: null, limit: 10 });

      expect(listed.map((l) => l.request)).toEqual([
        { ...notJson, id: expect.any(String) as string, at: expect.any(Date) as Date },
        {
          ...unknownAsset('first'),
          id: expect.any(String) as string,
          at: expect.any(Date) as Date,
        },
      ]);
    });

    it('pages on the cursor without repeating or skipping a record', async () => {
      const store = makeStore();
      for (const key of ['a', 'b', 'c']) await store.recordRejectedRequest(unknownAsset(key));

      const first = await store.listRejectedRequests({ after: null, limit: 2 });
      const rest = await store.listRejectedRequests({ after: first.at(-1)!.cursor, limit: 2 });

      expect([...first, ...rest].map((l) => l.request.idempotencyKey)).toEqual(['c', 'b', 'a']);
    });

    it('counts the records since a time', async () => {
      const store = makeStore();
      await store.recordRejectedRequest(unknownAsset('a'));
      await store.recordRejectedRequest(unknownAsset('b'));

      expect(await store.countRejectedRequestsSince(new Date(Date.now() - HOUR))).toBe(2);
      expect(await store.countRejectedRequestsSince(new Date(Date.now() + HOUR))).toBe(0);
    });

    it('drops every record older than the retention', async () => {
      const store = makeStore();
      await store.recordRejectedRequest(unknownAsset('a'));
      await store.recordRejectedRequest(unknownAsset('b'));

      expect(await store.pruneRejectedRequests(new Date(Date.now() - HOUR), 10)).toBe(0);
      expect(await store.pruneRejectedRequests(new Date(Date.now() + HOUR), 10)).toBe(2);
      expect(await store.listRejectedRequests({ after: null, limit: 10 })).toEqual([]);
    });

    it('keeps only the newest records over the cap', async () => {
      const store = makeStore();
      for (const key of ['a', 'b', 'c', 'd']) await store.recordRejectedRequest(unknownAsset(key));

      expect(await store.pruneRejectedRequests(new Date(Date.now() - HOUR), 2)).toBe(2);

      const kept = await store.listRejectedRequests({ after: null, limit: 10 });
      expect(kept.map((l) => l.request.idempotencyKey)).toEqual(['d', 'c']);
    });
  });
}
