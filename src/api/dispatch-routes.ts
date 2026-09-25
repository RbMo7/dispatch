import type { FastifyPluginAsync, FastifyReply, FastifyRequest } from 'fastify';

import type { ChainRegistry } from '../chain-registry/chain-registry.js';
import type {
  BulkCallPlan,
  BulkCallRequest,
  ChainHandler,
} from '../chain-handler/chain-handler.js';
import type { Call, DispatchItem, Payment } from '../domain/call.js';
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
 * caller-owned (ADR-0018), so they pass through untouched rather than being
 * deeply validated here, and carry no Payment.
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
    return ok({ call: rest as Call, payment: null });
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
    case 'REPLACED':
    case 'DROPPED':
      throw new Error(`a ${status} Transaction is never a Call's reported version (ADR-0037)`);
  }
}

/** #9 (ADR-0037): a fee-bumped Call has several Transactions at one nonce — only the current one (latest while pending, or the one that settled it) is its reported version. */
function isCurrentVersion(transaction: Transaction): boolean {
  return transaction.status !== 'REPLACED' && transaction.status !== 'DROPPED';
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

  app.get<{ Params: { id: string } }>(
    '/v1/dispatch/:id',
    { preHandler: auth },
    async (request, reply) => {
      const dispatch = await store.getDispatch(request.params.id);
      if (dispatch) {
        const transactions = (await store.listTransactions(dispatch.id)).filter(isCurrentVersion);
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
          mode: 'managed',
          status: deriveDispatchStatus(dispatch, transactions),
          items,
        });
      }

      // ADR-0031: a Relay Dispatch is always exactly one already-signed
      // transaction, never a batch — its response shape (dispatchId, mode,
      // status, transactionHash, error) is honestly distinct from Managed
      // Dispatch's items-array shape, not a fake single-item version of it.
      const relayDispatch = await store.getRelayDispatch(request.params.id);
      if (relayDispatch) {
        const [transaction] = await store.listTransactions(relayDispatch.id);
        if (!transaction) {
          return reply.send({
            dispatchId: relayDispatch.id,
            mode: 'relay',
            status: 'queued',
            transactionHash: null,
            error: null,
          });
        }

        return reply.send({
          dispatchId: relayDispatch.id,
          mode: 'relay',
          status: toWireItemStatus(transaction.status),
          transactionHash: transaction.hash,
          error: transaction.error,
        });
      }

      return reply.code(404).send({ error: 'not found' });
    },
  );

  return Promise.resolve();
};
