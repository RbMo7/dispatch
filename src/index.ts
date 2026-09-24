import { buildApp } from './app.js';
import { loadChainRegistry } from './chain-loaders.js';
import { config } from './config.js';
import { db } from './db/client.js';
import { PostgresDispatchStore } from './repository/postgres-dispatch-store.js';

const chainRegistry = await loadChainRegistry();

const app = buildApp({
  store: new PostgresDispatchStore(db),
  chainRegistry,
  authToken: config.authToken,
  defaultRetryPolicy: config.defaultRetryPolicy,
});

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
