/**
 * Creates the on-chain test assets the flows need, once, and caches their
 * addresses in the state dir: an SPL mint and a Token-2022 mint on devnet,
 * and on Base Sepolia an ERC-20, a payable vault and an owner-only
 * aggregator funded with the ERC-20. Run it before starting the engine,
 * because the engine reads its known tokens at startup.
 */
import { existsSync } from 'node:fs';

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createInitializeMint2Instruction,
  createMintToInstruction,
  getAssociatedTokenAddressSync,
  getMinimumBalanceForRentExemptMint,
  MINT_SIZE,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import { Connection, Keypair, PublicKey, SystemProgram, Transaction } from '@solana/web3.js';
import { createPublicClient, createWalletClient, http, type Chain } from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import { compileContract } from '../../src/chain-handler/base/test-support/base-fixtures.js';
import {
  ASSETS_FILE,
  type Assets,
  BASE_CHAIN_ID,
  BASE_RPC_URL,
  basePayoutsKey,
  readJson,
  SOLANA_RPC_URL,
  solanaPayoutsKeypair,
  writeJson,
} from './config.js';
import { FLOW_AGGREGATOR_SOURCE, FLOW_TOKEN_SOURCE, FLOW_VAULT_SOURCE } from './contracts.js';

const DECIMALS = 6;
const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

export const baseSepolia: Chain = {
  id: BASE_CHAIN_ID,
  name: 'Base Sepolia',
  nativeCurrency: { name: 'Ether', symbol: 'ETH', decimals: 18 },
  rpcUrls: { default: { http: [BASE_RPC_URL] } },
};

async function confirmSolana(connection: Connection, signature: string): Promise<void> {
  for (let i = 0; i < 60; i++) {
    const { value } = await connection.getSignatureStatuses([signature]);
    if (value[0]?.err) throw new Error(`${signature} failed: ${JSON.stringify(value[0].err)}`);
    if (
      value[0]?.confirmationStatus === 'confirmed' ||
      value[0]?.confirmationStatus === 'finalized'
    )
      return;
    await sleep(1000);
  }
  throw new Error(`${signature} did not confirm in 60s`);
}

async function createMint(connection: Connection, owner: Keypair, program: PublicKey) {
  const mint = Keypair.generate();
  const ata = getAssociatedTokenAddressSync(mint.publicKey, owner.publicKey, false, program);
  const { blockhash, lastValidBlockHeight } = await connection.getLatestBlockhash('confirmed');
  const tx = new Transaction({ feePayer: owner.publicKey, blockhash, lastValidBlockHeight }).add(
    SystemProgram.createAccount({
      fromPubkey: owner.publicKey,
      newAccountPubkey: mint.publicKey,
      space: MINT_SIZE,
      lamports: await getMinimumBalanceForRentExemptMint(connection),
      programId: program,
    }),
    createInitializeMint2Instruction(mint.publicKey, DECIMALS, owner.publicKey, null, program),
    createAssociatedTokenAccountIdempotentInstruction(
      owner.publicKey,
      ata,
      owner.publicKey,
      mint.publicKey,
      program,
    ),
    createMintToInstruction(
      mint.publicKey,
      ata,
      owner.publicKey,
      1_000_000n * 10n ** 6n,
      [],
      program,
    ),
  );
  tx.sign(owner, mint);
  await confirmSolana(connection, await connection.sendRawTransaction(tx.serialize()));
  return mint.publicKey.toBase58();
}

async function deployBase() {
  const account = privateKeyToAccount(basePayoutsKey());
  const wallet = createWalletClient({ account, chain: baseSepolia, transport: http(BASE_RPC_URL) });
  const client = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC_URL) });
  const deploy = async (name: string, source: string, args: unknown[] = []) => {
    const { abi, bytecode } = compileContract(name, source);
    const hash = await wallet.deployContract({ abi, bytecode, args });
    const receipt = await client.waitForTransactionReceipt({ hash });
    if (!receipt.contractAddress) throw new Error(`${name} deploy ${hash} has no address`);
    console.log(`deployed ${name} at ${receipt.contractAddress} (${hash})`);
    return { address: receipt.contractAddress, abi };
  };
  const token = await deploy('FlowToken', FLOW_TOKEN_SOURCE);
  const vault = await deploy('FlowVault', FLOW_VAULT_SOURCE);
  const aggregator = await deploy('FlowAggregator', FLOW_AGGREGATOR_SOURCE);
  const fund = await wallet.writeContract({
    address: token.address,
    abi: token.abi,
    functionName: 'transfer',
    args: [aggregator.address, 1_000n * 10n ** 6n],
  });
  await client.waitForTransactionReceipt({ hash: fund });
  return { token: token.address, vault: vault.address, aggregator: aggregator.address };
}

export async function prepareAssets(): Promise<Assets> {
  if (existsSync(ASSETS_FILE)) return readJson<Assets>(ASSETS_FILE);
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const owner = solanaPayoutsKeypair();
  const splMint = await createMint(connection, owner, TOKEN_PROGRAM_ID);
  console.log(`created SPL mint ${splMint}`);
  const token2022Mint = await createMint(connection, owner, TOKEN_2022_PROGRAM_ID);
  console.log(`created Token-2022 mint ${token2022Mint}`);
  const base = await deployBase();
  const assets: Assets = {
    solana: { splMint, token2022Mint, decimals: DECIMALS },
    base: { ...base, decimals: DECIMALS },
  };
  writeJson(ASSETS_FILE, assets);
  return assets;
}

if (import.meta.url === `file://${process.argv[1]}`) {
  console.log(JSON.stringify(await prepareAssets(), null, 2));
}
