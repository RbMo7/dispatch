import { cachedSenders } from './api/senders.js';
import { buildApp } from './app.js';
import {
  assetDecimalsFromConfig,
  loadChainRegistry,
  senderConfigsFor,
  senderReadsFor,
} from './chain-loaders.js';
import { config } from './config.js';
import { db } from './db/client.js';
import { PostgresDispatchStore } from './repository/postgres-dispatch-store.js';

const chainRegistry = await loadChainRegistry();
const assetDecimals = assetDecimalsFromConfig();
const store = new PostgresDispatchStore(db);

const app = buildApp({
  store,
  chainRegistry,
  authToken: config.authToken,
  operatorToken: config.operatorToken,
  defaultRetryPolicy: config.defaultRetryPolicy,
  assetDecimals,
  listSenders: cachedSenders(
    senderConfigsFor(chainRegistry, assetDecimals),
    senderReadsFor(chainRegistry, store),
  ),
});

app.listen({ port: config.port, host: '0.0.0.0' }).catch((err: unknown) => {
  app.log.error(err);
  process.exit(1);
});
