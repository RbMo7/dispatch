import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import type { TokenKind } from '../domain/flagRules';
import { type ApiClient, createApiClient } from './api/client';

const SESSION_KEY = 'dispatch-session';

/** The token and which of the engine's two it is, read from `GET /v1/token` at sign-in. */
export interface Credentials {
  token: string;
  kind: TokenKind;
}

interface Session {
  api: ApiClient;
  /** ADR-0057: only an OPERATOR_TOKEN session shows Held, Flag Rules and Activity, or calls their routes. */
  operator: boolean;
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

function readCredentials(): Credentials | null {
  try {
    const stored = JSON.parse(sessionStorage.getItem(SESSION_KEY) ?? 'null') as unknown;
    if (typeof stored !== 'object' || stored === null) return null;
    const { token, kind } = stored as Record<string, unknown>;
    return typeof token === 'string' && (kind === 'auth' || kind === 'operator')
      ? { token, kind }
      : null;
  } catch {
    return null;
  }
}

function writeCredentials(credentials: Credentials | null): void {
  try {
    if (credentials) sessionStorage.setItem(SESSION_KEY, JSON.stringify(credentials));
    else sessionStorage.removeItem(SESSION_KEY);
  } catch {
    // Storage blocked: the token lives for this page view only.
  }
}

/**
 * The bearer token, kept in `sessionStorage` so closing the tab forgets it.
 * Without one, `signIn` renders instead of the console.
 */
export function SessionProvider({
  children,
  signIn,
}: {
  children: ReactNode;
  /** `notice` says why the viewer is back here, when the engine refused a token mid-session. */
  signIn: (accept: (credentials: Credentials) => void, notice: string | null) => ReactNode;
}) {
  const [credentials, setCredentials] = useState(readCredentials);
  const [expired, setExpired] = useState(false);

  const signOut = useCallback(() => {
    writeCredentials(null);
    setCredentials(null);
  }, []);

  const session = useMemo<Session | null>(
    () =>
      credentials
        ? {
            api: createApiClient(credentials.token, () => {
              setExpired(true);
              signOut();
            }),
            operator: credentials.kind === 'operator',
            signOut,
          }
        : null,
    [credentials, signOut],
  );

  if (!session) {
    return signIn(
      (next) => {
        writeCredentials(next);
        setExpired(false);
        setCredentials(next);
      },
      expired ? 'The engine refused the token. Sign in again.' : null,
    );
  }
  return <SessionContext.Provider value={session}>{children}</SessionContext.Provider>;
}

export function useSession(): Session {
  const session = useContext(SessionContext);
  if (!session) throw new Error('useSession outside SessionProvider');
  return session;
}

export function useApi(): ApiClient {
  return useSession().api;
}

export function useOperator(): boolean {
  return useSession().operator;
}
