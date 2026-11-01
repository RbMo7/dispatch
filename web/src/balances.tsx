import { createContext, type ReactNode, useContext, useMemo, useState } from 'react';

const STORAGE_KEY = 'dispatch-hide-balances';

interface Balances {
  hidden: boolean;
  setHidden: (hidden: boolean) => void;
}

const BalancesContext = createContext<Balances>({ hidden: false, setHidden: () => {} });

function readHidden(): boolean {
  try {
    return localStorage.getItem(STORAGE_KEY) === '1';
  } catch {
    return false;
  }
}

export function BalancesProvider({ children }: { children: ReactNode }) {
  const [hidden, setState] = useState(readHidden);
  const value = useMemo<Balances>(
    () => ({
      hidden,
      setHidden(next) {
        setState(next);
        try {
          if (next) localStorage.setItem(STORAGE_KEY, '1');
          else localStorage.removeItem(STORAGE_KEY);
        } catch {
          // Storage blocked: the choice holds for this page view only.
        }
      },
    }),
    [hidden],
  );
  return <BalancesContext.Provider value={value}>{children}</BalancesContext.Provider>;
}

export function useBalances(): Balances {
  return useContext(BalancesContext);
}
