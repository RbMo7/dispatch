import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { ChainRegistry } from '../chain-registry/chain-registry.js';
import type { ChainHandler } from '../chain-handler/chain-handler.js';
import type { Call } from '../domain/call.js';
import type { Chain } from '../domain/chain.js';
import type { Dispatch, DispatchStatus } from '../domain/dispatch.js';
import type { DispatchError } from '../domain/errors.js';
import type { Transaction, TransactionStatus } from '../domain/transaction.js';
import { err, ok, type Result } from '../domain/result.js';
import type { DispatchStore } from '../repository/dispatch-store.js';

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
    required: ['chain', 'items'],
    additionalProperties: false,
    properties: {
      chain: { type: 'string', enum: ['evm', 'solana'] },
      retryPolicy: { type: 'boolean' },
      items: {
        type: 'array',
        minItems: 1,
        items: {
          type: 'object',
          required: ['type'],
          properties: { type: { type: 'string' } },
          additionalProperties: true,
        },
      },
    },
  },
};

type PostDispatchBody = {
  chain: Chain;
  retryPolicy?: boolean;
  items: Record<string, unknown>[];
};

/**
 * Turns one wire item into a Call — a `payment` item is translated via the
 * Chain Handler's `paymentToCall` (ADR-0028); a `call` item's fields beyond
 * `type` are already chain-shaped and caller-owned (ADR-0018), so they pass
 * through untouched rather than being deeply validated here.
 */
async function translateItem(
  handler: ChainHandler,
  raw: Record<string, unknown>,
  index: number,
): Promise<Result<Call, RouteError>> {
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
    const translated = await handler.paymentToCall({ recipient, asset, amount });
    if (!translated.ok) return err({ status: 400, body: translated.error });
    return ok(translated.value);
  }

  if (type === 'call') {
    return ok(rest as Call);
  }

  return err(
    invalidRequest(
      `items[${index}]: unknown item type "${String(type)}" — must be "payment" or "call"`,
    ),
  );
}

/** The wire's lowercase per-item status vocabulary (docs/api.md) — distinct from Transaction's own uppercase one. */
function toWireItemStatus(status: TransactionStatus): string {
  switch (status) {
    case 'PENDING':
      return 'broadcasting';
    case 'CONFIRMED':
      return 'confirmed';
    case 'FAILED':
      return 'failed';
    case 'ABANDONED':
      return 'abandoned';
  }
}

/**
 * Dispatch.status only ever persists 'queued'/'broadcasting' (claimQueued's
 * own transition, ADR-0009's outbox) — the terminal wire statuses
 * (confirmed/failed/partial) are derived here from the aggregate of the
 * Dispatch's Transactions, never stored redundantly. ABANDONED counts
 * alongside FAILED for this aggregate: the Coordinator has stopped
 * actively watching it, even though it might still confirm later — that
 * nuance stays visible at the per-item level (docs/api.md), not lost, just
 * not double-counted as "in progress" here.
 */
function deriveDispatchStatus(dispatch: Dispatch, transactions: Transaction[]): DispatchStatus {
  if (dispatch.status === 'queued') return 'queued';

  const stillPending =
    transactions.length < dispatch.items.length || transactions.some((t) => t.status === 'PENDING');
  if (stillPending) return 'broadcasting';

  const confirmedCount = transactions.filter((t) => t.status === 'CONFIRMED').length;
  if (confirmedCount === transactions.length) return 'confirmed';
  if (confirmedCount === 0) return 'failed';
  return 'partial';
}

function checkAuth(authToken: string) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (request.headers.authorization !== `Bearer ${authToken}`) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

/** `POST /v1/dispatch` and `GET /v1/dispatch/:id` against the wire format pinned in docs/api.md (issue 08). */
export const registerDispatchRoutes: FastifyPluginAsync<DispatchRouteDeps> = (app, deps) => {
  const { store, chainRegistry, authToken, defaultRetryPolicy } = deps;
  const auth = checkAuth(authToken);

  app.post<{ Body: PostDispatchBody }>(
    '/v1/dispatch',
    { schema: postDispatchSchema, preHandler: auth },
    async (request, reply) => {
      const idempotencyKey = request.headers['idempotency-key'];
      if (typeof idempotencyKey !== 'string' || idempotencyKey.length === 0) {
        return reply.code(400).send({ error: 'Idempotency-Key header is required' });
      }

      const { chain, items, retryPolicy } = request.body;

      const registryResult = chainRegistry.get(chain);
      if (!registryResult.ok) {
        return reply.code(400).send(registryResult.error satisfies DispatchError);
      }
      const handler = registryResult.value;

      const translated: Call[] = [];
      for (let i = 0; i < items.length; i++) {
        const item = items[i];
        if (!item) continue;
        const result = await translateItem(handler, item, i);
        if (!result.ok) {
          return reply.code(result.error.status).send(result.error.body);
        }
        translated.push(result.value);
      }

      const dispatch = await store.createDispatch({
        chain,
        idempotencyKey,
        items: translated,
        retryPolicy: retryPolicy ?? defaultRetryPolicy,
      });

      return reply.code(202).send({ dispatchId: dispatch.id, status: dispatch.status });
    },
  );

  app.get<{ Params: { id: string } }>(
    '/v1/dispatch/:id',
    { preHandler: auth },
    async (request, reply) => {
      const dispatch = await store.getDispatch(request.params.id);
      if (!dispatch) {
        return reply.code(404).send({ error: 'not found' });
      }

      const transactions = await store.listTransactions(dispatch.id);
      const transactionByCallIndex = new Map(transactions.map((t) => [t.callIndex, t]));

      const items = dispatch.items.map((_, index) => {
        const transaction = transactionByCallIndex.get(index);
        if (!transaction) {
          return { status: 'queued', transactionHash: null, error: null };
        }
        return {
          status: toWireItemStatus(transaction.status),
          transactionHash: transaction.hash,
          error: transaction.error,
        };
      });

      return reply.send({
        dispatchId: dispatch.id,
        status: deriveDispatchStatus(dispatch, transactions),
        items,
      });
    },
  );

  return Promise.resolve();
};
