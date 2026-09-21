import { logger } from './logger.js';

logger.info('worker starting (no business logic yet)');

const heartbeat = setInterval(() => {
  logger.debug('worker heartbeat');
}, 30_000);

function shutdown(signal: string): void {
  logger.info({ signal }, 'worker shutting down');
  clearInterval(heartbeat);
  process.exit(0);
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

logger.info('worker started');
