import type { FastifyPluginAsync, FastifyReply } from 'fastify';

import type { AssetRegistry } from '../asset-registry/asset-registry.js';
import type { ReadToken, TokenRead } from '../chain-handler/chain-handler.js';
import { CHAINS, type Chain } from '../domain/chain.js';
import {
  parseAssetSymbol,
  symbolKey,
  type KnownAsset,
  type NewKnownAsset,
} from '../domain/known-asset.js';
import { err, ok, type Result } from '../domain/result.js';
import type { DispatchStore } from '../repository/dispatch-store.js';
import {
  type ApiTokens,
  logOperatorAction,
  readReason,
  requireOperator,
  requireToken,
} from './operator-auth.js';
import { isUuid } from './uuid.js';

export type AssetRouteDeps = {
  tokens: ApiTokens;
  store: DispatchStore;
  assets: AssetRegistry;
  /** Each enabled chain's token reads; a chain absent here is not enabled. */
  readToken: Partial<Record<Chain, ReadToken>>;
};

/** A refusal a client can switch on, with words for people. */
type Refusal = { status: 400 | 409 | 503; code: string; message: string };

const NOT_FOUND = { error: 'not found' };

export function toWireAsset(asset: KnownAsset) {
  return {
    id: asset.id,
    chain: asset.chain,
    address: asset.address,
    symbol: asset.symbol,
    name: asset.name,
    decimals: asset.decimals,
    kind: asset.kind,
    source: asset.source,
    enabled: asset.enabled,
    addedBy: asset.addedBy,
    addedAt: asset.addedAt.toISOString(),
  };
}

const REQUEST_FIELDS = ['chain', 'address', 'symbol', 'reason'];

type AssetRequest = { chain: Chain; address: string; symbol: string | null };

function parseAssetRequest(
  raw: unknown,
  readToken: AssetRouteDeps['readToken'],
): Result<AssetRequest, string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('the body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => !REQUEST_FIELDS.includes(key));
  if (unknown !== undefined) return err(`${unknown}: not a field of an asset`);
  const { chain, address, symbol } = body;
  if (!CHAINS.includes(chain as Chain)) return err(`chain: must be one of ${CHAINS.join(', ')}`);
  if (!readToken[chain as Chain])
    return err(`chain: ${String(chain)} is not enabled on this engine`);
  if (typeof address !== 'string' || address.trim() === '') {
    return err('address: must be the mint or contract address');
  }
  if (symbol !== undefined && typeof symbol !== 'string') return err('symbol: must be a string');
  return ok({ chain: chain as Chain, address: address.trim(), symbol: symbol ?? null });
}

/**
 * ADR-0061: what adding `request` would store, read from the chain, or why
 * it can't be added. The chain's symbol is used unless the request gives one.
 */
async function planAsset(
  request: AssetRequest,
  deps: AssetRouteDeps,
): Promise<Result<{ asset: NewKnownAsset; read: TokenRead }, Refusal | string>> {
  const lookup = deps.assets.forChain(request.chain);
  const alreadyKnown = (address: string): Refusal | undefined => {
    const known = lookup.byAddress(address);
    return known
      ? {
          status: 409,
          code: 'ASSET_EXISTS',
          message: `${known.address} is already a Known Asset on ${request.chain}, as ${known.symbol}${known.enabled ? '' : ' (disabled: enable it instead)'}`,
        }
      : undefined;
  };
  const before = alreadyKnown(request.address);
  if (before) return err(before);
  const read = await deps.readToken[request.chain]!(request.address);
  if (!read.ok) {
    const status = read.error.code === 'RPC_UNAVAILABLE' ? 503 : 400;
    return err({ status, ...read.error });
  }
  // The chain's own spelling of the address, which the request may not have used.
  const after = alreadyKnown(read.value.address);
  if (after) return err(after);
  const given = request.symbol ?? read.value.symbol;
  if (given.trim() === '') {
    return err({
      status: 400,
      code: 'SYMBOL_REQUIRED',
      message: `${read.value.address} publishes no symbol on chain: give one in symbol`,
    });
  }
  const symbol = parseAssetSymbol(given);
  if (!symbol.ok) {
    return err(
      request.symbol === null
        ? {
            status: 400,
            code: 'SYMBOL_REQUIRED',
            message: `the chain's symbol ${symbol.error}: give one in symbol`,
          }
        : `symbol: ${symbol.error}`,
    );
  }
  const holder = lookup
    .all()
    .find((asset) => asset.enabled && symbolKey(asset.symbol) === symbolKey(symbol.value));
  if (holder) {
    return err({
      status: 409,
      code: 'SYMBOL_TAKEN',
      message: `${symbol.value} is already ${holder.address === 'native' ? `${request.chain}'s native coin` : `the Known Asset ${holder.address}`} on ${request.chain}: give another symbol in symbol`,
    });
  }
  const { chain, kind, address, decimals, name } = read.value;
  return ok({
    asset: {
      chain,
      kind,
      address,
      decimals,
      symbol: symbol.value,
      name: name || symbol.value,
    } as NewKnownAsset,
    read: read.value,
  });
}

function refuse(reply: FastifyReply, refusal: Refusal | string) {
  return typeof refusal === 'string'
    ? reply.code(400).send({ error: refusal })
    : reply.code(refusal.status).send({ code: refusal.code, message: refusal.message });
}

/** ADR-0061: read with either token; preview, add, enable and disable with OPERATOR_TOKEN (ADR-0057). */
export const registerAssetRoutes: FastifyPluginAsync<AssetRouteDeps> = (app, deps) => {
  const { store, tokens, assets } = deps;
  const write = requireOperator(tokens);

  app.get<{ Querystring: { chain?: string } }>(
    '/v1/assets',
    { onRequest: requireToken(tokens) },
    async (request, reply) => {
      const { chain } = request.query;
      if (chain !== undefined && !CHAINS.includes(chain as Chain)) {
        return reply.code(400).send({ error: `chain: must be one of ${CHAINS.join(', ')}` });
      }
      return { assets: assets.list(chain as Chain | undefined).map(toWireAsset) };
    },
  );

  app.post('/v1/assets/preview', { onRequest: write }, async (request, reply) => {
    const parsed = parseAssetRequest(request.body, deps.readToken);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const planned = await planAsset(parsed.value, deps);
    if (!planned.ok) return refuse(reply, planned.error);
    const { asset, read } = planned.value;
    return {
      ...asset,
      onChain: { symbol: read.symbol, name: read.name },
      supply: read.supply,
    };
  });

  app.post('/v1/assets', { onRequest: write }, async (request, reply) => {
    const parsed = parseAssetRequest(request.body, deps.readToken);
    if (!parsed.ok) return reply.code(400).send({ error: parsed.error });
    const reason = readReason(request.body);
    if (!reason.ok) return reply.code(400).send({ error: reason.error });
    const planned = await planAsset(parsed.value, deps);
    if (!planned.ok) return refuse(reply, planned.error);
    const actor = { tokenKind: 'operator' as const, reason: reason.value };
    const added = await store.addKnownAsset(planned.value.asset, actor);
    // The registry was read before the write; another writer got there first.
    if (added === 'address_taken' || added === 'symbol_taken') {
      await assets.refresh();
      return refuse(reply, {
        status: 409,
        code: added === 'address_taken' ? 'ASSET_EXISTS' : 'SYMBOL_TAKEN',
        message: `${added === 'address_taken' ? planned.value.asset.address : planned.value.asset.symbol} was added on ${parsed.value.chain} while this request ran`,
      });
    }
    await assets.refresh();
    logOperatorAction(request, 'asset_add', added.id, actor);
    return reply.code(201).send(toWireAsset(added));
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/assets/:id',
    { onRequest: write },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send(NOT_FOUND);
      const body = request.body as Record<string, unknown> | null | undefined;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reply.code(400).send({ error: 'the body must be a JSON object' });
      }
      const { enabled } = body;
      const unknown = Object.keys(body).find((key) => key !== 'enabled' && key !== 'reason');
      if (unknown !== undefined) {
        return reply.code(400).send({ error: `${unknown}: only enabled can be changed` });
      }
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled: must be true or false' });
      }
      const reason = readReason(body);
      if (!reason.ok) return reply.code(400).send({ error: reason.error });
      const actor = { tokenKind: 'operator' as const, reason: reason.value };
      const outcome = await store.setKnownAssetEnabled(request.params.id, enabled, actor);
      if (outcome === 'not_found') return reply.code(404).send(NOT_FOUND);
      if (outcome === 'config_row') {
        return refuse(reply, {
          status: 409,
          code: 'CONFIG_ASSET',
          message:
            'this asset comes from the configuration (SOLANA_KNOWN_TOKENS, BASE_KNOWN_TOKENS or the native coin): change it there and restart',
        });
      }
      if (outcome === 'symbol_taken') {
        return refuse(reply, {
          status: 409,
          code: 'SYMBOL_TAKEN',
          message: 'another enabled asset on this chain has its symbol: disable that one first',
        });
      }
      await assets.refresh();
      if (outcome.changed) {
        logOperatorAction(
          request,
          enabled ? 'asset_enable' : 'asset_disable',
          outcome.asset.id,
          actor,
        );
      }
      return toWireAsset(outcome.asset);
    },
  );

  return Promise.resolve();
};
