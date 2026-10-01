import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import {
  keccak256,
  recoverTransactionAddress,
  type Hex,
  type TransactionSerializedEIP1559,
} from 'viem';
import { generatePrivateKey, privateKeyToAccount, sign } from 'viem/accounts';
import { afterEach, describe, expect, it } from 'vitest';

import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { SignerClient } from '../../signer/client.js';
import { BaseChainHandler } from './base-chain-handler.js';
import { encodeUnsignedTransaction } from './transaction-codec.js';

const CHAIN_ID = 84532;
const CONFIRMED_NONCE = 7;
const TOKEN = 'test-token';

/** Answers only what `BaseChainHandler.create` reads: the chain ID and the Sender's nonce. */
const fakeRpc: typeof fetch = (_input, init) => {
  const request = JSON.parse(init?.body as string) as { id: number; method: string };
  const result =
    request.method === 'eth_chainId'
      ? `0x${CHAIN_ID.toString(16)}`
      : `0x${CONFIRMED_NONCE.toString(16)}`;
  return Promise.resolve(
    new Response(JSON.stringify({ jsonrpc: '2.0', id: request.id, result }), {
      headers: { 'content-type': 'application/json' },
    }),
  );
};

/** A Signer on ADR-0046's contract that keccak-hashes the payload and signs it with `privateKey`, whatever address it is asked for. */
async function startSigner(privateKey: Hex): Promise<Server> {
  const server = createServer((req, res) => {
    const chunks: Buffer[] = [];
    req.on('data', (chunk: Buffer) => chunks.push(chunk));
    req.on('end', () => {
      void (async () => {
        const body = JSON.parse(Buffer.concat(chunks).toString('utf8')) as {
          unsignedTransaction: string;
        };
        const hash = keccak256(Buffer.from(body.unsignedTransaction, 'base64'));
        const { r, s, yParity } = await sign({ hash, privateKey, to: 'object' });
        const signature = Buffer.concat([
          Buffer.from(r.slice(2).padStart(64, '0'), 'hex'),
          Buffer.from(s.slice(2).padStart(64, '0'), 'hex'),
          Buffer.from([yParity ?? 0]),
        ]);
        res.writeHead(200, { 'content-type': 'application/json' });
        res.end(JSON.stringify({ signature: signature.toString('base64') }));
      })();
    });
  });
  await new Promise<void>((resolve) => server.listen(0, '127.0.0.1', resolve));
  return server;
}

describe('BaseChainHandler.sign verifies the Signer’s signature (ADR-0046)', () => {
  const senderKey = generatePrivateKey();
  const sender = privateKeyToAccount(senderKey);
  let server: Server | undefined;

  afterEach(async () => {
    await new Promise((resolve) => server?.close(resolve));
  });

  async function signWith(signingKey: Hex) {
    server = await startSigner(signingKey);
    const { port } = server.address() as AddressInfo;
    const handler = await BaseChainHandler.create({
      rpcUrl: 'http://rpc.invalid',
      chainId: CHAIN_ID,
      senderAddress: sender.address,
      signerClient: new SignerClient(`http://127.0.0.1:${port}`, TOKEN),
      nonceHistoryStore: new InMemoryNonceHistoryStore(),
      fetch: fakeRpc,
    });
    const unsignedTransaction = encodeUnsignedTransaction({
      senderAddress: sender.address,
      chainId: CHAIN_ID,
      nonce: null,
      to: sender.address,
      value: '0',
      data: '0x',
      gas: '21000',
      maxFeePerGas: '1000000000',
      maxPriorityFeePerGas: '1000000',
      preparedId: 'prepared-1',
    });
    const signed = await handler.sign({ callIndex: 0, unsignedTransaction }, sender.address);
    return { handler, signed };
  }

  it('accepts a signature by the Sender’s own key over the hashed unsigned serialization', async () => {
    const { handler, signed } = await signWith(senderKey);

    expect(signed.ok).toBe(true);
    if (!signed.ok) return;
    const recovered = await recoverTransactionAddress({
      serializedTransaction: signed.value as TransactionSerializedEIP1559,
    });
    expect(recovered).toBe(sender.address);
    expect(handler.peekNextNonce()).toBe(CONFIRMED_NONCE + 1);
  });

  it('refuses a signature by another key as SIGNER_UNREACHABLE and hands its nonce back', async () => {
    const otherKey = generatePrivateKey();
    const { handler, signed } = await signWith(otherKey);

    expect(!signed.ok && signed.error).toEqual({
      code: 'SIGNER_UNREACHABLE',
      message: `signer returned a signature for ${privateKeyToAccount(otherKey).address}, expected ${sender.address}`,
    });
    expect(handler.peekNextNonce()).toBe(CONFIRMED_NONCE);
  });
});
