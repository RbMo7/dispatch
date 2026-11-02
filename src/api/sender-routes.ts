import type { FastifyPluginAsync } from 'fastify';

import { type ApiTokens, requireToken } from './operator-auth.js';
import type { SenderView } from './senders.js';

export type SenderRouteDeps = {
  tokens: ApiTokens;
  listSenders: () => Promise<SenderView[]>;
};

export const registerSenderRoutes: FastifyPluginAsync<SenderRouteDeps> = (app, deps) => {
  app.get('/v1/senders', { onRequest: requireToken(deps.tokens) }, async () => ({
    senders: await deps.listSenders(),
  }));
  return Promise.resolve();
};
