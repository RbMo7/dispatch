import { useCallback } from 'react';

import type { Setup } from '../../domain/setup';
import { type Polled, usePoll } from '../live';
import { useApi } from '../session';

/** The worker records its checks every five minutes, so a slow poll misses little; the API's own checks run on each one. */
export const SETUP_MS = 30_000;

/** `GET /v1/setup`, for the Setup page and the Overview's Needs attention. */
export function useSetup(): Polled<Setup> {
  const api = useApi();
  const load = useCallback((signal: AbortSignal) => api.getSetup(signal), [api]);
  return usePoll({ key: 'setup', load, delay: () => SETUP_MS });
}
