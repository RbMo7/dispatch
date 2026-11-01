import type { Chain } from '../domain/chain.js';
import type { Fix } from './check.js';

const URL_PATTERN = /\b[a-z][a-z0-9+.-]*:\/\/[^\s"'<>]+/gi;

/** A URL's host only: its path, query and credentials can hold an API key or a password. */
export function hostOf(url: string): string {
  try {
    return new URL(url).host || 'an unnamed host';
  } catch {
    return 'an unparseable URL';
  }
}

/** The first line of an error, with every URL in it cut down to its host, so no finding repeats a secret a URL carried. */
export function errorText(cause: unknown): string {
  const message = cause instanceof Error ? cause.message : String(cause);
  return redactUrls(message.split('\n')[0] ?? '').slice(0, 200);
}

export function redactUrls(text: string): string {
  return text.replace(URL_PATTERN, (url) => hostOf(url));
}

export const CHAIN_NAMES: Record<Chain, string> = { solana: 'Solana', base: 'Base' };

/** A check that could not read what it checks says so, as a warning, with the fix for the read. */
export function notCheckedFinding(why: string): string {
  return `not checked: ${why}`;
}

export function rpcVariable(chain: Chain): string {
  return chain === 'solana' ? 'SOLANA_RPC_URL' : 'BASE_RPC_URL';
}

export function rpcFix(chain: Chain): Fix {
  return {
    setting: rpcVariable(chain),
    value:
      chain === 'solana'
        ? 'an RPC URL that answers, such as https://api.devnet.solana.com'
        : 'an RPC URL that answers, such as https://sepolia.base.org',
  };
}
