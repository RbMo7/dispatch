import { createServer, type Server } from 'node:http';
import type { AddressInfo } from 'node:net';

import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChainRegistry } from './chain-registry/chain-registry.js';
import { StubChainHandler } from './chain-handler/stub-chain-handler.js';
import type { Chain } from './domain/chain.js';

const saved = { ...process.env };
let rpc: Server | undefined;

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
  rpc?.close();
  rpc = undefined;
});

async function senderConfigsWith(env: Record<string, string>, chains: Chain[] = ['base']) {
  Object.assign(process.env, env);
  vi.resetModules();
  const { senderConfigsFor } = await import('./chain-loaders.js');
  const registry = await ChainRegistry.load(
    chains,
    Object.fromEntries(
      chains.map((chain) => [chain, () => Promise.resolve(new StubChainHandler())]),
    ),
  );
  return () => senderConfigsFor(registry, () => undefined);
}

async function solanaRpcAnswering(genesisHash: string): Promise<string> {
  rpc = createServer((request, response) => {
    let body = '';
    request.on('data', (chunk: Buffer) => (body += chunk.toString()));
    request.on('end', () => {
      const { id } = JSON.parse(body) as { id: unknown };
      response.setHeader('content-type', 'application/json');
      response.end(JSON.stringify({ jsonrpc: '2.0', id, result: genesisHash }));
    });
  });
  await new Promise<void>((resolve) => rpc?.listen(0, '127.0.0.1', resolve));
  return `http://127.0.0.1:${(rpc.address() as AddressInfo).port}`;
}

const SOLANA_SENDER = { SOLANA_SENDER_ADDRESS: 'Sender1111111111111111111111111111111111111' };

describe('senderConfigsFor', () => {
  it('refuses to start when an enabled chain has no Sender address', async () => {
    const configs = await senderConfigsWith({ BASE_SENDER_ADDRESS: '', BASE_SENDER_MODE: '' });

    await expect(configs()).rejects.toThrow(/"base" is enabled but has no Sender address/);
  });

  it("reports an enabled chain's configured Sender and its network from the chain id", async () => {
    const configs = await senderConfigsWith({
      BASE_SENDER_ADDRESS: '0x1111111111111111111111111111111111111111',
      BASE_SENDER_MODE: '',
      BASE_CHAIN_ID: '8453',
    });

    expect(await configs()).toMatchObject([
      { chain: 'base', network: 'base', address: '0x1111111111111111111111111111111111111111' },
    ]);
  });

  it("names Solana's network from the RPC's genesis hash", async () => {
    const configs = await senderConfigsWith(
      {
        ...SOLANA_SENDER,
        SOLANA_RPC_URL: await solanaRpcAnswering('EtWTRABZaYq6iMfeYKouRu166VU2xqa1wcaWoxPkrZBG'),
      },
      ['solana'],
    );

    expect(await configs()).toMatchObject([{ chain: 'solana', network: 'devnet' }]);
  });

  it('starts with an unknown Solana network when the genesis hash read fails', async () => {
    const configs = await senderConfigsWith(
      { ...SOLANA_SENDER, SOLANA_RPC_URL: 'http://127.0.0.1:1' },
      ['solana'],
    );

    expect(await configs()).toMatchObject([{ chain: 'solana', network: 'unknown' }]);
  });
});
