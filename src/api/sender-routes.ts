import type { FastifyPluginAsync } from 'fastify';

import { checkAuth } from './dispatch-routes.js';
import type { SenderView } from './senders.js';

export type SenderRouteDeps = {
  authToken: string;
  listSenders: () => Promise<SenderView[]>;
};

/** #111: `GET /v1/senders`, one entry per enabled chain. The browser never reaches the Signer or an RPC itself. */
export const registerSenderRoutes: FastifyPluginAsync<SenderRouteDeps> = (app, deps) => {
  app.get('/v1/senders', { preHandler: checkAuth(deps.authToken) }, async () => ({
    senders: await deps.listSenders(),
  }));
  return Promise.resolve();
};
