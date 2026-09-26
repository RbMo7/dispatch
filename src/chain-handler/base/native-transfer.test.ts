import { describe, expect, it } from 'vitest';

import { buildNativeTransferCall } from './native-transfer.js';

const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

describe('buildNativeTransferCall', () => {
  it('builds a plain value transfer with no calldata', () => {
    const result = buildNativeTransferCall(RECIPIENT, '1000');
    expect(result).toEqual({ ok: true, value: { to: RECIPIENT, data: '0x', value: '1000' } });
  });

  it('rejects a malformed recipient address', () => {
    const result = buildNativeTransferCall('not-an-address', '1000');
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });
});
