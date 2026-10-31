import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { ChainRegistry } from '../chain-registry/chain-registry.js';
import type {
  BulkCallPlan,
  BulkCallRequest,
  ChainHandler,
} from '../chain-handler/chain-handler.js';
import type { Call, DispatchItem, Payment } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import type { DispatchStore } from '../repository/dispatch-store.js';
import {
  listDispatchPage,
  listQuerySchema,
  parseListQuery,
  type RawListQuery,
} from './dispatch-list.js';
import { readDispatchView } from './dispatch-view.js';
import { isUuid } from './uuid.js';

export type DispatchRouteDeps = {
  store: DispatchStore;
  chainRegistry: ChainRegistry;
  /** Operator-configured shared secret (ADR-0022). */
  authToken: string;
  /** Applied when a request omits its own `retryPolicy` (ADR-0003). */
  defaultRetryPolicy: boolean;
};

type RouteError = { status: number; body: Record<string, unknown> };

function invalidRequest(message: string): RouteError {
  return { status: 400, body: { error: message } };
}

const postDispatchSchema = {
  body: {
    type: 'object',
    required: ['chain'],
    additionalProperties: false,
    properties: {
      chain: { type: 'string', enum: ['base', 'solana'] },
      /** ADR-0031: defaults to 'managed' when omitted, so every existing caller keeps working unchanged. */
      mode: { type: 'string', enum: ['managed', 'relay'] },
      retryPolicy: { type: 'boolean' },
      items: {
        type: 'array',
        items: {
          type: 'object',
          required: ['type'],
          properties: { type: { type: 'string' } },
          additionalProperties: true,
        },
      },
      signedTransaction: { type: 'string' },
      /** #11 (ADR-0038): opt into Bulk Call through this caller-named aggregator. */
      bulkCall: {
        type: 'object',
        required: ['aggregator'],
        additionalProperties: false,
        properties: {
          aggregator: { type: 'string', minLength: 1 },
          maxBatchSize: { type: 'integer', minimum: 1 },
          allowFailure: { type: 'boolean' },
        },
      },
    },
  },
};

type PostDispatchBody = {
  chain: Chain;
  mode?: 'managed' | 'relay';
  retryPolicy?: boolean;
  items?: Record<string, unknown>[];
  signedTransaction?: string;
  bulkCall?: BulkCallRequest;
};

const INTEGER_STRING = /^\d+$/;

/**
 * Turns one wire item into a DispatchItem — a `payment` item is translated
 * via the Chain Handler's `paymentToCall` (ADR-0028), with the original
 * Payment kept alongside the resulting Call so the Funding Check (ADR-0024)
 * can aggregate required funds later without decoding an opaque Call. A
 * `call` item's fields beyond `type` are already chain-shaped and
 * caller-owned (ADR-0018): they pass through untouched and carry no
 * Payment, but get the Chain Handler's cheap `validateCall` here, so a
 * malformed one is a 400 now rather than a failed item later.
 */
async function translateItem(
  handler: ChainHandler,
  raw: Record<string, unknown>,
  index: number,
): Promise<Result<DispatchItem, RouteError>> {
  const { type, ...rest } = raw;

  if (type === 'payment') {
    const { recipient, asset, amount } = rest;
    if (typeof recipient !== 'string' || typeof asset !== 'string' || typeof amount !== 'string') {
      return err(
        invalidRequest(
          `items[${index}]: a payment item requires string recipient, asset, and amount`,
        ),
      );
    }
    if (!INTEGER_STRING.test(amount)) {
      return err(invalidRequest(`items[${index}]: amount must be a non-negative integer string`));
    }
    const payment: Payment = { recipient, asset, amount };
    const translated = await handler.paymentToCall(payment);
    if (!translated.ok) return err({ status: 400, body: translated.error });
    return ok({ call: translated.value, payment });
  }

  if (type === 'call') {
    const call = rest as Call;
    const valid = await handler.validateCall(call);
    if (!valid.ok) return err({ status: 400, body: valid.error });
    return ok({ call, payment: null });
  }

  return err(
    invalidRequest(
      `items[${index}]: unknown item type "${String(type)}" — must be "payment" or "call"`,
    ),
  );
}

export function checkAuth(authToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

/** `POST /v1/dispatch`, `GET /v1/dispatch/:id` and its cancel, against the wire format pinned in docs/api.md (issue 08). */
export const registerDispatchRoutes: FastifyPluginAsync<DispatchRouteDeps> = (app, deps) => {
  const { store, chainRegistry, authToken, defaultRetryPolicy } = deps;
  const auth = checkAuth(authToken);

  app.post<{ Body: PostDispatchBody }>(
    '/v1/dispatch',
    { schema: postDispatchSchema, onRequest: auth },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return reply.code(400).send({ error: 'Idempotency-Key header is required' });
      }

      const { chain, mode } = request.body;

      const registryResult = chainRegistry.get(chain);
      if (!registryResult.ok) {
        return reply.code(400).send(registryResult.error satisfies DispatchError);
      }
      const handler = registryResult.value;

      if ((mode ?? 'managed') === 'relay') {
        const { signedTransaction, items, retryPolicy, bulkCall } = request.body;
        if (typeof signedTransaction !== 'string' || signedTransaction.length === 0) {
          return reply
            .code(400)
            .send({ error: 'a relay dispatch requires a string signedTransaction' });
        }
        if (items !== undefined || retryPolicy !== undefined || bulkCall !== undefined) {
          return reply.code(400).send({
            error:
              'a relay dispatch accepts only chain and signedTransaction — no items, no retryPolicy, no bulkCall',
          });
        }

        // ADR-0032: cheap, RPC-free validation before ever persisting —
        // a malformed submission gets 400 immediately, never a queued row
        // that only fails later at broadcast.
        const validation = await handler.validateSignedTransaction(signedTransaction);
        if (!validation.ok) {
          return reply.code(400).send(validation.error satisfies DispatchError);
        }

        const relayDispatch = await store.createRelayDispatch({
          chain,
          idempotencyKey,
          signedTransaction,
        });

        return reply.code(202).send({ dispatchId: relayDispatch.id, status: relayDispatch.status });
      }

      const { items, retryPolicy, bulkCall } = request.body;
      if (!Array.isArray(items) || items.length === 0) {
        return reply.code(400).send({ error: 'items must be a non-empty array' });
      }

      const translated: DispatchItem[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        const result = await translateItem(handler, item, i);
        if (!result.ok) {
          return reply.code(result.error.status).send(result.error.body);
        }
        translated.push(result.value);
      }

      // #94 (ADR-0054): a Multisig Sender only proposes transfers it can describe. The claim-time
      // `planBundles` stays as the safety net, but there it fails every Call of the Dispatch, after
      // the caller already holds a 202 — so ask the same pure planner about each item here.
      if (handler.approval) {
        if (bulkCall !== undefined) {
          return reply.code(400).send({
            code: 'CHAIN_REJECTED',
            message: `chain ${chain} is in multisig mode, which has no Bulk Call mode: every transfer is its own item in a Proposal`,
          } satisfies DispatchError);
        }
        for (let i = 0; i < translated.length; i++) {
          const item = translated[i];
          if (!item) continue;
          const plan = handler.approval.planBundles([item.call]);
          if (!plan.ok) {
            return reply.code(400).send({
              ...plan.error,
              message: `items[${i}]: ${plan.error.message} (a multisig Sender only proposes native and known-token transfers)`,
            } satisfies DispatchError);
          }
        }
      }

      // #11 (ADR-0038): the Chain Handler both signals Bulk Call support (by
      // having validateBulkCall at all) and checks the request against its
      // items — resolving the batch size and who funds each item.
      let bulkCallPlan: BulkCallPlan | undefined;
      if (bulkCall !== undefined) {
        if (!handler.validateBulkCall) {
          return reply.code(400).send({ error: `chain ${chain} has no Bulk Call mode` });
        }
        const planResult = await handler.validateBulkCall(bulkCall, translated);
        if (!planResult.ok) {
          return reply.code(400).send(planResult.error satisfies DispatchError);
        }
        bulkCallPlan = planResult.value;
        translated.forEach((item, index) => {
          const fundedBy = bulkCallPlan?.fundedBy[index];
          if (fundedBy) item.fundedBy = fundedBy;
        });
      }

      const dispatch = await store.createDispatch({
        chain,
        idempotencyKey,
        items: translated,
        retryPolicy: retryPolicy ?? defaultRetryPolicy,
        bulkCall: bulkCallPlan?.bulkCall ?? null,
      });

      return reply.code(202).send({ dispatchId: dispatch.id, status: dispatch.status });
    },
  );

  app.get<{ Querystring: RawListQuery }>(
    '/v1/dispatches',
    { onRequest: auth, schema: { querystring: listQuerySchema } },
    async (request, reply) => {
      const filter = parseListQuery(request.query);
      if (!filter.ok) return reply.code(400).send({ error: filter.error });
      return reply.send(await listDispatchPage(store, filter.value));
    },
  );

  app.get<{ Params: { id: string }; Querystring: { include?: unknown } }>(
    '/v1/dispatch/:id',
    { onRequest: auth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'not found' });
      const view = await readDispatchView(store, request.params.id, {
        timeline: request.query.include === 'timeline',
      });
      if (!view) return reply.code(404).send({ error: 'not found' });
      return reply.send(view);
    },
  );

  app.post<{ Params: { id: string } }>(
    '/v1/dispatch/:id/cancel',
    { onRequest: auth },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send({ error: 'not found' });
      const outcome = await store.cancelDispatch(request.params.id);
      if (outcome === 'not_found') return reply.code(404).send({ error: 'not found' });
      if (outcome === 'already_claimed') {
        return reply.code(409).send({
          code: 'ALREADY_CLAIMED',
          message: 'the engine has already claimed this Dispatch, so it can no longer be cancelled',
        });
      }
      return reply.send(await readDispatchView(store, request.params.id));
    },
  );

  return Promise.resolve();
};
