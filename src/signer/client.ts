import { hexToNumber, recoverAddress, size, slice, type Address, type Hex } from 'viem';

import type { Chain } from '../domain/chain.js';
import type { Curve } from '../domain/curve.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { DEFAULT_RPC_TIMEOUT_MS } from '../rpc-timeout.js';
import { safeTransactionHash, type SafeTransaction } from './safe-transaction.js';

export type SafeSignRequest = {
  chain: Chain;
  /** The signing key's address: the delegate or executor, not the Safe. */
  address: Address;
  safeTransaction: SafeTransaction;
};

export type SignRequest = {
  chain: Chain;
  curve: Curve;
  address: string;
  /** ADR-0046: base64 of the chain's whole unsigned transaction, never a pre-computed hash, so the Signer can decode and police what it signs. */
  unsignedTransaction: string;
};

export type SignResponse = {
  signature: string;
};

/** ADR-0055: what the Signer says a key is pinned to. Each pin is present only when set; EVM addresses come back lowercase. */
export type SignerPins = {
  address: string;
  curve: Curve;
  chainIds?: number[];
  allowedSafe?: string;
  allowedMultisig?: string;
};

/**
 * The answer to a policy read. `no-key` is the Signer's own "no key for
 * address" 404; any other 404 is a Signer without the route (`old-signer`),
 * which must not read as a missing key, so the operator is told to upgrade it.
 */
export type PolicyRead =
  | { kind: 'pins'; pins: SignerPins }
  | { kind: 'no-key' }
  | { kind: 'old-signer' }
  /** `status` is the Signer's HTTP status when it answered with an error, so a refused token (401) can be told from a Signer that is down. */
  | { kind: 'unreachable'; message: string; status?: number };

/**
 * The engine's only way to reach a Signer (ADR-0002): a single concrete
 * client, no interface layered on top (ADR-0012) — the real variability in
 * signing backends already lives on the other side of this HTTP boundary,
 * not in how the engine calls it. Plain constructor injection (ADR-0014).
 */
export class SignerClient {
  constructor(
    private readonly signerUrl: string,
    /** ADR-0046: sent as a bearer token. Unset only on a deployment that never signs; the Signer then answers 401. */
    private readonly authToken: string | undefined,
    /** issue 15: aborts the request past this deadline rather than letting a hung Signer block the caller forever — see rpc-timeout.ts. */
    private readonly timeoutMs: number = DEFAULT_RPC_TIMEOUT_MS,
  ) {}

  /**
   * ADR-0055: asks the Signer what `address` is pinned to, never getting a signature. The engine
   * reads it at startup for a Multisig Sender; it is a check against misconfiguration, since a
   * compromised Signer could report anything.
   */
  async readPins(address: string): Promise<PolicyRead> {
    let response: Response;
    try {
      response = await fetch(`${this.signerUrl}/keys/${encodeURIComponent(address)}/policy`, {
        headers: this.authToken === undefined ? {} : { authorization: `Bearer ${this.authToken}` },
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      const detail = cause instanceof Error ? cause.message : String(cause);
      return {
        kind: 'unreachable',
        message: `failed to reach signer at ${this.signerUrl}: ${detail}`,
      };
    }
    const text = await response.text().catch(() => '');
    if (response.status === 404) {
      return /^\{"error":"no key for address /.test(text)
        ? { kind: 'no-key' }
        : { kind: 'old-signer' };
    }
    if (!response.ok) {
      return {
        kind: 'unreachable',
        message: `signer responded with ${response.status}`,
        status: response.status,
      };
    }
    const pins = parsePins(text);
    return pins
      ? { kind: 'pins', pins }
      : { kind: 'unreachable', message: 'signer answered a policy read with an unreadable body' };
  }

  async requestSignature(request: SignRequest): Promise<Result<SignResponse, DispatchError>> {
    return this.post(request);
  }

  /**
   * ADR-0052: the Signer signs a Safe transaction's EIP-712 hash itself,
   * from the fields. The signature comes back as 0x-hex `r || s || v` with
   * `v` 27 or 28, as the Safe Transaction Service requires, and is only
   * returned once it recovers to `address` over the hash the engine computed
   * itself, as for a transaction (ADR-0046).
   */
  async signSafeTransaction(request: SafeSignRequest): Promise<Result<Hex, DispatchError>> {
    const signed = await this.post({
      kind: 'safeTransaction',
      chain: request.chain,
      curve: 'secp256k1',
      address: request.address,
      safeTransaction: request.safeTransaction,
    });
    if (!signed.ok) return signed;

    const signature: Hex = `0x${Buffer.from(signed.value.signature, 'base64').toString('hex')}`;
    const hash = safeTransactionHash(request.safeTransaction);
    const wrong = (message: string, chainDetail?: unknown): Result<Hex, DispatchError> =>
      err({ code: 'SIGNER_UNREACHABLE', message, chainDetail });
    // Anything but 27/28 is a signature the Transaction Service would reject.
    if (size(signature) !== 65 || ![27, 28].includes(hexToNumber(slice(signature, 64)))) {
      return wrong(
        'signer returned a Safe signature that is not 65 bytes r || s || v with v 27 or 28',
      );
    }
    let recovered: Address;
    try {
      recovered = await recoverAddress({ hash, signature });
    } catch (cause) {
      return wrong(
        'signer returned a signature that recovers to no address',
        cause instanceof Error ? cause.message : cause,
      );
    }
    if (recovered.toLowerCase() !== request.address.toLowerCase()) {
      return wrong(`signer returned a signature for ${recovered}, expected ${request.address}`);
    }
    return ok(signature);
  }

  private async post(payload: unknown): Promise<Result<SignResponse, DispatchError>> {
    let response: Response;
    try {
      response = await fetch(new URL('/sign', this.signerUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authToken === undefined ? {} : { authorization: `Bearer ${this.authToken}` }),
        },
        body: JSON.stringify(payload),
        signal: AbortSignal.timeout(this.timeoutMs),
      });
    } catch (cause) {
      return err({
        code: 'SIGNER_UNREACHABLE',
        message: `failed to reach signer at ${this.signerUrl}`,
        chainDetail: cause instanceof Error ? cause.message : cause,
      });
    }

    if (!response.ok) return err(await signerFailure(response));

    let body: SignResponse;
    try {
      body = (await response.json()) as SignResponse;
    } catch (cause) {
      return err({
        code: 'SIGNER_UNREACHABLE',
        message: 'signer responded with an unparsable body',
        chainDetail: cause instanceof Error ? cause.message : cause,
      });
    }

    return ok(body);
  }
}

/**
 * ADR-0046: only a 403 whose body is the Signer's own `{ error, reason }`
 * is a deliberate policy refusal. Any other 403 may come from a proxy or
 * WAF in front of it, so it joins 401, 5xx and the rest as the Signer
 * being unusable, which the caller may retry.
 */
async function signerFailure(response: Response): Promise<DispatchError> {
  const text = await response.text().catch(() => undefined);
  const refusal = response.status === 403 ? parseRefusal(text) : undefined;
  if (refusal) {
    return {
      code: 'SIGNER_REFUSED',
      message: `signer refused: ${refusal.reason}`,
      chainDetail: refusal,
    };
  }
  return {
    code: 'SIGNER_UNREACHABLE',
    message: `signer responded with ${response.status}`,
    chainDetail: text,
  };
}

function parseRefusal(text: string | undefined): { error: string; reason: string } | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text ?? '');
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const { error, reason } = body as Record<string, unknown>;
  return typeof error === 'string' && typeof reason === 'string' ? { error, reason } : undefined;
}

function parsePins(text: string): SignerPins | undefined {
  let body: unknown;
  try {
    body = JSON.parse(text);
  } catch {
    return undefined;
  }
  if (typeof body !== 'object' || body === null) return undefined;
  const { address, curve, chainIds, allowedSafe, allowedMultisig } = body as Record<
    string,
    unknown
  >;
  if (typeof address !== 'string' || (curve !== 'secp256k1' && curve !== 'ed25519'))
    return undefined;
  if (
    chainIds !== undefined &&
    !(Array.isArray(chainIds) && chainIds.every((id) => Number.isSafeInteger(id)))
  ) {
    return undefined;
  }
  if (allowedSafe !== undefined && typeof allowedSafe !== 'string') return undefined;
  if (allowedMultisig !== undefined && typeof allowedMultisig !== 'string') return undefined;
  return {
    address,
    curve,
    ...(chainIds !== undefined ? { chainIds: chainIds as number[] } : {}),
    ...(allowedSafe !== undefined ? { allowedSafe } : {}),
    ...(allowedMultisig !== undefined ? { allowedMultisig } : {}),
  };
}
