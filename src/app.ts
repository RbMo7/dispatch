import Fastify from 'fastify';

import { registerActivityRoutes } from './api/activity-routes.js';
import { type AssetRouteDeps, registerAssetRoutes } from './api/asset-routes.js';
import { type DispatchRouteDeps, registerDispatchRoutes } from './api/dispatch-routes.js';
import { registerFlagRuleRoutes } from './api/flag-rule-routes.js';
import { parseApiTokens } from './api/operator-auth.js';
import { registerRejectedRoutes } from './api/rejected-routes.js';
import { registerSenderRoutes, type SenderRouteDeps } from './api/sender-routes.js';
import { registerSetupRoutes, type SetupRouteDeps } from './api/setup-routes.js';
import { registerTokenRoutes } from './api/token-routes.js';
import { logger } from './logger.js';
import { webStatic } from './web-static.js';

export type AppDeps = Omit<DispatchRouteDeps, 'tokens' | 'assetDecimals' | 'assetAt'> &
  Pick<AssetRouteDeps, 'assets' | 'readToken'> &
  Pick<SenderRouteDeps, 'listSenders'> &
  Pick<SetupRouteDeps, 'readSetup'> & {
    /** Operator-configured shared secret (ADR-0022). */
    authToken: string;
    /** ADR-0057: optional; unset turns the operator-only routes off. */
    operatorToken?: string | undefined;
  };

/** Throws, so the engine refuses to start, when OPERATOR_TOKEN is empty or equals AUTH_TOKEN. */
export function buildApp({ authToken, operatorToken, assets, readToken, ...deps }: AppDeps) {
  const tokens = parseApiTokens(authToken, operatorToken);
  const app = Fastify({ loggerInstance: logger });

  app.get('/health', () => ({ status: 'ok' }));
  app.register(registerDispatchRoutes, {
    ...deps,
    tokens,
    assetDecimals: assets.decimalsOf,
    assetAt: (chain, address) => assets.forChain(chain).byAddress(address),
  });
  app.register(registerSenderRoutes, { tokens, listSenders: deps.listSenders });
  app.register(registerSetupRoutes, { tokens, readSetup: deps.readSetup });
  app.register(registerActivityRoutes, { tokens, store: deps.store });
  app.register(registerRejectedRoutes, { tokens, store: deps.store });
  app.register(registerTokenRoutes, { tokens });
  app.register(registerFlagRuleRoutes, {
    tokens,
    store: deps.store,
    assetDecimals: assets.decimalsOf,
    senders: deps.chainRegistry,
  });
  app.register(registerAssetRoutes, { tokens, store: deps.store, assets, readToken });
  app.register(webStatic);

  return app;
}
