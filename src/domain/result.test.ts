import { describe, expect, it } from 'vitest';

import { err, ok } from './result.js';

describe('ok', () => {
  it('produces a success result carrying the value', () => {
    const result = ok(42);

    expect(result).toEqual({ ok: true, value: 42 });
  });
});

describe('err', () => {
  it('produces a failure result carrying the error', () => {
    const result = err({ code: 'RPC_UNAVAILABLE', message: 'timed out' });

    expect(result).toEqual({
      ok: false,
      error: { code: 'RPC_UNAVAILABLE', message: 'timed out' },
    });
  });
});
