import type { FastifyReply, FastifyRequest } from 'fastify';

import type { OperatorActionKind, OperatorActor, TokenKind } from '../domain/operator-action.js';
import { err, ok, type Result } from '../domain/result.js';

/** ADR-0022 and ADR-0057: `operator` is null when OPERATOR_TOKEN is unset. */
export type ApiTokens = { auth: string; operator: string | null };

export function parseApiTokens(auth: string, operator: string | undefined): ApiTokens {
  if (operator === undefined) return { auth, operator: null };
  if (operator.length === 0) {
    throw new Error('OPERATOR_TOKEN is set but empty: give it a value, or unset it');
  }
  if (operator === auth) {
    throw new Error('OPERATOR_TOKEN must differ from AUTH_TOKEN (ADR-0057)');
  }
  return { auth, operator };
}

export function tokenKindOf(request: FastifyRequest, tokens: ApiTokens): TokenKind | null {
  const header = request.headers.authorization;
  if (tokens.operator !== null && header === `Bearer ${tokens.operator}`) return 'operator';
  if (header === `Bearer ${tokens.auth}`) return 'auth';
  return null;
}

/** The token kind of a request that already passed `requireToken` or `requireOperator`. */
export function authedTokenKind(request: FastifyRequest, tokens: ApiTokens): TokenKind {
  const kind = tokenKindOf(request, tokens);
  if (kind === null) throw new Error('authedTokenKind called on an unauthenticated request');
  return kind;
}

/** An operator action's `reason` from a JSON body: absent is null, present must be a non-empty string. */
export function readReason(body: unknown): Result<string | null, string> {
  if (body === undefined || body === null) return ok(null);
  if (typeof body !== 'object' || Array.isArray(body)) return err('the body must be a JSON object');
  const { reason } = body as { reason?: unknown };
  if (reason === undefined) return ok(null);
  if (typeof reason !== 'string' || reason.trim().length === 0) {
    return err('reason: must be a non-empty string');
  }
  return ok(reason.trim());
}

/** ADR-0057: every recorded operator action is also logged. */
export function logOperatorAction(
  request: FastifyRequest,
  action: OperatorActionKind,
  targetId: string,
  actor: OperatorActor,
): void {
  request.log.info({ operatorAction: { action, targetId, ...actor } }, 'operator action');
}

/** Either token. */
export function requireToken(tokens: ApiTokens) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    if (tokenKindOf(request, tokens) === null) {
      await reply.code(401).send({ error: 'unauthorized' });
    }
  };
}

/** ADR-0057: release, Flag Rule writes and the activity record. */
export function requireOperator(tokens: ApiTokens) {
  return async (request: FastifyRequest, reply: FastifyReply): Promise<void> => {
    const kind = tokenKindOf(request, tokens);
    if (kind === null) {
      await reply.code(401).send({ error: 'unauthorized' });
    } else if (tokens.operator === null) {
      await reply.code(403).send({
        error: 'OPERATOR_TOKEN is not configured on this engine, so operator-only routes are off',
      });
    } else if (kind !== 'operator') {
      await reply.code(403).send({ error: 'this route needs OPERATOR_TOKEN, not AUTH_TOKEN' });
    }
  };
}
