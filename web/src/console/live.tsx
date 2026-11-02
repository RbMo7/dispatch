import {
  createContext,
  type ReactNode,
  useCallback,
  useContext,
  useEffect,
  useMemo,
  useRef,
  useState,
} from 'react';

import { ApiError } from './api/client';

/** About every 2 s while anything shown is in flight (spec.md, Live updates). */
export const IN_FLIGHT_MS = 2_000;
const SETTLED_FIRST_MS = 4_000;
const MAX_MS = 30_000;
export const SENDERS_MS = 15_000;

/**
 * The next wait: 2 s while anything is in flight; once all is terminal, double
 * from 4 s up to 30 s, so an idle console costs little but still sees new work.
 */
export function nextDelay(inFlight: boolean, previous: number): number {
  if (inFlight) return IN_FLIGHT_MS;
  return previous <= IN_FLIGHT_MS ? SETTLED_FIRST_MS : Math.min(MAX_MS, previous * 2);
}

/** After a failed request: 2, 4, 8 … 30 s. */
export function retryDelay(failures: number): number {
  return Math.min(MAX_MS, IN_FLIGHT_MS * 2 ** Math.max(0, failures - 1));
}

export type Connection = 'live' | 'reconnecting';

interface Live {
  connection: Connection;
  report: (ok: boolean) => void;
  /** Bumped by the refresh button: every poller loads again now. */
  tick: number;
  refresh: () => void;
}

const LiveContext = createContext<Live>({
  connection: 'live',
  report: () => {},
  tick: 0,
  refresh: () => {},
});

export function LiveProvider({ children }: { children: ReactNode }) {
  const [connection, setConnection] = useState<Connection>('live');
  const [tick, setTick] = useState(0);
  const report = useCallback((ok: boolean) => setConnection(ok ? 'live' : 'reconnecting'), []);
  const refresh = useCallback(() => setTick((t) => t + 1), []);
  const value = useMemo(
    () => ({ connection, report, tick, refresh }),
    [connection, report, tick, refresh],
  );
  return <LiveContext.Provider value={value}>{children}</LiveContext.Provider>;
}

export function useLive(): Live {
  return useContext(LiveContext);
}

export interface Polled<T> {
  data: T | undefined;
  error: ApiError | null;
  /** Load again now, outside the schedule. */
  reload: () => void;
}

interface PollOptions<T> {
  /** Changing the key drops the data and starts over. */
  key: string;
  load: (signal: AbortSignal) => Promise<T>;
  /** The wait before the next load, given what this one returned and the last wait. */
  delay: (data: T, previous: number) => number;
  enabled?: boolean;
}

/**
 * Loads now, then again on the delay the data asks for. Paused while the tab
 * is hidden; loads at once when it is shown again. A network or server
 * failure turns the shell's indicator to "Reconnecting" and retries with
 * backoff; a refused token signs out through the client instead.
 */
export function usePoll<T>({ key, load, delay, enabled = true }: PollOptions<T>): Polled<T> {
  const [state, setState] = useState<{ key: string; data: T | undefined; error: ApiError | null }>({
    key,
    data: undefined,
    error: null,
  });
  const { report, tick } = useLive();
  const loadRef = useRef(load);
  const delayRef = useRef(delay);
  loadRef.current = load;
  delayRef.current = delay;
  const kick = useRef<() => void>(() => {});

  useEffect(() => {
    if (!enabled) return;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let controller: AbortController | undefined;
    let wait = IN_FLIGHT_MS;
    let failures = 0;
    let stopped = false;

    const schedule = (ms: number) => {
      clearTimeout(timer);
      if (!stopped && !document.hidden) timer = setTimeout(() => void run(), ms);
    };

    async function run() {
      clearTimeout(timer);
      controller?.abort();
      const current = new AbortController();
      controller = current;
      try {
        const data = await loadRef.current(current.signal);
        if (current.signal.aborted || stopped) return;
        failures = 0;
        wait = delayRef.current(data, wait);
        setState({ key, data, error: null });
        report(true);
        schedule(wait);
      } catch (error) {
        if (current.signal.aborted || stopped) return;
        if (!(error instanceof ApiError)) throw error;
        if (error.failure.kind === 'unauthorized') return;
        failures += 1;
        setState((previous) => ({
          key,
          data: previous.key === key ? previous.data : undefined,
          error,
        }));
        if (error.failure.kind === 'unreachable') report(false);
        schedule(retryDelay(failures));
      }
    }

    const onVisibility = () => {
      if (document.hidden) clearTimeout(timer);
      else void run();
    };
    kick.current = () => void run();
    document.addEventListener('visibilitychange', onVisibility);
    void run();
    return () => {
      stopped = true;
      clearTimeout(timer);
      controller?.abort();
      document.removeEventListener('visibilitychange', onVisibility);
    };
  }, [key, enabled, report]);

  const first = useRef(true);
  useEffect(() => {
    if (first.current) {
      first.current = false;
      return;
    }
    kick.current();
  }, [tick]);

  const reload = useCallback(() => kick.current(), []);
  const current = state.key === key ? state : { data: undefined, error: null };
  return { data: current.data, error: current.error, reload };
}
