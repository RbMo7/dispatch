import Fastify from 'fastify';

import { type DispatchRouteDeps, registerDispatchRoutes } from './api/dispatch-routes.js';
import { logger } from './logger.js';

export function buildApp(deps: DispatchRouteDeps) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', () => ({ status: 'ok' }));
  app.register(registerDispatchRoutes, deps);

  return app;
}
