import { isAddress, type Address } from 'viem';

import { DEFAULT_RPC_TIMEOUT_MS, fetchWithTimeout } from '../../../rpc-timeout.js';

/** What went wrong reaching the Safe Transaction Service, so a caller can tell the operator what to fix. */
export type SafeTxServiceErrorKind =
  | 'unreachable'
  | 'unauthorized' // 401: the API key is missing or invalid
  | 'rate-limited' // 429: the quota or the requests-per-second cap
  | 'rejected' // 422 or another 4xx: the service understood and refused
  | 'not-found' // 404
  | 'server-error' // 5xx
  | 'invalid-response'; // the body is not what the service documents

export class SafeTxServiceError extends Error {
  constructor(
    readonly kind: SafeTxServiceErrorKind,
    message: string,
    readonly status?: number,
  ) {
    super(message);
    this.name = 'SafeTxServiceError';
  }
}

export type ServiceAbout = { name: string; version: string };

export type ServiceSafeInfo = {
  address: Address;
  /** Decimal string, as the service sends it. */
  nonce: string;
  threshold: number;
  owners: Address[];
  modules: Address[];
  guard: Address;
  /** e.g. `1.4.1+L2`. */
  version: string;
};

export type ServiceDelegate = {
  safe: Address;
  delegate: Address;
  delegator: Address;
  label: string;
  /** ISO timestamp, or null when it never expires. */
  expiryDate: string | null;
};

export type SafeTxServiceClientOptions = {
  /** e.g. `https://api.safe.global/tx-service/base`, no trailing slash. */
  baseUrl: string;
  /** Sent as `Authorization: Bearer <key>` only when set. Never logged, never in an error. */
  apiKey?: string | undefined;
  /** Per-call deadline (rpc-timeout.ts). */
  timeoutMs?: number;
  fetch?: typeof fetch;
};

/**
 * A thin REST client of our own for the Safe Transaction Service (the
 * official SDK refuses the hosted service without an API key, spike #79).
 * Every response is validated at this boundary into a typed shape. Only
 * what startup needs lives here; proposing and confirmations (#83, #84)
 * add their own methods on top of `request`.
 */
export class SafeTxServiceClient {
  private readonly baseUrl: string;
  private readonly apiKey: string | undefined;
  private readonly fetchImpl: typeof fetch;

  constructor(options: SafeTxServiceClientOptions) {
    this.baseUrl = options.baseUrl.replace(/\/+$/, '');
    this.apiKey = options.apiKey;
    this.fetchImpl = fetchWithTimeout(
      options.fetch ?? fetch,
      options.timeoutMs ?? DEFAULT_RPC_TIMEOUT_MS,
    );
  }

  /** `GET /api/v1/about/` — proves the service is up. */
  async about(): Promise<ServiceAbout> {
    const body = asRecord(await this.request('GET', '/api/v1/about/'), 'about');
    return { name: str(body, 'name'), version: str(body, 'version') };
  }

  /** `GET /api/v1/safes/{safe}/` — what the service has indexed for this Safe on its chain. */
  async getSafe(safe: Address): Promise<ServiceSafeInfo> {
    const body = asRecord(await this.request('GET', `/api/v1/safes/${safe}/`), 'safe');
    return {
      address: addr(body, 'address'),
      nonce: str(body, 'nonce'),
      threshold: num(body, 'threshold'),
      owners: addrs(body, 'owners'),
      modules: addrs(body, 'modules'),
      guard: addr(body, 'guard'),
      version: str(body, 'version'),
    };
  }

  /** `GET /api/v2/delegates/?safe=&delegate=` — the registrations of `delegate` on `safe` (empty when none). */
  async getDelegates(safe: Address, delegate: Address): Promise<ServiceDelegate[]> {
    const query = new URLSearchParams({ safe, delegate });
    const body = asRecord(
      await this.request('GET', `/api/v2/delegates/?${query.toString()}`),
      'delegates',
    );
    const results = body.results;
    if (!Array.isArray(results)) throw invalid('delegates', 'results is not an array');
    return results.map((entry) => {
      const item = asRecord(entry, 'delegates.results[]');
      const expiry = item.expiryDate;
      if (expiry !== null && typeof expiry !== 'string') {
        throw invalid('delegates', 'expiryDate is neither null nor a string');
      }
      return {
        safe: addr(item, 'safe'),
        delegate: addr(item, 'delegate'),
        delegator: addr(item, 'delegator'),
        label: str(item, 'label'),
        expiryDate: expiry,
      };
    });
  }

  /** One round trip: the bearer header only when keyed, failures mapped to a `SafeTxServiceError`. Returns the parsed JSON body. */
  protected async request(method: 'GET' | 'POST', path: string, body?: unknown): Promise<unknown> {
    let response: Response;
    try {
      response = await this.fetchImpl(`${this.baseUrl}${path}`, {
        method,
        headers: {
          accept: 'application/json',
          ...(body === undefined ? {} : { 'content-type': 'application/json' }),
          ...(this.apiKey === undefined ? {} : { authorization: `Bearer ${this.apiKey}` }),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
    } catch (cause) {
      throw new SafeTxServiceError(
        'unreachable',
        `Safe Transaction Service at ${this.baseUrl} is unreachable: ${cause instanceof Error ? cause.message : String(cause)}`,
      );
    }

    if (!response.ok) throw await failure(response, this.baseUrl, this.apiKey !== undefined);

    try {
      const parsed: unknown = await response.json();
      return parsed;
    } catch {
      throw invalid(path, 'the body is not JSON');
    }
  }
}

async function failure(
  response: Response,
  baseUrl: string,
  keyed: boolean,
): Promise<SafeTxServiceError> {
  const { status } = response;
  const detail = (await response.text().catch(() => '')).slice(0, 300);
  const suffix = detail === '' ? '' : `: ${detail}`;
  if (status === 401) {
    return new SafeTxServiceError(
      'unauthorized',
      `Safe Transaction Service at ${baseUrl} answered 401: ${keyed ? 'BASE_SAFE_API_KEY was refused' : 'it requires an API key, set BASE_SAFE_API_KEY'}${suffix}`,
      status,
    );
  }
  if (status === 429) {
    return new SafeTxServiceError(
      'rate-limited',
      `Safe Transaction Service at ${baseUrl} answered 429: ${keyed ? 'the API key is over its rate limit or monthly quota' : 'the unauthenticated limit (2 requests/second, 5,000/month) is exhausted, set BASE_SAFE_API_KEY'}${suffix}`,
      status,
    );
  }
  if (status === 404) {
    return new SafeTxServiceError(
      'not-found',
      `Safe Transaction Service answered 404 (not found)${suffix}`,
      status,
    );
  }
  if (status >= 500) {
    return new SafeTxServiceError(
      'server-error',
      `Safe Transaction Service at ${baseUrl} answered ${status}${suffix}`,
      status,
    );
  }
  return new SafeTxServiceError(
    'rejected',
    `Safe Transaction Service at ${baseUrl} refused the request with ${status}${suffix}`,
    status,
  );
}

function invalid(what: string, why: string): SafeTxServiceError {
  return new SafeTxServiceError(
    'invalid-response',
    `Safe Transaction Service sent an unexpected ${what} response: ${why}`,
  );
}

function asRecord(value: unknown, what: string): Record<string, unknown> {
  if (typeof value !== 'object' || value === null || Array.isArray(value)) {
    throw invalid(what, 'not an object');
  }
  return value as Record<string, unknown>;
}

function str(record: Record<string, unknown>, key: string): string {
  const value = record[key];
  if (typeof value !== 'string') throw invalid(key, 'not a string');
  return value;
}

function num(record: Record<string, unknown>, key: string): number {
  const value = record[key];
  if (typeof value !== 'number' || !Number.isInteger(value)) throw invalid(key, 'not an integer');
  return value;
}

function addr(record: Record<string, unknown>, key: string): Address {
  const value = str(record, key);
  if (!isAddress(value, { strict: false })) throw invalid(key, 'not an address');
  return value;
}

function addrs(record: Record<string, unknown>, key: string): Address[] {
  const value = record[key];
  if (!Array.isArray(value)) throw invalid(key, 'not an array');
  return value.map((item) => {
    if (typeof item !== 'string' || !isAddress(item, { strict: false })) {
      throw invalid(key, 'contains a non-address');
    }
    return item;
  });
}
