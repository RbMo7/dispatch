import { ed25519 } from '@noble/curves/ed25519.js';
import type { AuthorizationContext } from '@privy-io/node';
import { VersionedMessage, VersionedTransaction } from '@solana/web3.js';
import bs58 from 'bs58';
import { hexToBytes, isHex, toHex, type Hex } from 'viem';

import type { KeyBackend } from './key-backend.js';
import { recoverableSignature } from './secp256k1-recovery.js';

/** The three Privy calls the backend makes, so tests can stand in for Privy. */
export type PrivyApi = {
  walletAddress: (walletId: string) => Promise<string>;
  /** Signs a 32-byte hash as given; returns the signature as hex. */
  rawSignHash: (walletId: string, hash: Hex) => Promise<string>;
  /** Takes and returns a base64 Solana wire transaction. */
  signSolanaTransaction: (walletId: string, transaction: string) => Promise<string>;
};

type Authorized = { authorization_context?: AuthorizationContext };

/** The slice of Privy's SDK (`PrivyClient`) that `createPrivyApi` calls. */
export type PrivySdk = {
  wallets(): {
    get(walletId: string): PromiseLike<{ address: string }>;
    rawSign(
      walletId: string,
      input: { params: { hash: Hex } } & Authorized,
    ): Promise<{ signature: string }>;
    solana(): {
      signTransaction(
        walletId: string,
        input: { transaction: string } & Authorized,
      ): Promise<{ signed_transaction: string }>;
    };
  };
};

/**
 * Privy's SDK as a `PrivyApi`. With an authorization key, every signing
 * request carries its signature, as a wallet owned by that key requires.
 */
export function createPrivyApi(sdk: PrivySdk, authorizationKey?: string): PrivyApi {
  const authorization: Authorized = authorizationKey
    ? { authorization_context: { authorization_private_keys: [authorizationKey] } }
    : {};
  return {
    walletAddress: async (walletId) => (await sdk.wallets().get(walletId)).address,
    rawSignHash: async (walletId, hash) =>
      (await sdk.wallets().rawSign(walletId, { params: { hash }, ...authorization })).signature,
    signSolanaTransaction: async (walletId, transaction) =>
      (
        await sdk
          .wallets()
          .solana()
          .signTransaction(walletId, { transaction, ...authorization })
      ).signed_transaction,
  };
}

/**
 * Sent as a transaction with empty signature slots, not through Privy's
 * signMessage, so Privy's own transaction policies still apply to it; the
 * wallet's own slot is read back.
 */
async function signSolanaMessage(
  api: PrivyApi,
  walletId: string,
  address: string,
  payload: Uint8Array,
): Promise<Uint8Array> {
  const message = VersionedMessage.deserialize(payload);
  const slot = message.staticAccountKeys
    .slice(0, message.header.numRequiredSignatures)
    .findIndex((key) => key.toBase58() === address);
  if (slot === -1) throw new Error(`${address} is not a signer of this message`);

  const unsigned = Buffer.from(new VersionedTransaction(message).serialize()).toString('base64');
  const signed = VersionedTransaction.deserialize(
    Buffer.from(await api.signSolanaTransaction(walletId, unsigned), 'base64'),
  );
  const signature = signed.signatures[slot];
  if (!signature || !ed25519.verify(signature, payload, bs58.decode(address))) {
    throw new Error(`Privy's signature does not verify for ${address} over the message`);
  }
  return signature;
}

/**
 * Keys held by Privy server wallets; `keyRef` is the wallet id. Every
 * signature is checked against the wallet's address before it is returned.
 */
export function createPrivyBackend(api: PrivyApi): KeyBackend {
  const addresses = new Map<string, Promise<string>>();
  function walletAddress(walletId: string): Promise<string> {
    let address = addresses.get(walletId);
    if (!address) {
      address = api.walletAddress(walletId);
      // A failed lookup is retried next time rather than cached.
      address.catch(() => addresses.delete(walletId));
      addresses.set(walletId, address);
    }
    return address;
  }

  return {
    address: (_curve, walletId) => walletAddress(walletId),
    async sign(curve, walletId, payload) {
      const address = await walletAddress(walletId);
      switch (curve) {
        case 'secp256k1': {
          const signature = await api.rawSignHash(walletId, toHex(payload));
          if (!isHex(signature)) throw new Error('Privy returned a non-hex signature');
          return recoverableSignature(hexToBytes(signature), payload, address);
        }
        case 'ed25519':
          return signSolanaMessage(api, walletId, address, payload);
      }
    },
  };
}
