import type { FastifyPluginAsync } from 'fastify';

import type { DispatchStore } from '../repository/dispatch-store.js';
import type { AssetDecimals } from './asset-decimals.js';
import { parseFlagRuleSpec, toWireRule } from './flag-rule-wire.js';
import {
  type ApiTokens,
  logOperatorAction,
  readReason,
  requireOperator,
  requireToken,
} from './operator-auth.js';
import { isUuid } from './uuid.js';

export type FlagRuleRouteDeps = {
  tokens: ApiTokens;
  store: DispatchStore;
  assetDecimals: AssetDecimals;
};

const NOT_FOUND = { error: 'not found' };

/** ADR-0058: read with either token; write with OPERATOR_TOKEN (ADR-0057). */
export const registerFlagRuleRoutes: FastifyPluginAsync<FlagRuleRouteDeps> = (app, deps) => {
  const { store, tokens, assetDecimals } = deps;
  const read = requireToken(tokens);
  const write = requireOperator(tokens);

  app.get('/v1/flag-rules', { onRequest: read }, async () => ({
    rules: (await store.listFlagRules()).map(toWireRule),
  }));

  app.get<{ Params: { id: string } }>(
    '/v1/flag-rules/:id',
    { onRequest: read },
    async (request, reply) => {
      const rule = isUuid(request.params.id) ? await store.getFlagRule(request.params.id) : null;
      return rule ? toWireRule(rule) : reply.code(404).send(NOT_FOUND);
    },
  );

  app.post('/v1/flag-rules', { onRequest: write }, async (request, reply) => {
    const spec = parseFlagRuleSpec(request.body, assetDecimals);
    if (!spec.ok) return reply.code(400).send({ error: spec.error });
    const reason = readReason(request.body);
    if (!reason.ok) return reply.code(400).send({ error: reason.error });
    const actor = { tokenKind: 'operator' as const, reason: reason.value };
    const rule = await store.createFlagRule(spec.value, actor);
    logOperatorAction(request, 'flag_rule_create', rule.id, actor);
    return reply.code(201).send(toWireRule(rule));
  });

  app.put<{ Params: { id: string } }>(
    '/v1/flag-rules/:id',
    { onRequest: write },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send(NOT_FOUND);
      const spec = parseFlagRuleSpec(request.body, assetDecimals);
      if (!spec.ok) return reply.code(400).send({ error: spec.error });
      const reason = readReason(request.body);
      if (!reason.ok) return reply.code(400).send({ error: reason.error });
      const actor = { tokenKind: 'operator' as const, reason: reason.value };
      const rule = await store.updateFlagRule(request.params.id, spec.value, actor);
      if (rule === 'not_found') return reply.code(404).send(NOT_FOUND);
      if (rule === 'deleted') {
        return reply
          .code(409)
          .send({ code: 'RULE_DELETED', message: 'this Flag Rule is deleted; create a new one' });
      }
      logOperatorAction(request, 'flag_rule_update', rule.id, actor);
      return toWireRule(rule);
    },
  );

  app.delete<{ Params: { id: string } }>(
    '/v1/flag-rules/:id',
    { onRequest: write },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send(NOT_FOUND);
      const reason = readReason(request.body);
      if (!reason.ok) return reply.code(400).send({ error: reason.error });
      const actor = { tokenKind: 'operator' as const, reason: reason.value };
      const outcome = await store.deleteFlagRule(request.params.id, actor);
      if (outcome === 'not_found') return reply.code(404).send(NOT_FOUND);
      if (outcome.deleted) logOperatorAction(request, 'flag_rule_delete', outcome.rule.id, actor);
      return toWireRule(outcome.rule);
    },
  );

  return Promise.resolve();
};
