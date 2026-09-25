import { describe, expect, it } from 'vitest';

import { buildErc20TransferCall } from './erc20.js';

const TOKEN = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const RECIPIENT = '0x000000000000000000000000000000000000dEaD';

describe('buildErc20TransferCall', () => {
  it('encodes a transfer(address,uint256) call with the 0xa9059cbb selector', () => {
    const result = buildErc20TransferCall(TOKEN, RECIPIENT, 1_000_000n);
    expect(result.ok).toBe(true);
    if (!result.ok) return;
    expect(result.value.to).toBe(TOKEN);
    expect(result.value.value).toBe('0');
    expect(result.value.data.startsWith('0xa9059cbb')).toBe(true);
    // 4-byte selector + 32-byte recipient + 32-byte amount = 68 bytes = 136 hex chars + '0x'.
    expect(result.value.data).toHaveLength(2 + 136);
  });

  it('rejects a malformed recipient address', () => {
    const result = buildErc20TransferCall(TOKEN, 'not-an-address', 1_000_000n);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('INVALID_RECIPIENT');
  });

  it('rejects a malformed configured token contract address', () => {
    const result = buildErc20TransferCall('not-an-address', RECIPIENT, 1_000_000n);
    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('CHAIN_REJECTED');
  });
});
