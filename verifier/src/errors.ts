/** Bad arguments or a bad payment file: the CLI exits 2 and prints the message. */
export class UsageError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'UsageError';
  }
}

/** A chain read failed or returned something that is not what was expected: exit 2. */
export class RpcError extends Error {
  constructor(message: string) {
    super(message);
    this.name = 'RpcError';
  }
}

/**
 * RPC URLs often carry an API key in the host, path or query. Strip every
 * occurrence of the URL (and of its path and query, which hold the key) from
 * text that is about to be printed.
 */
export function redact(text: string, secrets: string[]): string {
  let out = text;
  for (const secret of secrets) {
    if (!secret) continue;
    out = out.split(secret).join('<rpc-url>');
    try {
      const u = new URL(secret);
      for (const part of [
        u.search.replace(/^\?/, ''),
        u.pathname.replace(/^\//, ''),
        u.username,
        u.password,
      ]) {
        if (part.length >= 4) out = out.split(part).join('<redacted>');
      }
    } catch {
      /* not a URL: the exact-match pass above is all there is */
    }
  }
  return out;
}
