import { buildApp } from './app.js';
import { ChainRegistry, parseEnabledChains } from './chain-registry/chain-registry.js';
import { config } from './config.js';
import { db } from './db/client.js';
import { PostgresDispatchStore } from './repository/postgres-dispatch-store.js';

// No real Chain Handler loaders exist yet (core-engine-scaffold builds only
// the interface/registry/stub) — ENABLED_CHAINS naming any chain will fail
// at startup until the first real one (Solana) is registered here.
const chainRegistry = await ChainRegistry.load(parseEnabledChains(config.enabledChains), {});

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
