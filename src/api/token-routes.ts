import type { FastifyPluginAsync } from 'fastify';

import { type ApiTokens, authedTokenKind, requireToken } from './operator-auth.js';

/**
 * ADR-0057: which token a request carries, so the console can hide the
 * operator pages from an AUTH_TOKEN session without calling an operator
 * route to find out.
 */
export const registerTokenRoutes: FastifyPluginAsync<{ tokens: ApiTokens }> = (app, { tokens }) => {
  app.get('/v1/token', { onRequest: requireToken(tokens) }, (request) => ({
    kind: authedTokenKind(request, tokens),
  }));
  return Promise.resolve();
};
