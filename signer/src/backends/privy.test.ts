import { randomBytes } from 'node:crypto';

import { ed25519 } from '@noble/curves/ed25519.js';
import { secp256k1 } from '@noble/curves/secp256k1.js';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  TransactionMessage,
  VersionedTransaction,
} from '@solana/web3.js';
import { bytesToBigInt, numberToBytes, toHex } from 'viem';
import { privateKeyToAddress } from 'viem/accounts';
import { describe, expect, it, vi } from 'vitest';

import { createPrivyApi, createPrivyBackend, type PrivyApi, type PrivySdk } from './privy.js';

const N = secp256k1.Point.CURVE().n;
const WALLET = 'privy-wallet-id';

/** A Privy stand-in that signs with a local key, as Privy's raw_sign does: 64 bytes `r || s`. */
function evmWallet(transform: (rs: Uint8Array) => Uint8Array = (rs) => rs) {
  const key = randomBytes(32);
  const api: PrivyApi = {
    walletAddress: vi.fn(() => Promise.resolve(privateKeyToAddress(toHex(key)))),
    rawSignHash: vi.fn((_walletId: string, hash: `0x${string}`) => {
      const signature = secp256k1.sign(Buffer.from(hash.slice(2), 'hex'), key, { prehash: false });
      return Promise.resolve(toHex(transform(signature)));
    }),
    signSolanaTransaction: () => Promise.reject(new Error('not a Solana wallet')),
  };
  return { key, api };
}

function expectedSignature(key: Uint8Array, digest: Uint8Array): Uint8Array {
  const recovered = secp256k1.sign(digest, key, { prehash: false, format: 'recovered' });
  return Uint8Array.from([...recovered.subarray(1), recovered[0] ?? 0]);
}

function withHighS(rs: Uint8Array): Uint8Array {
  const s = bytesToBigInt(rs.subarray(32, 64));
  return Uint8Array.from([...rs.subarray(0, 32), ...numberToBytes(N - s, { size: 32 })]);
}

/** A Privy stand-in for a Solana wallet: signs the transaction it is given, as Privy's signTransaction does. */
function solanaWallet(
  sign: (transaction: VersionedTransaction, keypair: Keypair) => void = (transaction, keypair) =>
    transaction.sign([keypair]),
) {
  const keypair = Keypair.generate();
  const api: PrivyApi = {
    walletAddress: vi.fn(() => Promise.resolve(keypair.publicKey.toBase58())),
    rawSignHash: () => Promise.reject(new Error('not an EVM wallet')),
    signSolanaTransaction: vi.fn((_walletId: string, base64: string) => {
      const transaction = VersionedTransaction.deserialize(Buffer.from(base64, 'base64'));
      sign(transaction, keypair);
      return Promise.resolve(Buffer.from(transaction.serialize()).toString('base64'));
    }),
  };
  return { keypair, api };
}

function transferMessage(payer: PublicKey, from: PublicKey, version: 'legacy' | 'v0'): Uint8Array {
  const message = new TransactionMessage({
    payerKey: payer,
    recentBlockhash: Keypair.generate().publicKey.toBase58(),
    instructions: [
      SystemProgram.transfer({
        fromPubkey: from,
        toPubkey: Keypair.generate().publicKey,
        lamports: 1,
      }),
    ],
  });
  return version === 'legacy'
    ? message.compileToLegacyMessage().serialize()
    : message.compileToV0Message().serialize();
}

describe('createPrivyBackend on secp256k1', () => {
  it("returns the wallet's address", async () => {
    const { key, api } = evmWallet();

    expect(await createPrivyBackend(api).address('secp256k1', WALLET)).toBe(
      privateKeyToAddress(toHex(key)),
    );
  });

  it("raw-signs the digest and returns Privy's r || s with the recovery bit appended", async () => {
    const { key, api } = evmWallet();
    const digest = randomBytes(32);

    const signature = await createPrivyBackend(api).sign('secp256k1', WALLET, digest);

    expect(api.rawSignHash).toHaveBeenCalledWith(WALLET, toHex(digest));
    expect(signature).toEqual(expectedSignature(key, digest));
  });

  it('normalizes a high-s, 65-byte signature with v = 28', async () => {
    const { key, api } = evmWallet((rs) => Uint8Array.from([...withHighS(rs), 28]));
    const digest = randomBytes(32);

    expect(await createPrivyBackend(api).sign('secp256k1', WALLET, digest)).toEqual(
      expectedSignature(key, digest),
    );
  });

  it("rejects a signature that isn't the wallet's key", async () => {
    const { api } = evmWallet();
    const other = privateKeyToAddress(toHex(randomBytes(32)));
    api.walletAddress = () => Promise.resolve(other);

    await expect(
      createPrivyBackend(api).sign('secp256k1', WALLET, randomBytes(32)),
    ).rejects.toThrow(`the signature does not recover to ${other}`);
  });

  it('rejects a signature that is not 0x-prefixed hex', async () => {
    const { api } = evmWallet();
    api.rawSignHash = () => Promise.resolve('ab'.repeat(65));

    await expect(
      createPrivyBackend(api).sign('secp256k1', WALLET, randomBytes(32)),
    ).rejects.toThrow('Privy returned a non-hex signature');
  });

  it('looks the wallet up once, however many times it signs', async () => {
    const { api } = evmWallet();
    const backend = createPrivyBackend(api);

    await backend.address('secp256k1', WALLET);
    await backend.sign('secp256k1', WALLET, randomBytes(32));
    await backend.sign('secp256k1', WALLET, randomBytes(32));

    expect(api.walletAddress).toHaveBeenCalledOnce();
  });

  it('looks the wallet up again after a failed lookup', async () => {
    const { api } = evmWallet();
    const lookup = api.walletAddress;
    api.walletAddress = vi
      .fn()
      .mockRejectedValueOnce(new Error('privy is down'))
      .mockImplementation(lookup);
    const backend = createPrivyBackend(api);

    await expect(backend.address('secp256k1', WALLET)).rejects.toThrow('privy is down');
    await expect(backend.address('secp256k1', WALLET)).resolves.toMatch(/^0x/);
  });
});

describe('createPrivyBackend on ed25519', () => {
  it.each(['legacy', 'v0'] as const)(
    "returns the wallet's signature over a %s message it pays for",
    async (version) => {
      const { keypair, api } = solanaWallet();
      const message = transferMessage(keypair.publicKey, keypair.publicKey, version);

      const signature = await createPrivyBackend(api).sign('ed25519', WALLET, message);

      expect(signature).toEqual(ed25519.sign(message, keypair.secretKey.subarray(0, 32)));
    },
  );

  it("returns the wallet's own signature when another account pays the fee", async () => {
    const { keypair, api } = solanaWallet();
    const message = transferMessage(Keypair.generate().publicKey, keypair.publicKey, 'v0');

    const signature = await createPrivyBackend(api).sign('ed25519', WALLET, message);

    expect(signature).toEqual(ed25519.sign(message, keypair.secretKey.subarray(0, 32)));
  });

  it("rejects a signature that doesn't verify over the message", async () => {
    const { keypair, api } = solanaWallet((transaction) => {
      transaction.signatures[0] = new Uint8Array(64).fill(7);
    });
    const message = transferMessage(keypair.publicKey, keypair.publicKey, 'legacy');

    await expect(createPrivyBackend(api).sign('ed25519', WALLET, message)).rejects.toThrow(
      `Privy's signature does not verify for ${keypair.publicKey.toBase58()} over the message`,
    );
  });

  it('rejects a message the wallet is not a signer of, without asking Privy', async () => {
    const { keypair, api } = solanaWallet();
    const stranger = Keypair.generate().publicKey;

    await expect(
      createPrivyBackend(api).sign('ed25519', WALLET, transferMessage(stranger, stranger, 'v0')),
    ).rejects.toThrow(`${keypair.publicKey.toBase58()} is not a signer of this message`);
    expect(api.signSolanaTransaction).not.toHaveBeenCalled();
  });
});

describe('createPrivyApi', () => {
  function sdkStub() {
    const rawSign = vi.fn((_walletId: string, _input: unknown) =>
      Promise.resolve({ signature: '0xabcd' }),
    );
    const signTransaction = vi.fn((_walletId: string, _input: unknown) =>
      Promise.resolve({ signed_transaction: 'c2lnbmVk' }),
    );
    const get = vi.fn((_walletId: string) => Promise.resolve({ address: '0xWallet' }));
    const sdk: PrivySdk = {
      wallets: () => ({ get, rawSign, solana: () => ({ signTransaction }) }),
    };
    return { sdk, get, rawSign, signTransaction };
  }

  it('passes each call through and unwraps its result', async () => {
    const { sdk, get, rawSign, signTransaction } = sdkStub();
    const api = createPrivyApi(sdk);

    expect(await api.walletAddress('w1')).toBe('0xWallet');
    expect(await api.rawSignHash('w1', '0x01')).toBe('0xabcd');
    expect(await api.signSolanaTransaction('w1', 'dW5zaWduZWQ=')).toBe('c2lnbmVk');
    expect(get).toHaveBeenCalledWith('w1');
    expect(rawSign).toHaveBeenCalledWith('w1', { params: { hash: '0x01' } });
    expect(signTransaction).toHaveBeenCalledWith('w1', { transaction: 'dW5zaWduZWQ=' });
  });

  it.each([undefined, ''])(
    'sends no authorization context with an authorization key of %j',
    async (key) => {
      const { sdk, rawSign, signTransaction } = sdkStub();
      const api = createPrivyApi(sdk, key);

      await api.rawSignHash('w1', '0x01');
      await api.signSolanaTransaction('w1', 'dW5zaWduZWQ=');

      expect(rawSign.mock.calls[0]?.[1]).toStrictEqual({ params: { hash: '0x01' } });
      expect(signTransaction.mock.calls[0]?.[1]).toStrictEqual({ transaction: 'dW5zaWduZWQ=' });
    },
  );

  it('signs every signing request with the authorization key when one is set', async () => {
    const { sdk, rawSign, signTransaction } = sdkStub();
    const api = createPrivyApi(sdk, 'wallet-auth:key');

    await api.rawSignHash('w1', '0x01');
    await api.signSolanaTransaction('w1', 'dW5zaWduZWQ=');

    const authorization_context = { authorization_private_keys: ['wallet-auth:key'] };
    expect(rawSign.mock.calls[0]?.[1]).toStrictEqual({
      params: { hash: '0x01' },
      authorization_context,
    });
    expect(signTransaction.mock.calls[0]?.[1]).toStrictEqual({
      transaction: 'dW5zaWduZWQ=',
      authorization_context,
    });
  });
});
