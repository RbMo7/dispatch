import { createPublicClient, http } from 'viem';
import { describe, expect, it } from 'vitest';

import { BASE_SEPOLIA_CHAIN_ID, BASE_SEPOLIA_RPC_URL } from '../test-support/base-fixtures.js';
import { readSafeState } from './safe-reads.js';
import { resolveBaseSafeConfig } from './safe-config.js';
import { runSafeStartupChecks, SafeStartupError } from './startup-checks.js';
import { SafeTxServiceClient } from './tx-service-client.js';

/**
 * Live, read-only (ADR-0013): the startup checks against the real Base
 * Sepolia 1.4.1 Safe from spike #79, the public Safe Transaction Service
 * and the public RPC. Spends nothing and needs no keys; the Signer is the
 * one fake, since the executor's key is not ours to hold here.
 */
const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
/** Registered as a delegate of that Safe in the spike; not an owner. */
const DELEGATE = '0x2d0b8242f5675eb51965488AC3C2f4038Ad8658E';
const OWNER = '0xE3372Dbf65B13291094F0A3520cb03dB155d8586';

const raw = {
  senderMode: 'safe',
  senderAddress: '',
  safeAddress: SAFE,
  safeExecutorAddress: DELEGATE,
  txServiceUrl: '',
  apiKey: '',
  approvalDeadlineMs: '',
  approvalRewatchWindowMs: '',
};

function liveDeps(executor: string) {
  const config = resolveBaseSafeConfig(
    { ...raw, safeExecutorAddress: executor },
    BASE_SEPOLIA_CHAIN_ID,
  )!;
  const client = createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) });
  return {
    config,
    chainId: BASE_SEPOLIA_CHAIN_ID,
    service: new SafeTxServiceClient({ baseUrl: config.txServiceUrl }),
    readSafe: (address: `0x${string}`) => readSafeState(client, address),
    readSignerPins: () =>
      Promise.resolve({
        kind: 'pins' as const,
        pins: {
          address: executor,
          curve: 'secp256k1' as const,
          allowedSafe: config.safeAddress.toLowerCase(),
          chainIds: [BASE_SEPOLIA_CHAIN_ID],
        },
      }),
  };
}

describe('Safe startup checks against the real Base Sepolia Safe', () => {
  it('reads the 1.4.1 Safe and passes for its registered delegate, warning only about the missing API key', async () => {
    const state = await readSafeState(
      createPublicClient({ transport: http(BASE_SEPOLIA_RPC_URL) }),
      SAFE,
    );
    expect(state).toMatchObject({
      hasCode: true,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      version: '1.4.1',
      threshold: 2,
    });
    expect(state.owners).toHaveLength(3);

    const { warnings } = await runSafeStartupChecks(liveDeps(DELEGATE));
    expect(warnings).toEqual([expect.stringMatching(/BASE_SAFE_API_KEY is not set/)]);
  }, 60_000);

  it('refuses an owner as executor, and an unregistered address', async () => {
    const owner = await runSafeStartupChecks(liveDeps(OWNER)).catch((e: unknown) => e);
    expect(owner).toBeInstanceOf(SafeStartupError);
    expect((owner as SafeStartupError).failures.map((f) => f.check)).toContain(
      'executor is not an owner',
    );

    const stranger = await runSafeStartupChecks(
      liveDeps('0x0000000000000000000000000000000000000002'),
    ).catch((e: unknown) => e);
    expect((stranger as SafeStartupError).failures.map((f) => f.check)).toContain(
      'executor is a registered delegate',
    );
  }, 60_000);
});
