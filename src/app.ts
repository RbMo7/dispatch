import Fastify from 'fastify';

import { type DispatchRouteDeps, registerDispatchRoutes } from './api/dispatch-routes.js';
import { registerSenderRoutes } from './api/sender-routes.js';
import type { SenderView } from './api/senders.js';
import { logger } from './logger.js';

export function buildApp(
  deps: DispatchRouteDeps & {
    /** #111: the API process always passes it; a test that never asks for Senders leaves it out. */
    listSenders?: () => Promise<SenderView[]>;
  },
) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', () => ({ status: 'ok' }));
  app.register(registerDispatchRoutes, deps);
  const { listSenders } = deps;
  if (listSenders) app.register(registerSenderRoutes, { authToken: deps.authToken, listSenders });

  return app;
}
