import {
  type AssetNames,
  assetNames,
  type AssetPreview,
  type KnownAsset,
} from '../../domain/assets';
import type { Chain } from '../../domain/chains';
import type { ContractPreview, ContractRequest, KnownContract } from '../../domain/contracts';
import type { DispatchDetail, Mode } from '../../domain/dispatch';
import type { FlagRule, Preview, TokenKind } from '../../domain/flagRules';
import type { Sender } from '../../domain/sender';
import type { Setup } from '../../domain/setup';
import type { Status } from '../../domain/status';
import {
  type ActivityPage,
  type DispatchPage,
  type RejectedPage,
  MalformedResponse,
  parseActivity,
  parseAssetPreview,
  parseAssets,
  parseContractPreview,
  parseContracts,
  parseDetail,
  parseKnownContract,
  parseKnownAsset,
  parseFlagRule,
  parseFlagRules,
  parsePage,
  parsePreview,
  parseRefusal,
  parseRejected,
  parseSenders,
  parseSetup,
  parseTokenKind,
} from './parse';

/**
 * Why a request did not produce a value. `unauthorized` signs the viewer out;
 * the rest are shown where the data would have been.
 */
export type ApiFailure =
  | { kind: 'unauthorized' }
  | { kind: 'not-found' }
  | { kind: 'refused'; status: number; code: string; message: string }
  | { kind: 'malformed'; message: string }
  | { kind: 'unreachable'; message: string };

export class ApiError extends Error {
  constructor(readonly failure: ApiFailure) {
    super(describeFailure(failure));
    this.name = 'ApiError';
  }
}

export function describeFailure(failure: ApiFailure): string {
  switch (failure.kind) {
    case 'unauthorized':
      return 'The engine refused the token.';
    case 'not-found':
      return 'No Dispatch has this id.';
    case 'refused':
      return failure.message;
    case 'malformed':
      return `The engine sent a response this console cannot read: ${failure.message}.`;
    case 'unreachable':
      return `The engine could not be reached: ${failure.message}.`;
  }
}

export interface ListFilters {
  chain?: Chain | undefined;
  /** A Sender's name; the engine matches it on every chain that has one so named. */
  sender?: string | undefined;
  mode?: Mode | undefined;
  status?: Status | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
}

/** `POST /v1/assets` and its preview: the symbol only replaces the chain's own. */
export interface AssetRequest {
  chain: Chain;
  address: string;
  symbol?: string | undefined;
}

export interface ApiClient {
  listDispatches(
    filters: ListFilters,
    page: { cursor?: string | null; limit?: number },
    signal?: AbortSignal,
  ): Promise<DispatchPage>;
  getDispatch(id: string, signal?: AbortSignal): Promise<DispatchDetail>;
  listSenders(signal?: AbortSignal): Promise<Sender[]>;
  getSetup(signal?: AbortSignal): Promise<Setup>;
  cancelDispatch(id: string): Promise<DispatchDetail>;
  getTokenKind(): Promise<TokenKind>;
  /** The routes below are the operator token's (ADR-0057): an AUTH_TOKEN session never calls them. */
  releaseDispatch(id: string, reason: string): Promise<DispatchDetail>;
  listFlagRules(signal?: AbortSignal): Promise<FlagRule[]>;
  createFlagRule(body: Record<string, unknown>): Promise<FlagRule>;
  updateFlagRule(id: string, body: Record<string, unknown>): Promise<FlagRule>;
  previewFlagRule(body: Record<string, unknown>, signal?: AbortSignal): Promise<Preview>;
  listActivity(cursor: string | null, signal?: AbortSignal): Promise<ActivityPage>;
  /** Either token. Also refreshes the names every later read resolves amounts by. */
  listAssets(signal?: AbortSignal): Promise<KnownAsset[]>;
  previewAsset(body: AssetRequest, signal?: AbortSignal): Promise<AssetPreview>;
  addAsset(body: AssetRequest): Promise<KnownAsset>;
  setAssetEnabled(id: string, enabled: boolean, reason?: string): Promise<KnownAsset>;
  /** ADR-0063: either token. */
  listContracts(signal?: AbortSignal): Promise<KnownContract[]>;
  previewContract(body: ContractRequest, signal?: AbortSignal): Promise<ContractPreview>;
  addContract(body: ContractRequest): Promise<KnownContract>;
  setContractEnabled(id: string, enabled: boolean, reason?: string): Promise<KnownContract>;
  /** ADR-0062: refused `POST /v1/dispatch` requests, newest first, with the count of the last 24 hours. */
  listRejected(cursor: string | null, signal?: AbortSignal, limit?: number): Promise<RejectedPage>;
}

export const PAGE_LIMIT = 100;

/**
 * The `/v1` routes the console reads, with the viewer's bearer token. Every
 * amount it returns carries its asset's name from the Known Assets registry,
 * loaded on first need and refreshed by `listAssets`.
 */
export function createApiClient(
  token: string,
  onUnauthorized: () => void,
  fetcher: typeof fetch = (...args) => fetch(...args),
): ApiClient {
  let names: AssetNames | null = null;
  let loadingNames: Promise<AssetNames> | null = null;

  function remember(assets: KnownAsset[]): KnownAsset[] {
    names = assetNames(assets);
    return assets;
  }

  /**
   * The registry's names. A registry the engine could not give reads amounts
   * by their symbols for now and is asked for again on the next read; a
   * refused token still signs out.
   */
  async function assetNamesNow(): Promise<AssetNames> {
    if (names) return names;
    loadingNames ??= request('/v1/assets', (body) => assetNames(remember(parseAssets(body))));
    try {
      return await loadingNames;
    } catch (error) {
      if (error instanceof ApiError && error.failure.kind === 'unauthorized') throw error;
      return assetNames([]);
    } finally {
      loadingNames = null;
    }
  }

  /** A change to the registry: the next read loads it again. */
  function changed(asset: KnownAsset): KnownAsset {
    names = null;
    return asset;
  }

  async function request<T>(
    path: string,
    parse: (body: unknown) => T,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(path, {
        ...init,
        headers: {
          Authorization: `Bearer ${token}`,
          Accept: 'application/json',
          ...(init.body === undefined ? {} : { 'Content-Type': 'application/json' }),
        },
      });
    } catch (error) {
      if (init.signal?.aborted) throw error;
      throw new ApiError({ kind: 'unreachable', message: (error as Error).message });
    }
    const body: unknown = await response.json().catch(() => null);
    if (response.status === 401) {
      onUnauthorized();
      throw new ApiError({ kind: 'unauthorized' });
    }
    if (response.status === 404) throw new ApiError({ kind: 'not-found' });
    if (!response.ok) {
      const refusal = parseRefusal(body);
      if (refusal) throw new ApiError({ kind: 'refused', status: response.status, ...refusal });
      throw new ApiError({ kind: 'unreachable', message: `HTTP ${response.status}` });
    }
    try {
      return parse(body);
    } catch (error) {
      if (error instanceof MalformedResponse) {
        throw new ApiError({ kind: 'malformed', message: error.message });
      }
      throw error;
    }
  }

  return {
    async listDispatches(filters, page, signal) {
      const query = new URLSearchParams({ limit: String(page.limit ?? PAGE_LIMIT) });
      if (page.cursor) query.set('cursor', page.cursor);
      if (filters.chain) query.set('chain', filters.chain);
      if (filters.sender) query.set('sender', filters.sender);
      if (filters.mode) query.set('mode', filters.mode);
      if (filters.status) query.set('status', filters.status);
      if (filters.from) query.set('from', filters.from.toISOString());
      if (filters.to) query.set('to', filters.to.toISOString());
      const n = await assetNamesNow();
      return request(`/v1/dispatches?${query}`, (body) => parsePage(body, n), {
        signal: signal ?? null,
      });
    },
    async getDispatch(id, signal) {
      const n = await assetNamesNow();
      return request(
        `/v1/dispatch/${encodeURIComponent(id)}?include=timeline`,
        (body) => parseDetail(body, n),
        { signal: signal ?? null },
      );
    },
    async listSenders(signal) {
      const n = await assetNamesNow();
      return request('/v1/senders', (body) => parseSenders(body, n), { signal: signal ?? null });
    },
    getSetup(signal) {
      return request('/v1/setup', parseSetup, { signal: signal ?? null });
    },
    async cancelDispatch(id) {
      const n = await assetNamesNow();
      return request(
        `/v1/dispatch/${encodeURIComponent(id)}/cancel`,
        (body) => parseDetail(body, n),
        {
          method: 'POST',
        },
      );
    },
    getTokenKind() {
      return request('/v1/token', parseTokenKind);
    },
    async releaseDispatch(id, reason) {
      const n = await assetNamesNow();
      return request(
        `/v1/dispatch/${encodeURIComponent(id)}/release`,
        (body) => parseDetail(body, n),
        {
          method: 'POST',
          body: JSON.stringify({ reason }),
        },
      );
    },
    listFlagRules(signal) {
      return request('/v1/flag-rules', parseFlagRules, { signal: signal ?? null });
    },
    createFlagRule(body) {
      return request('/v1/flag-rules', parseFlagRule, {
        method: 'POST',
        body: JSON.stringify(body),
      });
    },
    updateFlagRule(id, body) {
      return request(`/v1/flag-rules/${encodeURIComponent(id)}`, parseFlagRule, {
        method: 'PUT',
        body: JSON.stringify(body),
      });
    },
    previewFlagRule(body, signal) {
      return request('/v1/flag-rules/preview', parsePreview, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    },
    listActivity(cursor, signal) {
      const query = new URLSearchParams({ limit: String(PAGE_LIMIT) });
      if (cursor) query.set('cursor', cursor);
      return request(`/v1/activity?${query}`, parseActivity, { signal: signal ?? null });
    },
    async listAssets(signal) {
      return remember(await request('/v1/assets', parseAssets, { signal: signal ?? null }));
    },
    previewAsset(body, signal) {
      return request('/v1/assets/preview', parseAssetPreview, {
        method: 'POST',
        body: JSON.stringify(body),
        signal: signal ?? null,
      });
    },
    async addAsset(body) {
      return changed(
        await request('/v1/assets', (value) => parseKnownAsset(value), {
          method: 'POST',
          body: JSON.stringify(body),
        }),
      );
    },
    async setAssetEnabled(id, enabled, reason) {
      return changed(
        await request(`/v1/assets/${encodeURIComponent(id)}`, (value) => parseKnownAsset(value), {
          method: 'PATCH',
          body: JSON.stringify(reason ? { enabled, reason } : { enabled }),
        }),
      );
    },
    listContracts(signal) {
      return request('/v1/contracts', parseContracts, { signal: signal ?? null });
    },
    previewContract(body, signal) {
      return request('/v1/contracts/preview', parseContractPreview, {
        method: 'POST',
        body: contractBody(body),
        signal: signal ?? null,
      });
    },
    addContract(body) {
      return request('/v1/contracts', (value) => parseKnownContract(value), {
        method: 'POST',
        body: contractBody(body),
      });
    },
    setContractEnabled(id, enabled, reason) {
      return request(
        `/v1/contracts/${encodeURIComponent(id)}`,
        (value) => parseKnownContract(value),
        { method: 'PATCH', body: JSON.stringify(reason ? { enabled, reason } : { enabled }) },
      );
    },
    listRejected(cursor, signal, limit = PAGE_LIMIT) {
      const query = new URLSearchParams({ limit: String(limit) });
      if (cursor) query.set('cursor', cursor);
      return request(`/v1/rejected?${query}`, parseRejected, { signal: signal ?? null });
    },
  };
}

/** The pasted text goes as it is: the engine reads it, so its refusal names what is wrong. */
function contractBody({ chain, address, label, definition }: ContractRequest): string {
  return JSON.stringify({
    chain,
    address,
    label,
    [chain === 'base' ? 'abi' : 'idl']: definition,
  });
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
