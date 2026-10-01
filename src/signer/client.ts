import type { Chain } from '../domain/chain.js';
import type { Curve } from '../domain/curve.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';
import { DEFAULT_RPC_TIMEOUT_MS } from '../rpc-timeout.js';

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

  async requestSignature(request: SignRequest): Promise<Result<SignResponse, DispatchError>> {
    let response: Response;
    try {
      response = await fetch(new URL('/sign', this.signerUrl), {
        method: 'POST',
        headers: {
          'content-type': 'application/json',
          ...(this.authToken === undefined ? {} : { authorization: `Bearer ${this.authToken}` }),
        },
        body: JSON.stringify(request),
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
