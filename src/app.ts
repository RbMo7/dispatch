import Fastify from 'fastify';

import { type DispatchRouteDeps, registerDispatchRoutes } from './api/dispatch-routes.js';
import { registerSenderRoutes, type SenderRouteDeps } from './api/sender-routes.js';
import { logger } from './logger.js';

export function buildApp(deps: DispatchRouteDeps & Pick<SenderRouteDeps, 'listSenders'>) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', () => ({ status: 'ok' }));
  app.register(registerDispatchRoutes, deps);
  app.register(registerSenderRoutes, { authToken: deps.authToken, listSenders: deps.listSenders });

  return app;
}
