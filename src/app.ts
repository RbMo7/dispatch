import Fastify from 'fastify';

import { logger } from './logger.js';

export function buildApp() {
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', () => ({ status: 'ok' }));

  return app;
}
