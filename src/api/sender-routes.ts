import type { FastifyPluginAsync } from 'fastify';

import { checkAuth } from './dispatch-routes.js';
import type { SenderView } from './senders.js';

export type SenderRouteDeps = {
  authToken: string;
  listSenders: () => Promise<SenderView[]>;
};

export const registerSenderRoutes: FastifyPluginAsync<SenderRouteDeps> = (app, deps) => {
  app.get('/v1/senders', { onRequest: checkAuth(deps.authToken) }, async () => ({
    senders: await deps.listSenders(),
  }));
  return Promise.resolve();
};
