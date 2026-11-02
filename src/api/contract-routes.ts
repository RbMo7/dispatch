import { PublicKey } from '@solana/web3.js';
import type { FastifyPluginAsync, FastifyReply } from 'fastify';
import { getAddress, isAddress } from 'viem';

import {
  type ContractEntry,
  type ContractRegistry,
  type ContractSummary,
  parseDefinition,
  summarize,
} from '../contract-registry/contract-registry.js';
import { CHAINS, type Chain } from '../domain/chain.js';
import {
  CONTRACT_LABEL_MAX,
  type KnownContract,
  type NewKnownContract,
} from '../domain/known-contract.js';
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

export type ContractRouteDeps = {
  tokens: ApiTokens;
  store: DispatchStore;
  contracts: ContractRegistry;
  enabledChains: readonly Chain[];
};

/** A refusal a client can switch on, with words for people. */
type Refusal = { status: 400 | 409; code: string; message: string };

const NOT_FOUND = { error: 'not found' };

export function toWireContract(contract: KnownContract, summary: ContractSummary | null) {
  return {
    id: contract.id,
    chain: contract.chain,
    address: contract.address,
    label: contract.label,
    ...(contract.chain === 'base' ? { abi: contract.abi } : { idl: contract.idl }),
    functions: summary?.functions ?? [],
    events: summary?.events ?? [],
    source: contract.source,
    enabled: contract.enabled,
    addedBy: contract.addedBy,
    addedAt: contract.addedAt.toISOString(),
  };
}

const wire = (entry: ContractEntry) => toWireContract(entry.contract, entry.summary);

const REQUEST_FIELDS = ['chain', 'address', 'label', 'abi', 'idl', 'reason'];

/** The contract's address as the chain spells it: checksummed on Base, a public key on Solana. */
function parseAddress(chain: Chain, raw: unknown): Result<string, string> {
  if (typeof raw !== 'string' || raw.trim() === '') {
    return err(`address: must be the ${chain === 'base' ? 'contract' : 'program'} address`);
  }
  const address = raw.trim();
  if (chain === 'base') {
    return isAddress(address, { strict: false })
      ? ok(getAddress(address))
      : err(`address: ${address} is not a Base address`);
  }
  try {
    return ok(new PublicKey(address).toBase58());
  } catch {
    return err(`address: ${address} is not a Solana address`);
  }
}

/** A pasted definition may arrive as the JSON itself or as the text that was pasted. */
function parseJson(field: string, raw: unknown): Result<unknown, string> {
  if (typeof raw !== 'string') return ok(raw);
  try {
    return ok(JSON.parse(raw) as unknown);
  } catch (cause) {
    return err(`${field}: is not JSON (${(cause as Error).message})`);
  }
}

type ParsedRequest = { contract: NewKnownContract; summary: ContractSummary };

/**
 * ADR-0063: a registration as the boundary takes it. A malformed ABI or IDL
 * is `INVALID_ABI` or `INVALID_IDL`, naming what is wrong and where.
 */
function parseContractRequest(
  raw: unknown,
  enabledChains: readonly Chain[],
): Result<ParsedRequest, Refusal | string> {
  if (typeof raw !== 'object' || raw === null || Array.isArray(raw)) {
    return err('the body must be a JSON object');
  }
  const body = raw as Record<string, unknown>;
  const unknown = Object.keys(body).find((key) => !REQUEST_FIELDS.includes(key));
  if (unknown !== undefined) return err(`${unknown}: not a field of a contract`);
  const chain = body.chain as Chain;
  if (!CHAINS.includes(chain)) return err(`chain: must be one of ${CHAINS.join(', ')}`);
  if (!enabledChains.includes(chain)) return err(`chain: ${chain} is not enabled on this engine`);
  const address = parseAddress(chain, body.address);
  if (!address.ok) return address;
  if (typeof body.label !== 'string' || body.label.trim() === '') {
    return err('label: required, what to call the contract');
  }
  const label = body.label.trim();
  if (label.length > CONTRACT_LABEL_MAX) {
    return err(`label: at most ${CONTRACT_LABEL_MAX} characters`);
  }
  const [field, other] = chain === 'base' ? (['abi', 'idl'] as const) : (['idl', 'abi'] as const);
  if (body[other] !== undefined) {
    return err(
      `${other}: ${chain === 'base' ? 'Base takes an ABI in abi' : 'Solana takes an Anchor IDL in idl'}`,
    );
  }
  if (body[field] === undefined) {
    return err(`${field}: required, the contract's ${chain === 'base' ? 'ABI' : 'Anchor IDL'}`);
  }
  const json = parseJson(field, body[field]);
  const code = chain === 'base' ? 'INVALID_ABI' : 'INVALID_IDL';
  if (!json.ok) return err({ status: 400, code, message: json.error });
  const candidate = {
    chain,
    address: address.value,
    label,
    [field]: json.value,
  } as NewKnownContract;
  const parsed = parseDefinition(candidate);
  if (!parsed.ok) return err({ status: 400, code, message: parsed.error });
  return ok({
    contract: { ...candidate, [field]: parsed.value.stored },
    summary: summarize(parsed.value.decoder),
  });
}

function refuse(reply: FastifyReply, refusal: Refusal | string) {
  return typeof refusal === 'string'
    ? reply.code(400).send({ error: refusal })
    : reply.code(refusal.status).send({ code: refusal.code, message: refusal.message });
}

function alreadyRegistered(
  contracts: ContractRegistry,
  contract: NewKnownContract,
): Refusal | null {
  const held = contracts.at(contract.chain, contract.address);
  return held
    ? {
        status: 409,
        code: 'CONTRACT_EXISTS',
        message: `${contract.address} is already registered on ${contract.chain}, as ${held.label}: disable it first to replace its ${contract.chain === 'base' ? 'ABI' : 'IDL'}`,
      }
    : null;
}

/** ADR-0063: read with either token; preview, add, enable and disable with OPERATOR_TOKEN (ADR-0057). */
export const registerContractRoutes: FastifyPluginAsync<ContractRouteDeps> = (app, deps) => {
  const { store, tokens, contracts } = deps;
  const write = requireOperator(tokens);

  app.get<{ Querystring: { chain?: string } }>(
    '/v1/contracts',
    { onRequest: requireToken(tokens) },
    async (request, reply) => {
      const { chain } = request.query;
      if (chain !== undefined && !CHAINS.includes(chain as Chain)) {
        return reply.code(400).send({ error: `chain: must be one of ${CHAINS.join(', ')}` });
      }
      return { contracts: contracts.list(chain as Chain | undefined).map(wire) };
    },
  );

  app.post('/v1/contracts/preview', { onRequest: write }, async (request, reply) => {
    const parsed = parseContractRequest(request.body, deps.enabledChains);
    if (!parsed.ok) return refuse(reply, parsed.error);
    const { contract, summary } = parsed.value;
    const taken = alreadyRegistered(contracts, contract);
    if (taken) return refuse(reply, taken);
    return {
      chain: contract.chain,
      address: contract.address,
      label: contract.label,
      ...summary,
    };
  });

  app.post('/v1/contracts', { onRequest: write }, async (request, reply) => {
    const parsed = parseContractRequest(request.body, deps.enabledChains);
    if (!parsed.ok) return refuse(reply, parsed.error);
    const reason = readReason(request.body);
    if (!reason.ok) return reply.code(400).send({ error: reason.error });
    const { contract, summary } = parsed.value;
    const taken = alreadyRegistered(contracts, contract);
    if (taken) return refuse(reply, taken);
    const actor = { tokenKind: 'operator' as const, reason: reason.value };
    const added = await store.addKnownContract(contract, actor);
    await contracts.refresh();
    if (added === 'address_taken') {
      return refuse(reply, {
        status: 409,
        code: 'CONTRACT_EXISTS',
        message: `${contract.address} was registered on ${contract.chain} while this request ran`,
      });
    }
    logOperatorAction(request, 'contract_add', added.id, actor);
    return reply.code(201).send(toWireContract(added, summary));
  });

  app.patch<{ Params: { id: string } }>(
    '/v1/contracts/:id',
    { onRequest: write },
    async (request, reply) => {
      if (!isUuid(request.params.id)) return reply.code(404).send(NOT_FOUND);
      const body = request.body as Record<string, unknown> | null | undefined;
      if (typeof body !== 'object' || body === null || Array.isArray(body)) {
        return reply.code(400).send({ error: 'the body must be a JSON object' });
      }
      const unknown = Object.keys(body).find((key) => key !== 'enabled' && key !== 'reason');
      if (unknown !== undefined) {
        return reply.code(400).send({ error: `${unknown}: only enabled can be changed` });
      }
      const { enabled } = body;
      if (typeof enabled !== 'boolean') {
        return reply.code(400).send({ error: 'enabled: must be true or false' });
      }
      const reason = readReason(body);
      if (!reason.ok) return reply.code(400).send({ error: reason.error });
      const actor = { tokenKind: 'operator' as const, reason: reason.value };
      const outcome = await store.setKnownContractEnabled(request.params.id, enabled, actor);
      if (outcome === 'not_found') return reply.code(404).send(NOT_FOUND);
      if (outcome === 'address_taken') {
        return refuse(reply, {
          status: 409,
          code: 'CONTRACT_EXISTS',
          message: 'another enabled contract is registered at this address: disable that one first',
        });
      }
      await contracts.refresh();
      if (outcome.changed) {
        logOperatorAction(
          request,
          enabled ? 'contract_enable' : 'contract_disable',
          outcome.contract.id,
          actor,
        );
      }
      return toWireContract(outcome.contract, contracts.get(outcome.contract.id)?.summary ?? null);
    },
  );

  return Promise.resolve();
};
