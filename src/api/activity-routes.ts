import type { FastifyPluginAsync } from 'fastify';

import type { DispatchStore } from '../repository/dispatch-store.js';
import { decodeCursor, DEFAULT_LIST_LIMIT, encodeCursor, MAX_LIST_LIMIT } from './dispatch-list.js';
import { type ApiTokens, requireOperator } from './operator-auth.js';

export type ActivityRouteDeps = { tokens: ApiTokens; store: DispatchStore };

const activityQuerySchema = {
  type: 'object',
  properties: {
    cursor: { type: 'string' },
    limit: { type: 'integer', minimum: 1, maximum: MAX_LIST_LIMIT },
  },
};

/** ADR-0057: `GET /v1/activity`, the operator action record, newest first. */
export const registerActivityRoutes: FastifyPluginAsync<ActivityRouteDeps> = (app, deps) => {
  app.get<{ Querystring: { cursor?: string; limit?: number } }>(
    '/v1/activity',
    { onRequest: requireOperator(deps.tokens), schema: { querystring: activityQuerySchema } },
    async (request, reply) => {
      const { cursor: rawCursor, limit = DEFAULT_LIST_LIMIT } = request.query;
      const after = rawCursor === undefined ? null : decodeCursor(rawCursor);
      if (rawCursor !== undefined && after === null) {
        return reply.code(400).send({ error: 'cursor is not one this API issued' });
      }
      const page = await deps.store.listOperatorActions({ after, limit: limit + 1 });
      const shown = page.slice(0, limit);
      const last = shown.at(-1);
      return reply.send({
        actions: shown.map(({ action }) => ({
          id: action.id,
          at: action.at.toISOString(),
          action: action.action,
          targetId: action.targetId,
          tokenKind: action.tokenKind,
          reason: action.reason,
        })),
        nextCursor: page.length > limit && last ? encodeCursor(last.cursor) : null,
      });
    },
  );
  return Promise.resolve();
};
