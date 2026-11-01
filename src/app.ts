import Fastify from 'fastify';

import { type DispatchRouteDeps, registerDispatchRoutes } from './api/dispatch-routes.js';
import { registerSenderRoutes, type SenderRouteDeps } from './api/sender-routes.js';
import { registerSetupRoutes, type SetupRouteDeps } from './api/setup-routes.js';
import { logger } from './logger.js';
import { webStatic } from './web-static.js';

export function buildApp(
  deps: DispatchRouteDeps &
    Pick<SenderRouteDeps, 'listSenders'> &
    Pick<SetupRouteDeps, 'readSetup'>,
) {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', () => ({ status: 'ok' }));
  app.register(registerDispatchRoutes, deps);
  app.register(registerSenderRoutes, { authToken: deps.authToken, listSenders: deps.listSenders });
  app.register(registerSetupRoutes, { authToken: deps.authToken, readSetup: deps.readSetup });
  app.register(webStatic);

  return app;
}
