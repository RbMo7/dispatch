import { MINT_SIZE, MintLayout, TOKEN_PROGRAM_ID } from '@solana/spl-token';
import {
  Keypair,
  PublicKey,
  SystemProgram,
  type AccountInfo,
  type Connection,
} from '@solana/web3.js';
import { describe, expect, it } from 'vitest';

import { readSolanaToken } from './token-reads.js';

const METAPLEX = new PublicKey('metaqbxxUerdq28cj1RbAWkYQm3ybzjb6a8bt518x1s');

function account(owner: PublicKey, data: Buffer): AccountInfo<Buffer> {
  return { owner, data, executable: false, lamports: 1_461_600, rentEpoch: 0 };
}

function classicMint(decimals: number, supply: bigint): Buffer {
  const data = Buffer.alloc(MINT_SIZE);
  MintLayout.encode(
    {
      mintAuthorityOption: 0,
      mintAuthority: PublicKey.default,
      supply,
      decimals,
      isInitialized: true,
      freezeAuthorityOption: 0,
      freezeAuthority: PublicKey.default,
    },
    data,
  );
  return data;
}

function borsh(text: string, padTo = 0): Buffer {
  const bytes = Buffer.alloc(Math.max(padTo, Buffer.byteLength(text)));
  bytes.write(text);
  const length = Buffer.alloc(4);
  length.writeUInt32LE(bytes.length);
  return Buffer.concat([length, bytes]);
}

/** A Metaplex metadata account as the program writes it: key, update authority, mint, then NUL-padded name and symbol. */
function metaplexAccount(mint: PublicKey, name: string, symbol: string): Buffer {
  return Buffer.concat([
    Buffer.from([4]),
    Keypair.generate().publicKey.toBuffer(),
    mint.toBuffer(),
    borsh(name, 32),
    borsh(symbol, 10),
    borsh('https://example.invalid/meta.json', 200),
  ]);
}

function chainWith(accounts: Map<string, AccountInfo<Buffer>>): Connection {
  return {
    getAccountInfo: (address: PublicKey) =>
      Promise.resolve(accounts.get(address.toBase58()) ?? null),
  } as unknown as Connection;
}

describe('readSolanaToken (ADR-0061)', () => {
  it('reads a classic mint with its name and symbol from the Metaplex metadata account', async () => {
    const mint = Keypair.generate().publicKey;
    const [pda] = PublicKey.findProgramAddressSync(
      [Buffer.from('metadata'), METAPLEX.toBuffer(), mint.toBuffer()],
      METAPLEX,
    );
    const chain = chainWith(
      new Map([
        [mint.toBase58(), account(TOKEN_PROGRAM_ID, classicMint(6, 5_000_000n))],
        [pda.toBase58(), account(METAPLEX, metaplexAccount(mint, 'USD Coin', 'USDC'))],
      ]),
    );

    expect(await readSolanaToken(chain, mint.toBase58())).toEqual({
      ok: true,
      value: {
        chain: 'solana',
        kind: 'spl',
        address: mint.toBase58(),
        symbol: 'USDC',
        name: 'USD Coin',
        decimals: 6,
        supply: '5000000',
      },
    });
  });

  it('reads empty name and symbol from a mint with no metadata', async () => {
    const mint = Keypair.generate().publicKey;
    const chain = chainWith(
      new Map([[mint.toBase58(), account(TOKEN_PROGRAM_ID, classicMint(9, 1n))]]),
    );
    expect(await readSolanaToken(chain, mint.toBase58())).toMatchObject({
      ok: true,
      value: { symbol: '', name: '', decimals: 9 },
    });
  });

  it('refuses a wallet, a token account, a missing account and a malformed address', async () => {
    const wallet = Keypair.generate().publicKey;
    const tokenAccount = Keypair.generate().publicKey;
    const chain = chainWith(
      new Map([
        [wallet.toBase58(), account(SystemProgram.programId, Buffer.alloc(0))],
        [tokenAccount.toBase58(), account(TOKEN_PROGRAM_ID, Buffer.alloc(165))],
      ]),
    );
    for (const address of [
      wallet.toBase58(),
      tokenAccount.toBase58(),
      Keypair.generate().publicKey.toBase58(),
      'not-an-address',
    ]) {
      expect(await readSolanaToken(chain, address), address).toMatchObject({
        ok: false,
        error: { code: 'NOT_A_TOKEN' },
      });
    }
  });

  it('reports an RPC failure as unavailable, not as a non-token', async () => {
    const chain = {
      getAccountInfo: () => Promise.reject(new Error('fetch failed')),
    } as unknown as Connection;
    expect(await readSolanaToken(chain, Keypair.generate().publicKey.toBase58())).toMatchObject({
      ok: false,
      error: { code: 'RPC_UNAVAILABLE' },
    });
  });
});
