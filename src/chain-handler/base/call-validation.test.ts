import { describe, expect, it } from 'vitest';

import type { EvmCall } from '../../domain/call.js';
import { validateEvmCall } from './call-validation.js';

const VALID: EvmCall = { to: '0x000000000000000000000000000000000000dEaD', data: '0x', value: '0' };

describe('validateEvmCall', () => {
  it('accepts a well-formed call', () => {
    expect(validateEvmCall(VALID)).toEqual({ ok: true, value: undefined });
  });

  it('rejects a malformed to address', () => {
    const result = validateEvmCall({ ...VALID, to: 'not-an-address' });
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });

  it('rejects data that is not a well-formed hex string', () => {
    const result = validateEvmCall({ ...VALID, data: 'not-hex' });
    expect(result.ok).toBe(false);
  });

  it('rejects an odd-length hex data string', () => {
    const result = validateEvmCall({ ...VALID, data: '0xabc' });
    expect(result.ok).toBe(false);
  });

  it('rejects a negative value', () => {
    const result = validateEvmCall({ ...VALID, value: '-1' });
    expect(result.ok).toBe(false);
  });

  it('rejects a non-numeric value', () => {
    const result = validateEvmCall({ ...VALID, value: 'not-a-number' });
    expect(result.ok).toBe(false);
  });

  it('accepts arbitrary non-empty calldata (a raw contract call, issue 05)', () => {
    const result = validateEvmCall({ ...VALID, data: '0xa9059cbb00112233' });
    expect(result.ok).toBe(true);
  });
});
