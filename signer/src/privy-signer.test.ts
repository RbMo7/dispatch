import { randomBytes } from 'node:crypto';
import { mkdtempSync, writeFileSync } from 'node:fs';
import type { AddressInfo } from 'node:net';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { ed25519 } from '@noble/curves/ed25519.js';
import { Keypair, SystemProgram, TransactionMessage } from '@solana/web3.js';
import { keccak256, recoverAddress, serializeTransaction, toHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { createBackends } from './backends/index.js';
import { buildSigner } from './startup.js';

/** Privy's SDK, stood in for by wallets whose keys are local. */
const privy = vi.hoisted(() => ({
  evmKeys: new Map<string, Uint8Array>(),
  solanaKeys: new Map<string, import('@solana/web3.js').Keypair>(),
  addressOverrides: new Map<string, string>(),
  clients: [] as { appId: string; appSecret: string }[],
  signingInputs: [] as unknown[],
}));

vi.mock('@privy-io/node', async () => {
  const { secp256k1 } = await import('@noble/curves/secp256k1.js');
  const { VersionedTransaction } = await import('@solana/web3.js');
  const { privateKeyToAddress } = await import('viem/accounts');
  const { toHex } = await import('viem');

  function walletAddress(walletId: string): string {
    const override = privy.addressOverrides.get(walletId);
    if (override) return override;
    const evm = privy.evmKeys.get(walletId);
    if (evm) return privateKeyToAddress(toHex(evm));
    const solana = privy.solanaKeys.get(walletId);
    if (solana) return solana.publicKey.toBase58();
    throw new Error(`Privy: no wallet ${walletId}`);
  }

  class PrivyClient {
    constructor(options: { appId: string; appSecret: string }) {
      privy.clients.push(options);
    }
    wallets() {
      return {
        get: (walletId: string) => Promise.resolve({ address: walletAddress(walletId) }),
        ethereum: () => ({
          signSecp256k1: (walletId: string, input: { params: { hash: `0x${string}` } }) => {
            privy.signingInputs.push(input);
            const key = privy.evmKeys.get(walletId);
            if (!key) return Promise.reject(new Error(`Privy: no EVM wallet ${walletId}`));
            const hash = Buffer.from(input.params.hash.slice(2), 'hex');
            return Promise.resolve({
              encoding: 'hex',
              signature: toHex(secp256k1.sign(hash, key, { prehash: false })),
            });
          },
        }),
        solana: () => ({
          signTransaction: (walletId: string, input: { transaction: string }) => {
            privy.signingInputs.push(input);
            const keypair = privy.solanaKeys.get(walletId);
            if (!keypair) return Promise.reject(new Error(`Privy: no Solana wallet ${walletId}`));
            const transaction = VersionedTransaction.deserialize(
              Buffer.from(input.transaction, 'base64'),
            );
            transaction.sign([keypair]);
            return Promise.resolve({
              encoding: 'base64',
              signed_transaction: Buffer.from(transaction.serialize()).toString('base64'),
            });
          },
        }),
      };
    }
  }
  return { PrivyClient };
});

function writeJson(contents: unknown): string {
  const file = path.join(mkdtempSync(path.join(tmpdir(), 'signer-privy-')), 'config.json');
  writeFileSync(file, JSON.stringify(contents));
  return file;
}

function wallets() {
  const evmKey = randomBytes(32);
  const solana = Keypair.generate();
  privy.evmKeys.set('evm-wallet', evmKey);
  privy.solanaKeys.set('solana-wallet', solana);
  const evmAddress = privateKeyToAddress(toHex(evmKey));
  const solanaAddress = solana.publicKey.toBase58();
  const config = writeJson({
    [evmAddress]: { curve: 'secp256k1', backend: 'privy', keyRef: 'evm-wallet' },
    [solanaAddress]: { curve: 'ed25519', backend: 'privy', keyRef: 'solana-wallet' },
  });
  return { evmAddress, solanaAddress, solana, config };
}

const env = (overrides: Record<string, string | undefined>) => ({
  SIGNER_AUTH_TOKEN: 'test-token',
  PRIVY_APP_ID: 'app-id',
  PRIVY_APP_SECRET: 'app-secret',
  ...overrides,
});

async function listening(server: Awaited<ReturnType<typeof buildSigner>>) {
  await new Promise<void>((resolve) => server.listen(0, resolve));
  const { port } = server.address() as AddressInfo;
  return {
    sign: async (body: Record<string, unknown>) => {
      const response = await fetch(`http://127.0.0.1:${port}/sign`, {
        method: 'POST',
        headers: { authorization: 'Bearer test-token' },
        body: JSON.stringify(body),
      });
      return { status: response.status, body: (await response.json()) as Record<string, string> };
    },
    close: () => new Promise((resolve) => server.close(resolve)),
  };
}

afterEach(() => {
  privy.evmKeys.clear();
  privy.solanaKeys.clear();
  privy.addressOverrides.clear();
  privy.clients.length = 0;
  privy.signingInputs.length = 0;
});

describe('the Signer on Privy wallets', () => {
  it('signs an EVM transaction and a Solana message through Privy, each for its address', async () => {
    const { evmAddress, solanaAddress, solana, config } = wallets();
    const signer = await listening(await buildSigner(env({ SIGNER_CONFIG: config }), () => {}));

    try {
      const unsigned = serializeTransaction({
        type: 'eip1559',
        chainId: 84532,
        nonce: 0,
        to: privateKeyToAddress(toHex(randomBytes(32))),
        value: 1n,
        gas: 21_000n,
        maxFeePerGas: 2n,
        maxPriorityFeePerGas: 1n,
      });
      const evm = await signer.sign({
        chain: 'base',
        curve: 'secp256k1',
        address: evmAddress,
        unsignedTransaction: Buffer.from(unsigned.slice(2), 'hex').toString('base64'),
      });
      expect(evm.status).toBe(200);
      const signature = Buffer.from(evm.body.signature ?? '', 'base64');
      expect(signature).toHaveLength(65);
      expect(
        await recoverAddress({
          hash: keccak256(unsigned),
          signature: {
            r: toHex(signature.subarray(0, 32)),
            s: toHex(signature.subarray(32, 64)),
            yParity: signature[64] ?? 0,
          },
        }),
      ).toBe(evmAddress);

      const message = new TransactionMessage({
        payerKey: solana.publicKey,
        recentBlockhash: Keypair.generate().publicKey.toBase58(),
        instructions: [
          SystemProgram.transfer({
            fromPubkey: solana.publicKey,
            toPubkey: Keypair.generate().publicKey,
            lamports: 1,
          }),
        ],
      })
        .compileToV0Message()
        .serialize();
      const sol = await signer.sign({
        chain: 'solana',
        curve: 'ed25519',
        address: solanaAddress,
        unsignedTransaction: Buffer.from(message).toString('base64'),
      });
      expect(sol.status).toBe(200);
      expect(
        ed25519.verify(
          Buffer.from(sol.body.signature ?? '', 'base64'),
          message,
          solana.publicKey.toBytes(),
        ),
      ).toBe(true);
    } finally {
      await signer.close();
    }
  });

  it('refuses to start when a wallet has a different address, naming both', async () => {
    const { evmAddress, config } = wallets();
    const elsewhere = privateKeyToAddress(toHex(randomBytes(32)));
    privy.addressOverrides.set('evm-wallet', elsewhere);

    await expect(buildSigner(env({ SIGNER_CONFIG: config }))).rejects.toThrow(
      `${evmAddress}: expected ${evmAddress}, derived ${elsewhere}`,
    );
  });

  it('refuses to start when a wallet id is unknown to Privy', async () => {
    const { solanaAddress, config } = wallets();
    privy.solanaKeys.clear();

    await expect(buildSigner(env({ SIGNER_CONFIG: config }))).rejects.toThrow(
      `${solanaAddress}: Privy: no wallet solana-wallet`,
    );
  });

  it('builds its Privy client from PRIVY_APP_ID and PRIVY_APP_SECRET', async () => {
    const { config } = wallets();

    await buildSigner(env({ SIGNER_CONFIG: config }));

    expect(privy.clients).toEqual([{ appId: 'app-id', appSecret: 'app-secret' }]);
  });

  it.each([
    ['set', 'wallet-auth:key', { authorization_private_keys: ['wallet-auth:key'] }],
    ['unset', undefined, undefined],
  ])(
    'signs with PRIVY_AUTHORIZATION_KEY only when it is %s',
    async (_, authorizationKey, expected) => {
      const { evmAddress, config } = wallets();
      const signer = await listening(
        await buildSigner(
          env({ SIGNER_CONFIG: config, PRIVY_AUTHORIZATION_KEY: authorizationKey }),
          () => {},
        ),
      );

      try {
        const unsigned = serializeTransaction({
          type: 'eip1559',
          chainId: 84532,
          nonce: 0,
          gas: 21_000n,
          maxFeePerGas: 2n,
          maxPriorityFeePerGas: 1n,
        });
        await signer.sign({
          chain: 'base',
          curve: 'secp256k1',
          address: evmAddress,
          unsignedTransaction: Buffer.from(unsigned.slice(2), 'hex').toString('base64'),
        });
      } finally {
        await signer.close();
      }

      expect(privy.signingInputs).toHaveLength(1);
      expect((privy.signingInputs[0] as Record<string, unknown>).authorization_context).toEqual(
        expected,
      );
    },
  );
});

describe('createBackends for privy', () => {
  it.each([
    ['PRIVY_APP_ID', { PRIVY_APP_SECRET: 'secret' }],
    ['PRIVY_APP_SECRET', { PRIVY_APP_ID: 'app-id' }],
  ])('requires %s', (name, env) => {
    expect(() => createBackends(['privy'], env)).toThrow(
      `${name} is required by the privy backend`,
    );
  });

  it('asks nothing of Privy when no address uses it', () => {
    vi.spyOn(console, 'error').mockImplementation(() => {});
    const keyfile = writeJson({});

    expect(createBackends(['keyfile'], { SIGNER_KEYFILE: keyfile }).has('privy')).toBe(false);
    expect(privy.clients).toEqual([]);
    vi.restoreAllMocks();
  });
});
