import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';
import { afterAll, beforeAll, describe, expect, it } from 'vitest';

import { buildSigner } from '../../signer/src/startup.js';
import { buildApp } from '../app.js';
import {
  BASE_ABANDONMENT_TIMEOUT_MS,
  BaseChainHandler,
} from '../chain-handler/base/base-chain-handler.js';
import {
  BASE_SEPOLIA_CHAIN_ID,
  BASE_SEPOLIA_RPC_URL,
  getDevSenderAccount,
} from '../chain-handler/base/test-support/base-fixtures.js';
import { ChainRegistry } from '../chain-registry/chain-registry.js';
import { Coordinator } from '../coordinator/coordinator.js';
import { InMemoryDispatchStore } from '../repository/in-memory-dispatch-store.js';
import { InMemoryNonceHistoryStore } from '../repository/in-memory-nonce-history-store.js';
import { SignerClient } from './client.js';

const API_TOKEN = 'test-token';
const SIGNER_TOKEN = randomBytes(16).toString('hex');
const KEYS_DEV_JSON = fileURLToPath(new URL('../../signer/keys.dev.json', import.meta.url));

type AuditLine = { decision: string; status: number; reason?: string };
type GetBody = {
  status: string;
  items: { status: string; error: { code: string; message: string } | null }[];
};

/**
 * #49: a Signer policy refusal reported through the API, against real Base
 * Sepolia (ADR-0013). The real Signer (`buildSigner`, the keyfile backend
 * holding the dev Sender's key) allows one destination; a Managed Dispatch
 * paying anyone else is refused before signing, so the item fails with
 * SIGNER_REFUSED and nothing is broadcast. It only reads chain state (the
 * Funding Check, gas estimation, the Sender's nonce), so it spends nothing.
 */
describe('a Signer policy refusing a Managed Dispatch (real Base Sepolia)', () => {
  const sender = getDevSenderAccount();
  const allowed = privateKeyToAddress(generatePrivateKey());
  const audit: AuditLine[] = [];
  let signerUrl: string;
  let closeSigner: () => Promise<void>;

  beforeAll(async () => {
    const config = path.join(mkdtempSync(path.join(tmpdir(), 'policy-e2e-')), 'signer.config.json');
    writeFileSync(
      config,
      JSON.stringify({
        [sender.address]: {
          curve: 'secp256k1',
          backend: 'keyfile',
          keyRef: 'dev-sender',
          policy: { chainIds: [BASE_SEPOLIA_CHAIN_ID], allowedDestinations: [allowed] },
        },
      }),
    );
    const server = await buildSigner(
      { SIGNER_CONFIG: config, SIGNER_KEYFILE: KEYS_DEV_JSON, SIGNER_AUTH_TOKEN: SIGNER_TOKEN },
      (line) => audit.push(JSON.parse(line) as AuditLine),
    );
    await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
    signerUrl = `http://127.0.0.1:${(server.address() as AddressInfo).port}`;
    closeSigner = () => new Promise((resolve) => server.close(() => resolve()));
  });

  afterAll(async () => {
    await closeSigner?.();
  });

  it('fails the item with SIGNER_REFUSED and the Signer’s reason, broadcasting nothing', async () => {
    const recipient = privateKeyToAddress(generatePrivateKey());
    const handler = await BaseChainHandler.create({
      rpcUrl: BASE_SEPOLIA_RPC_URL,
      chainId: BASE_SEPOLIA_CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(signerUrl, SIGNER_TOKEN),
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
    });
    const store = new InMemoryDispatchStore();
    const chainRegistry = await ChainRegistry.load(['base'], {
      base: () => Promise.resolve(handler),
    });
    const app = buildApp({ store, chainRegistry, authToken: API_TOKEN, defaultRetryPolicy: false });

    const post = await app.inject({
      method: 'POST',
      url: '/v1/dispatch',
      headers: {
        authorization: `Bearer ${API_TOKEN}`,
        'idempotency-key': `policy-refused-${Date.now()}`,
      },
      payload: {
        chain: 'base',
        items: [{ type: 'payment', recipient, asset: 'ETH', amount: '1000' }],
      },
    });
    expect(post.statusCode).toBe(202);
    const { dispatchId } = post.json<{ dispatchId: string }>();

    const coordinator = new Coordinator({
      store,
      chainHandlers: chainRegistry.handlers,
      senderAddresses: new Map([['base', sender.address]]),
      abandonmentTimeoutMs: new Map([['base', BASE_ABANDONMENT_TIMEOUT_MS]]),
    });
    await coordinator.processQueuedDispatches(10);

    const get = await app.inject({
      method: 'GET',
      url: `/v1/dispatch/${dispatchId}`,
      headers: { authorization: `Bearer ${API_TOKEN}` },
    });
    const reason = `destination ${recipient.toLowerCase()} is not in allowedDestinations`;
    const [item] = get.json<GetBody>().items;
    expect(item?.status).toBe('failed');
    expect(item?.error?.code).toBe('SIGNER_REFUSED');
    expect(item?.error?.message).toContain(reason);
    // The Signer's only decision was this refusal, so there was never a signed transaction to send.
    expect(audit).toEqual([expect.objectContaining({ decision: 'refused', status: 403, reason })]);
    expect((await store.listTransactions(dispatchId)).map((t) => t.status)).toEqual(['FAILED']);
  }, 60_000);
});
