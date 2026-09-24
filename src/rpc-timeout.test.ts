import { describe, expect, it, vi } from 'vitest';

import { fetchWithTimeout } from './rpc-timeout.js';

describe('fetchWithTimeout', () => {
  it('passes the input and init through to the wrapped fetch, plus an abort signal', async () => {
    const inner: typeof fetch = vi.fn().mockResolvedValue(new Response('ok'));
    const wrapped = fetchWithTimeout(inner, 5_000);

    await wrapped('https://example.test/rpc', { method: 'POST', body: 'hi' });

    expect(inner).toHaveBeenCalledTimes(1);
    const [input, init] = vi.mocked(inner).mock.calls[0] ?? [];
    expect(input).toBe('https://example.test/rpc');
    expect(init).toMatchObject({ method: 'POST', body: 'hi' });
    expect(init?.signal).toBeInstanceOf(AbortSignal);
  });

  it('aborts the underlying call once timeoutMs elapses, rather than merely leaving it awaited', async () => {
    let observedSignal: AbortSignal | undefined;
    const inner = vi.fn().mockImplementation(
      (_input: Parameters<typeof fetch>[0], init?: Parameters<typeof fetch>[1]) =>
        new Promise((_resolve, reject) => {
          observedSignal = init?.signal ?? undefined;
          observedSignal?.addEventListener('abort', () => reject(observedSignal!.reason as Error));
        }),
    );
    const wrapped = fetchWithTimeout(inner, 10);

    await expect(wrapped('https://example.test/rpc')).rejects.toBeTruthy();
    expect(observedSignal?.aborted).toBe(true);
  });
});
