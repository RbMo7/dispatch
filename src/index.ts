import { Connection } from '@solana/web3.js';

import { buildApp } from './app.js';
import { parseSolanaKnownTokens } from './chain-handler/solana/known-tokens.js';
import { SolanaChainHandler } from './chain-handler/solana/solana-chain-handler.js';
import { ChainRegistry, parseEnabledChains, type ChainHandlerLoader } from './chain-registry/chain-registry.js';
import { config } from './config.js';
import { db } from './db/client.js';
import { PostgresDispatchStore } from './repository/postgres-dispatch-store.js';
import { SignerClient } from './signer/client.js';

// Only the chains actually named in ENABLED_CHAINS ever get imported/loaded
// (ADR-0019) — an EVM loader belongs here once EVM's own Chain Handler
// feature exists; naming 'evm' in ENABLED_CHAINS before that fails loudly
// at startup (ChainRegistry.load), not silently.
const loaders: Partial<Record<'solana', ChainHandlerLoader>> = {
  solana: () =>
    Promise.resolve(
      new SolanaChainHandler({
        connection: new Connection(config.solana.rpcUrl, 'confirmed'),
        signerClient: new SignerClient(config.signerUrl),
        senderAddress: config.solana.senderAddress,
        knownTokens: parseSolanaKnownTokens(config.solana.knownTokens),
      }),
    ),
};
const chainRegistry = await ChainRegistry.load(parseEnabledChains(config.enabledChains), loaders);

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
