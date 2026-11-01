import { createContext, type ReactNode, useCallback, useContext, useMemo, useState } from 'react';

import { type ApiClient, createApiClient } from './api/client';

const TOKEN_KEY = 'dispatch-token';

interface Session {
  api: ApiClient;
  signOut: () => void;
}

const SessionContext = createContext<Session | null>(null);

function readToken(): string | null {
  try {
    return sessionStorage.getItem(TOKEN_KEY);
  } catch {
    return null;
  }
}

function writeToken(token: string | null): void {
  try {
    if (token) sessionStorage.setItem(TOKEN_KEY, token);
    else sessionStorage.removeItem(TOKEN_KEY);
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
  signIn: (accept: (token: string) => void, notice: string | null) => ReactNode;
}) {
  const [token, setToken] = useState(readToken);
  const [expired, setExpired] = useState(false);

  const signOut = useCallback(() => {
    writeToken(null);
    setToken(null);
  }, []);

  const session = useMemo<Session | null>(
    () =>
      token
        ? {
            api: createApiClient(token, () => {
              setExpired(true);
              signOut();
            }),
            signOut,
          }
        : null,
    [token, signOut],
  );

  if (!session) {
    return signIn(
      (next) => {
        writeToken(next);
        setExpired(false);
        setToken(next);
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
