import { RpcError, redact } from './errors.js';

/** Minimal JSON-RPC 2.0 client over fetch. Every error message has the URL redacted. */
export class JsonRpc {
  private id = 0;
  constructor(
    private readonly url: string,
    private readonly extraSecrets: string[] = [],
  ) {}

  private clean(text: string): string {
    return redact(text, [this.url, ...this.extraSecrets]);
  }

  async call<T>(method: string, params: unknown[]): Promise<T> {
    let res: Response;
    try {
      res = await fetch(this.url, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: ++this.id, method, params }),
        signal: AbortSignal.timeout(30_000),
      });
    } catch (e) {
      throw new RpcError(
        this.clean(
          `RPC request ${method} failed: ${(e as Error).message}${(e as { cause?: Error }).cause ? ` (${(e as { cause: Error }).cause.message})` : ''}`,
        ),
      );
    }
    if (!res.ok)
      throw new RpcError(this.clean(`RPC request ${method} failed with HTTP ${res.status}`));
    let body: { result?: T; error?: { message?: string; code?: number } };
    try {
      body = (await res.json()) as typeof body;
    } catch {
      throw new RpcError(`RPC request ${method} returned something that is not JSON`);
    }
    if (body.error)
      throw new RpcError(
        this.clean(
          `RPC ${method} error: ${body.error.message ?? 'unknown'} (code ${body.error.code ?? '?'})`,
        ),
      );
    if (body.result === undefined) throw new RpcError(`RPC ${method} returned no result`);
    return body.result;
  }
}
