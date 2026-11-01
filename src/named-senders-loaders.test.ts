import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Keypair } from '@solana/web3.js';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { ChainRegistry } from './chain-registry/chain-registry.js';
import { StubChainHandler } from './chain-handler/stub-chain-handler.js';
import { FakeApproval } from './chain-handler/test-support/fake-approval.js';
import type { SenderAddress, SenderName } from './domain/sender.js';
import { registryFromConfig } from './asset-registry/configured-assets.js';

const saved = { ...process.env };

afterEach(() => {
  process.env = { ...saved };
  vi.resetModules();
});

const PAYOUTS = Keypair.generate().publicKey.toBase58();
const REFUNDS = Keypair.generate().publicKey.toBase58();
const MULTISIG = Keypair.generate().publicKey.toBase58();

async function loadWith(senders: unknown) {
  const dir = mkdtempSync(path.join(tmpdir(), 'senders-'));
  const file = path.join(dir, 'senders.json');
  writeFileSync(file, JSON.stringify(senders));
  Object.assign(process.env, {
    ENABLED_CHAINS: 'solana',
    SENDERS_FILE: file,
    SOLANA_RPC_URL: 'http://127.0.0.1:1',
    SOLANA_KNOWN_TOKENS: '',
    SOLANA_SENDER_ADDRESS: '',
    SOLANA_SENDER_MODE: '',
  });
  vi.resetModules();
  return import('./chain-loaders.js');
}

describe('loading named Senders (ADR-0060)', () => {
  it('builds one handler per Sender, keyed for the Coordinator by Sender, with the default as the chain handler', async () => {
    const loaders = await loadWith({
      solana: {
        default: 'payouts',
        senders: { payouts: { address: PAYOUTS }, refunds: { address: REFUNDS } },
      },
    });

    const registry = await loaders.loadChainRegistry(registryFromConfig());

    const [payouts, refunds] = registry.senders;
    expect(registry.senders.map((s) => [s.name, s.address, s.isDefault])).toEqual([
      ['payouts', PAYOUTS, true],
      ['refunds', REFUNDS, false],
    ]);
    expect(payouts?.handler).not.toBe(refunds?.handler);
    expect(registry.handlers.get('solana')).toBe(payouts?.handler);
    expect(loaders.coordinatorConfigFor(registry).senders.map((s) => s.ref)).toEqual([
      { chain: 'solana', address: PAYOUTS },
      { chain: 'solana', address: REFUNDS },
    ]);
    expect(loaders.signerKeysFor(registry)).toEqual([
      { chain: 'solana', address: PAYOUTS },
      { chain: 'solana', address: REFUNDS },
    ]);
  });

  it("runs each Sender's own startup checks, and a failure names the Sender", async () => {
    const loaders = await loadWith({
      solana: {
        senders: {
          payouts: { address: PAYOUTS },
          treasury: { mode: 'squads', multisig: MULTISIG, memberKey: MULTISIG },
        },
      },
    });

    await expect(loaders.loadChainRegistry(registryFromConfig())).rejects.toThrow(
      /^solana sender "treasury": invalid Solana multisig sender config:\n.*must be different addresses/,
    );
  });

  it("records the pins of each Sender's own signing key: a Multisig Sender's engine key", async () => {
    const { signerKeysFor } = await loadWith({});
    const multisig = new StubChainHandler();
    const approval = new FakeApproval<'base'>();
    approval.proposerAddress = '0xexecutor';
    Object.assign(multisig, { approval });
    const registry = ChainRegistry.fromSenders([
      {
        chain: 'base',
        name: 'payouts' as SenderName,
        address: '0xpayouts' as SenderAddress,
        isDefault: true,
        handler: new StubChainHandler(),
      },
      {
        chain: 'base',
        name: 'treasury' as SenderName,
        address: '0xsafe' as SenderAddress,
        isDefault: false,
        handler: multisig,
      },
    ]);

    expect(signerKeysFor(registry)).toEqual([
      { chain: 'base', address: '0xpayouts' },
      { chain: 'base', address: '0xexecutor' },
    ]);
  });
});
