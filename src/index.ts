import { cachedSenders } from './api/senders.js';
import { setupReader } from './api/setup-routes.js';
import { buildApp } from './app.js';
import {
  loadAssetRegistry,
  loadChainRegistry,
  senderConfigsFor,
  senderReadsFor,
  tokenReadersFor,
} from './chain-loaders.js';
import { config } from './config.js';
import { db } from './db/client.js';
import { PostgresDispatchStore } from './repository/postgres-dispatch-store.js';
import { apiSetupChecks } from './setup/api-checks.js';
import { postgresReads } from './setup/postgres-reads.js';

const store = new PostgresDispatchStore(db);
const assets = await loadAssetRegistry(store);
const chainRegistry = await loadChainRegistry(assets);

// ADR-0060: Dispatches from before named Senders read as their chain's default Sender's.
for (const sender of chainRegistry.senders) {
  if (sender.isDefault && sender.address) {
    await store.assignUnassignedDispatches({ chain: sender.chain, address: sender.address });
  }
}

const app = buildApp({
  store,
  chainRegistry,
  authToken: config.authToken,
  operatorToken: config.operatorToken,
  defaultRetryPolicy: config.defaultRetryPolicy,
  assets,
  readToken: tokenReadersFor(chainRegistry),
  listSenders: cachedSenders(
    await senderConfigsFor(chainRegistry, assets),
    senderReadsFor(chainRegistry, store),
  ),
  readSetup: setupReader({
    enabledChains: [...chainRegistry.handlers.keys()],
    listRecorded: () => store.listSetupChecks(),
    runApiChecks: apiSetupChecks(
      process.env,
      postgresReads(config.databaseUrl, config.rpcTimeoutMs),
    ),
    now: () => new Date(),
  }),
});

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
