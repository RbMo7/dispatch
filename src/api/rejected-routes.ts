import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import { CHAINS, type Chain } from '../domain/chain.js';
import type { RejectedRequestError } from '../domain/rejected-request.js';
import type { DispatchStore } from '../repository/dispatch-store.js';
import { decodeCursor, DEFAULT_LIST_LIMIT, encodeCursor, MAX_LIST_LIMIT } from './dispatch-list.js';
import { type ApiTokens, requireOperator, tokenKindOf } from './operator-auth.js';

const DAY_MS = 86_400_000;

/** The three shapes a refusal takes (docs/errors.md), as one error with a code where it had one. */
export function rejectionError(status: number, answer: unknown): RejectedRequestError {
  if (typeof answer === 'object' && answer !== null) {
    const { code, message, error, chainDetail } = answer as Record<string, unknown>;
    if (typeof code === 'string' && typeof message === 'string') {
      return { code, message, ...(chainDetail === undefined ? {} : { chainDetail }) };
    }
    if (typeof error === 'string') return { code: null, message: error };
  }
  return { code: null, message: `HTTP ${status}` };
}

function parseAnswer(payload: unknown): unknown {
  if (typeof payload !== 'string') return payload;
  try {
    return JSON.parse(payload);
  } catch {
    return null;
  }
}

/**
 * ADR-0062: an `onSend` hook for `POST /v1/dispatch` that records every 4xx
 * except 401, so an unauthenticated caller can never fill the table. A failed
 * write is logged and never changes the answer.
 */
export function recordRejection(store: DispatchStore, tokens: ApiTokens) {
  return async (request: FastifyRequest, reply: FastifyReply, payload: unknown) => {
    const status = reply.statusCode;
    const tokenKind = tokenKindOf(request, tokens);
    if (status < 400 || status >= 500 || status === 401 || tokenKind === null) return payload;
    const body: unknown = request.body ?? null;
    const named = typeof body === 'object' && body !== null && 'chain' in body ? body.chain : null;
    const key = request.headers['idempotency-key'];
    try {
      await store.recordRejectedRequest({
        status,
        chain: CHAINS.includes(named as Chain) ? (named as Chain) : null,
        idempotencyKey: typeof key === 'string' && key.length > 0 ? key : null,
        tokenKind,
        error: rejectionError(status, parseAnswer(payload)),
        body,
      });
    } catch (cause) {
      request.log.error({ err: cause }, 'could not record a refused request');
    }
    return payload;
  };
}

const rejectedQuerySchema = {
  type: 'object',
  properties: {
    cursor: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
  },
};

export type RejectedRouteDeps = { tokens: ApiTokens; store: DispatchStore };

/** ADR-0062: `GET /v1/rejected`, the refused `POST /v1/dispatch` requests, newest first. */
export const registerRejectedRoutes: FastifyPluginAsync<RejectedRouteDeps> = (app, deps) => {
  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/v1/rejected',
    { onRequest: requireOperator(deps.tokens), schema: { querystring: rejectedQuerySchema } },
    async (request, reply) => {
      const { cursor: rawCursor, limit = DEFAULT_LIST_LIMIT } = request.query;
      const after = rawCursor === undefined ? null : decodeCursor(rawCursor);
      if (rawCursor !== undefined && after === null) {
        return reply.code(400).send({ error: 'cursor is not one this API issued' });
      }
      const [page, last24Hours] = await Promise.all([
        deps.store.listRejectedRequests({ after, limit: limit + 1 }),
        deps.store.countRejectedRequestsSince(new Date(Date.now() - DAY_MS)),
      ]);
      const shown = page.slice(0, limit);
      const last = shown.at(-1);
      return reply.send({
        rejected: shown.map(({ request: r }) => ({
          id: r.id,
          at: r.at.toISOString(),
          status: r.status,
          chain: r.chain,
          idempotencyKey: r.idempotencyKey,
          tokenKind: r.tokenKind,
          ...r.error,
          body: r.body,
        })),
        nextCursor: page.length > limit && last ? encodeCursor(last.cursor) : null,
        last24Hours,
      });
    },
  );
  return Promise.resolve();
};
