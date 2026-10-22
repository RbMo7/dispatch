import { createPublicClient, http } from 'viem';
import { describe, expect, it } from 'vitest';

import { err } from '../../../domain/result.js';
import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_RPC_URL } from '../test-support/base-fixtures.js';
import { SafeApproval } from './safe-approval.js';
import { SafeTxServiceClient } from './tx-service-client.js';

/**
 * Live, read-only (ADR-0013, #84): `readProposal` against the real Base Sepolia
 * 1.4.1 Safe from spike #79, reading the public Safe Transaction Service and the
 * public RPC. POSTs nothing, spends nothing, needs no keys. The proposals read
 * are the spike's own, executed or superseded forever.
 */
const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const DELEGATE = '0x2d0b8242f5675eb51965488AC3C2f4038Ad8658E';

function liveApproval() {
  const service = new SafeTxServiceClient({
    baseUrl: 'https://api.safe.global/tx-service/basesep',
  });
  return new SafeApproval({
    config: {
      safeAddress: SAFE,
      executorAddress: DELEGATE,
      txServiceUrl: '',
      apiKey: undefined,
      approvalDeadlineMs: 1,
      approvalRewatchWindowMs: 1,
      bundleLimit: 50,
    },
    chainId: BASE_SEPOLIA_CHAIN_ID,
    client: createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) }),
    signer: {
      signSafeTransaction: () =>
        Promise.resolve(err({ code: 'SIGNER_REFUSED', message: 'read only' })),
    },
    service,
    knownTokens: {},
    prepare: () => Promise.reject(new Error('read only')),
  });
}

describe('readProposal against the real Base Sepolia Safe', () => {
  it('reads an executed MultiSend proposal (nonce 6) as executed, with its Ethereum transaction', async () => {
    const read = await liveApproval().readProposal({
      kind: 'safe',
      safe: SAFE,
      safeTxHash: '0xd3d1b26b7b7c079cf6f732d79d35d120271145737390acd3bc58e199e05da5c1',
      nonce: 6,
    });
    expect(read).toMatchObject({
      ok: true,
      value: {
        status: 'executed',
        executedHash: '0x9736b16c5d2d72804b9745118564f436d427b291ae30df345bdc7d5d59b69edf',
        threshold: 2,
      },
    });
  }, 60_000);

  it('reads a proposal beaten to its nonce by an executed rejection (nonce 1) as rejected', async () => {
    const read = await liveApproval().readProposal({
      kind: 'safe',
      safe: SAFE,
      safeTxHash: '0x06588bd96b02f54bac2b85482abb317eb48f87046f8a5d30c8904f25e8f0c360',
      nonce: 1,
    });
    expect(read).toMatchObject({ ok: true, value: { status: 'rejected', executable: false } });
  }, 60_000);
});
