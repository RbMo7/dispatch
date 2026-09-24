import { describe, expect, it } from 'vitest';

import { isBlockhashExpiryMessage, mapSolanaFailure } from './error-mapping.js';

describe('mapSolanaFailure', () => {
  it('maps a rent-exemption / insufficient-lamports simulation failure to INSUFFICIENT_FUNDS', () => {
    // The exact real message devnet returned building issue 05.
    const cause = new Error(
      'Simulation failed. \nMessage: Transaction simulation failed: Transaction results in an account (1) with insufficient funds for rent. \nLogs: \n[]',
    );
    const mapped = mapSolanaFailure(cause);
    expect(mapped.code).toBe('INSUFFICIENT_FUNDS');
  });

  it('maps a rate-limit response to RPC_UNAVAILABLE', () => {
    const mapped = mapSolanaFailure(new Error('429 Too Many Requests'));
    expect(mapped.code).toBe('RPC_UNAVAILABLE');
  });

  it('maps a missing-account error to INVALID_RECIPIENT', () => {
    const mapped = mapSolanaFailure(new Error('TokenAccountNotFoundError: could not find account'));
    expect(mapped.code).toBe('INVALID_RECIPIENT');
  });

  it('falls back to CHAIN_REJECTED for an unrecognized failure, preserving the raw text', () => {
    const mapped = mapSolanaFailure(new Error('some never-seen-before program error'));
    expect(mapped.code).toBe('CHAIN_REJECTED');
    expect(mapped.chainDetail).toBe('some never-seen-before program error');
  });

  it('surfaces SendTransactionError-style logs in chainDetail when present', () => {
    const cause = Object.assign(new Error('Transaction simulation failed'), {
      logs: ['Program 1111 invoke [1]', 'Program 1111 failed: custom program error: 0x1'],
    });
    const mapped = mapSolanaFailure(cause);
    expect(mapped.chainDetail).toEqual({
      message: 'Transaction simulation failed',
      logs: ['Program 1111 invoke [1]', 'Program 1111 failed: custom program error: 0x1'],
    });
  });

  it('never throws for a non-Error cause', () => {
    expect(() => mapSolanaFailure('a plain string failure')).not.toThrow();
    expect(() => mapSolanaFailure({ weird: 'object' })).not.toThrow();
  });
});

describe('isBlockhashExpiryMessage', () => {
  it('recognizes devnet\'s real "Blockhash not found" wording', () => {
    expect(isBlockhashExpiryMessage('failed to send transaction: Blockhash not found')).toBe(true);
  });

  it('does not misclassify an unrelated failure', () => {
    expect(isBlockhashExpiryMessage('insufficient funds for rent')).toBe(false);
  });
});
