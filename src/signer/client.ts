import type { Chain } from '../domain/chain.js';
import type { Curve } from '../domain/curve.js';
import type { DispatchError } from '../domain/errors.js';
import { err, ok, type Result } from '../domain/result.js';

export type SignRequest = {
  chain: Chain;
  curve: Curve;
  address: string;
  unsignedTxBytes: string;
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
  constructor(private readonly signerUrl: string) {}

  async requestSignature(request: SignRequest): Promise<Result<SignResponse, DispatchError>> {
    let response: Response;
    try {
      response = await fetch(new URL('/sign', this.signerUrl), {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify(request),
      });
    } catch (cause) {
      return err({
        code: 'SIGNER_UNREACHABLE',
        message: `failed to reach signer at ${this.signerUrl}`,
        chainDetail: cause instanceof Error ? cause.message : cause,
      });
    }

    if (!response.ok) {
      return err({
        code: 'SIGNER_UNREACHABLE',
        message: `signer responded with ${response.status}`,
        chainDetail: await response.text().catch(() => undefined),
      });
    }

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
