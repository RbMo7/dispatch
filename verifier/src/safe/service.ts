import { RpcError, redact } from '../errors.js';

/** The fields of a Safe Transaction Service multisig transaction that the verifier uses. */
export interface ServiceTx {
  safe: string;
  to: string;
  value: string;
  data: string | null;
  operation: number;
  safeTxGas: string | number;
  baseGas: string | number;
  gasPrice: string | number;
  gasToken: string;
  refundReceiver: string | null;
  nonce: string | number;
  safeTxHash: string;
  isExecuted: boolean;
  isSuccessful: boolean | null;
  confirmationsRequired?: number;
  confirmations?: unknown[] | null;
}

export interface ServiceClient {
  getTx(safeTxHash: string): Promise<ServiceTx | null>;
  listByNonce(safe: string, nonce: bigint): Promise<ServiceTx[]>;
}

/** Optional cross-check source (Safe Transaction Service REST). The hash check itself never needs it. */
export function httpService(baseUrl: string): ServiceClient {
  const base = baseUrl.replace(/\/+$/, '');
  const get = async (path: string): Promise<unknown> => {
    let res: Response;
    try {
      res = await fetch(`${base}${path}`, {
        headers: { accept: 'application/json' },
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new RpcError(
        redact(`Transaction Service request failed: ${(e as Error).message}`, [baseUrl]),
      );
    }
    if (res.status === 404) return null;
    if (!res.ok)
      throw new RpcError(
        redact(`Transaction Service answered HTTP ${res.status} for ${path}`, [baseUrl]),
      );
    return res.json();
  };
  return {
    async getTx(hash) {
      return (await get(`/api/v2/multisig-transactions/${hash}/`)) as ServiceTx | null;
    },
    async listByNonce(safe, nonce) {
      const body = (await get(`/api/v2/safes/${safe}/multisig-transactions/?nonce=${nonce}`)) as {
        results?: ServiceTx[];
      } | null;
      return body?.results ?? [];
    },
  };
}
