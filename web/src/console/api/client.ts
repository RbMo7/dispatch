import type { Chain } from '../../domain/chains';
import type { DispatchDetail, Mode } from '../../domain/dispatch';
import type { Sender } from '../../domain/sender';
import type { Setup } from '../../domain/setup';
import type { Status } from '../../domain/status';
import {
  type DispatchPage,
  MalformedResponse,
  parseDetail,
  parsePage,
  parseRefusal,
  parseSenders,
  parseSetup,
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
  mode?: Mode | undefined;
  status?: Status | undefined;
  from?: Date | undefined;
  to?: Date | undefined;
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
}

export const PAGE_LIMIT = 100;

/** The `/v1` routes the console reads, with the viewer's bearer token. */
export function createApiClient(
  token: string,
  onUnauthorized: () => void,
  fetcher: typeof fetch = (...args) => fetch(...args),
): ApiClient {
  async function request<T>(
    path: string,
    parse: (body: unknown) => T,
    init: RequestInit = {},
  ): Promise<T> {
    let response: Response;
    try {
      response = await fetcher(path, {
        ...init,
        headers: { Authorization: `Bearer ${token}`, Accept: 'application/json' },
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
    listDispatches(filters, page, signal) {
      const query = new URLSearchParams({ limit: String(page.limit ?? PAGE_LIMIT) });
      if (page.cursor) query.set('cursor', page.cursor);
      if (filters.chain) query.set('chain', filters.chain);
      if (filters.mode) query.set('mode', filters.mode);
      if (filters.status) query.set('status', filters.status);
      if (filters.from) query.set('from', filters.from.toISOString());
      if (filters.to) query.set('to', filters.to.toISOString());
      return request(`/v1/dispatches?${query}`, parsePage, { signal: signal ?? null });
    },
    getDispatch(id, signal) {
      return request(`/v1/dispatch/${encodeURIComponent(id)}?include=timeline`, parseDetail, {
        signal: signal ?? null,
      });
    },
    listSenders(signal) {
      return request('/v1/senders', parseSenders, { signal: signal ?? null });
    },
    getSetup(signal) {
      return request('/v1/setup', parseSetup, { signal: signal ?? null });
    },
    cancelDispatch(id) {
      return request(`/v1/dispatch/${encodeURIComponent(id)}/cancel`, parseDetail, {
        method: 'POST',
      });
    },
  };
}

export function isUuid(value: string): boolean {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(value);
}
