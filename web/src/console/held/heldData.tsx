import { createContext, type ReactNode, useCallback, useContext } from 'react';

import { type Polled, SENDERS_MS, usePoll } from '../live';
import { walk, type Walk } from '../overview/overviewData';
import { useApi } from '../session';

const HeldContext = createContext<Polled<Walk> | null>(null);

/**
 * Every held Dispatch, oldest first: the review queue, the sidebar's count and
 * the Overview's oldest hold. `GET /v1/dispatches?status=held` takes either
 * token, so an AUTH_TOKEN session reads it too. A hold never moves on its own,
 * so this polls slowly; Release and Cancel reload it at once.
 */
export function HeldProvider({ children }: { children: ReactNode }) {
  const api = useApi();
  const load = useCallback(
    async (signal: AbortSignal): Promise<Walk> => {
      const held = await walk(api, { status: 'held', mode: 'managed' }, signal);
      return { ...held, rows: [...held.rows].reverse() };
    },
    [api],
  );
  const polled = usePoll({ key: 'held', load, delay: () => SENDERS_MS });
  return <HeldContext.Provider value={polled}>{children}</HeldContext.Provider>;
}

export function useHeld(): Polled<Walk> {
  const held = useContext(HeldContext);
  if (!held) throw new Error('useHeld outside HeldProvider');
  return held;
}
