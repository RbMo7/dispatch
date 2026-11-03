/**
 * Creates the two Multisig Senders rows 11 and 12 send from, once, and caches
 * them in the state dir: a fresh 2-of-3 Squads multisig on devnet, and a fresh
 * 2-of-3 Safe on Base Sepolia with the engine's executor registered as its
 * delegate. Every key is a throwaway the run makes and keeps in the state dir.
 * Run before the engine starts, since the senders file names them.
 */
import { createHash } from 'node:crypto';
import { existsSync } from 'node:fs';

import {
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  getAssociatedTokenAddressSync,
} from '@solana/spl-token';
import { Connection, PublicKey, SystemProgram, TransactionInstruction } from '@solana/web3.js';
import {
  type Address,
  createPublicClient,
  createWalletClient,
  encodeFunctionData,
  getAddress,
  type Hex,
  http,
  parseAbi,
  parseEventLogs,
  zeroAddress,
} from 'viem';
import { privateKeyToAccount } from 'viem/accounts';

import {
  PERMISSION_EXECUTE,
  PERMISSION_INITIATE,
  PERMISSION_VOTE,
} from '../../src/chain-handler/solana/multisig/multisig-account.js';
import {
  deriveVaultAddress,
  SQUADS_PROGRAM_ID,
} from '../../src/chain-handler/solana/multisig/multisig-config.js';
import {
  sendAndConfirm,
  tokenBalance,
} from '../../src/chain-handler/solana/test-support/squads-e2e-fixtures.js';
import {
  type Assets,
  BASE_CHAIN_ID,
  BASE_RPC_URL,
  baseAddress,
  basePayoutsKey,
  baseRunKey,
  readJson,
  SOLANA_RPC_URL,
  solanaPayoutsKeypair,
  solanaRunKeypair,
  statePath,
  writeJson,
} from './config.js';
import { baseSepolia } from './prepare.js';

export const MULTISIGS_FILE = statePath('multisigs.json');
export const SAFE_SERVICE = 'https://api.safe.global/tx-service/basesep';

export type Multisigs = {
  squads: { multisig: string; vault: string; member: string; voters: string[] };
  safe: { safe: Address; executor: Address; owners: Address[] };
};

/** The run keys behind each multisig: the engine's own key, and the Approvers the run votes as. */
export const squadsKeys = () => ({
  member: solanaRunKeypair('squads-member'),
  voters: [1, 2, 3].map((i) => solanaRunKeypair(`squads-voter${i}`)),
  createKey: solanaRunKeypair('squads-create'),
});
export const safeKeys = () => ({
  executor: baseRunKey('safe-executor'),
  owners: [1, 2, 3].map((i) => baseRunKey(`safe-owner${i}`)),
});

/** Approver labels for the senders file, so the console names them. */
export const APPROVER_LABELS = ['Ana, finance', 'Ben, operations', 'Cy, audit'];

const sleep = (ms: number) => new Promise((resolve) => setTimeout(resolve, ms));

// ---- Squads v4 ---------------------------------------------------------------------------------

const MULTISIG_CREATE_V2 = createHash('sha256')
  .update('global:multisig_create_v2')
  .digest()
  .subarray(0, 8);

const pda = (...seeds: Buffer[]) => PublicKey.findProgramAddressSync(seeds, SQUADS_PROGRAM_ID)[0];

/**
 * Squads v4 `multisig_create_v2`: no config authority (the multisig governs
 * itself), no time lock, and the engine's member as the rent collector, which
 * is what the engine's startup checks ask for. Accounts: program config,
 * treasury (w), multisig (w), create key (s), creator (s, w), system program.
 */
function multisigCreateV2(input: {
  treasury: PublicKey;
  multisig: PublicKey;
  createKey: PublicKey;
  creator: PublicKey;
  threshold: number;
  members: { key: PublicKey; mask: number }[];
  rentCollector: PublicKey;
}): TransactionInstruction {
  const members = [...input.members].sort((a, b) =>
    Buffer.compare(a.key.toBuffer(), b.key.toBuffer()),
  );
  const threshold = Buffer.alloc(2);
  threshold.writeUInt16LE(input.threshold);
  const count = Buffer.alloc(4);
  count.writeUInt32LE(members.length);
  const data = Buffer.concat([
    MULTISIG_CREATE_V2,
    Buffer.from([0]), // config_authority: None
    threshold,
    count,
    ...members.map((m) => Buffer.concat([m.key.toBuffer(), Buffer.from([m.mask])])),
    Buffer.alloc(4), // time_lock: 0
    Buffer.from([1]),
    input.rentCollector.toBuffer(),
    Buffer.from([0]), // memo: None
  ]);
  return new TransactionInstruction({
    programId: SQUADS_PROGRAM_ID,
    keys: [
      {
        pubkey: pda(Buffer.from('multisig'), Buffer.from('program_config')),
        isSigner: false,
        isWritable: false,
      },
      { pubkey: input.treasury, isSigner: false, isWritable: true },
      { pubkey: input.multisig, isSigner: false, isWritable: true },
      { pubkey: input.createKey, isSigner: true, isWritable: false },
      { pubkey: input.creator, isSigner: true, isWritable: true },
      { pubkey: SystemProgram.programId, isSigner: false, isWritable: false },
    ],
    data,
  });
}

async function createSquads(assets: Assets): Promise<Multisigs['squads']> {
  const connection = new Connection(SOLANA_RPC_URL, 'confirmed');
  const funder = solanaPayoutsKeypair();
  const { member, voters, createKey } = squadsKeys();
  const multisig = pda(
    Buffer.from('multisig'),
    Buffer.from('multisig'),
    createKey.publicKey.toBuffer(),
  );
  const vault = deriveVaultAddress(multisig);

  if (!(await connection.getAccountInfo(multisig, 'confirmed'))) {
    const config = await connection.getAccountInfo(
      pda(Buffer.from('multisig'), Buffer.from('program_config')),
      'confirmed',
    );
    if (!config) throw new Error('the Squads program config is missing on this cluster');
    // ProgramConfig: discriminator, authority, multisig_creation_fee u64, treasury.
    const treasury = new PublicKey(config.data.subarray(48, 80));
    await sendAndConfirm(
      connection,
      [
        multisigCreateV2({
          treasury,
          multisig,
          createKey: createKey.publicKey,
          creator: funder.publicKey,
          threshold: 2,
          members: [
            { key: member.publicKey, mask: PERMISSION_INITIATE | PERMISSION_EXECUTE },
            ...voters.map((v) => ({ key: v.publicKey, mask: PERMISSION_VOTE })),
          ],
          rentCollector: member.publicKey,
        }),
      ],
      funder,
      [createKey],
    );
    console.log(`created Squads multisig ${multisig.toBase58()}, vault ${vault.toBase58()}`);
  }

  // The engine's member pays proposal rent and fees, each voter pays its vote, the vault pays out.
  const mint = new PublicKey(assets.solana.splMint);
  const vaultAta = getAssociatedTokenAddressSync(mint, vault, true);
  const topUps: [PublicKey, number][] = [
    [member.publicKey, 60_000_000],
    [vault, 30_000_000],
    ...voters.map((v): [PublicKey, number] => [v.publicKey, 5_000_000]),
  ];
  const instructions: TransactionInstruction[] = [];
  for (const [key, target] of topUps) {
    const balance = await connection.getBalance(key, 'confirmed');
    if (balance < target / 2)
      instructions.push(
        SystemProgram.transfer({
          fromPubkey: funder.publicKey,
          toPubkey: key,
          lamports: target - balance,
        }),
      );
  }
  const tokens = await tokenBalance(connection, vaultAta);
  if (tokens < 5_000_000n)
    instructions.push(
      createAssociatedTokenAccountIdempotentInstruction(funder.publicKey, vaultAta, vault, mint),
      createTransferCheckedInstruction(
        getAssociatedTokenAddressSync(mint, funder.publicKey),
        mint,
        vaultAta,
        funder.publicKey,
        20_000_000n - tokens,
        assets.solana.decimals,
      ),
    );
  if (instructions.length > 0) await sendAndConfirm(connection, instructions, funder);

  return {
    multisig: multisig.toBase58(),
    vault: vault.toBase58(),
    member: member.publicKey.toBase58(),
    voters: voters.map((v) => v.publicKey.toBase58()),
  };
}

// ---- Safe 1.4.1 --------------------------------------------------------------------------------

/** The canonical Safe 1.4.1 deployments, the same address on every chain. */
const SAFE_L2_SINGLETON: Address = '0x29fcB43b46531BcA003ddC8FCB67FFE91900C762';
const SAFE_PROXY_FACTORY: Address = '0x4e1DCf7AD4e460CfD30791CCC4F9c8a4f820ec67';
const FALLBACK_HANDLER: Address = '0xfd0732Dc9E303f09fCEf3a7388Ad10A83459Ec99';

const SAFE_SETUP_ABI = parseAbi([
  'function setup(address[] _owners, uint256 _threshold, address to, bytes data, address fallbackHandler, address paymentToken, uint256 payment, address paymentReceiver)',
]);
const FACTORY_ABI = parseAbi([
  'function createProxyWithNonce(address _singleton, bytes initializer, uint256 saltNonce) returns (address proxy)',
  'event ProxyCreation(address indexed proxy, address singleton)',
]);
const ERC20_ABI = parseAbi([
  'function transfer(address to, uint256 value) returns (bool)',
  'function balanceOf(address) view returns (uint256)',
]);

async function service(method: 'GET' | 'POST', route: string, body?: unknown) {
  for (let attempt = 1; ; attempt++) {
    const res = await fetch(`${SAFE_SERVICE}/api${route}`, {
      method,
      headers: { 'content-type': 'application/json' },
      signal: AbortSignal.timeout(20_000),
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
    });
    if ((res.status === 429 || res.status >= 500) && attempt < 5) {
      await sleep(3000 * attempt);
      continue;
    }
    const text = await res.text();
    return { status: res.status, text };
  }
}

/** A Safe owner's confirmation of a proposed transaction, posted to the service as the Safe app does. */
export async function confirmSafeTx(ownerKey: Hex, safeTxHash: Hex): Promise<number> {
  const owner = privateKeyToAccount(ownerKey);
  const raw = await owner.sign({ hash: safeTxHash });
  const v = Number.parseInt(raw.slice(-2), 16);
  const signature = v < 27 ? `${raw.slice(0, -2)}${(v + 27).toString(16)}` : raw;
  const res = await service('POST', `/v1/multisig-transactions/${safeTxHash}/confirmations/`, {
    signature,
  });
  if (res.status !== 200 && res.status !== 201)
    throw new Error(`confirmation by ${owner.address}: ${res.status} ${res.text}`);
  return res.status;
}

async function createSafe(assets: Assets): Promise<Multisigs['safe']> {
  const funder = privateKeyToAccount(basePayoutsKey());
  const wallet = createWalletClient({
    account: funder,
    chain: baseSepolia,
    transport: http(BASE_RPC_URL),
  });
  const client = createPublicClient({ chain: baseSepolia, transport: http(BASE_RPC_URL) });
  const { executor, owners } = safeKeys();
  const ownerAddresses = owners.map(baseAddress);
  const executorAddress = baseAddress(executor);

  for (const address of [SAFE_L2_SINGLETON, SAFE_PROXY_FACTORY, FALLBACK_HANDLER]) {
    if (!(await client.getCode({ address })))
      throw new Error(`no Safe 1.4.1 contract at ${address} on Base Sepolia`);
  }
  const initializer = encodeFunctionData({
    abi: SAFE_SETUP_ABI,
    functionName: 'setup',
    args: [ownerAddresses, 2n, zeroAddress, '0x', FALLBACK_HANDLER, zeroAddress, 0n, zeroAddress],
  });
  const hash = await wallet.writeContract({
    address: SAFE_PROXY_FACTORY,
    abi: FACTORY_ABI,
    functionName: 'createProxyWithNonce',
    args: [SAFE_L2_SINGLETON, initializer, BigInt(Date.now())],
  });
  const receipt = await client.waitForTransactionReceipt({ hash });
  const [created] = parseEventLogs({
    abi: FACTORY_ABI,
    eventName: 'ProxyCreation',
    logs: receipt.logs,
  });
  if (!created) throw new Error(`Safe creation ${hash} emitted no ProxyCreation`);
  const safe = getAddress(created.args.proxy);
  console.log(`created Safe ${safe} (${hash})`);

  // The executor pays for each execution; the Safe pays the payments.
  for (const [to, value] of [
    [executorAddress, 15_000_000_000_000n],
    [safe, 5_000_000_000_000n],
  ] as const) {
    const sent = await wallet.sendTransaction({ to, value });
    await client.waitForTransactionReceipt({ hash: sent });
  }
  const tokens = await wallet.writeContract({
    address: assets.base.token,
    abi: ERC20_ABI,
    functionName: 'transfer',
    args: [safe, 20_000_000n],
  });
  await client.waitForTransactionReceipt({ hash: tokens });

  // The service indexes a new Safe from its creation event; the delegate can be registered once it has.
  for (let i = 0; ; i++) {
    const known = await service('GET', `/v1/safes/${safe}/`);
    if (known.status === 200) break;
    if (i > 40)
      throw new Error(`the Safe Transaction Service never indexed ${safe}: ${known.status}`);
    await sleep(5000);
  }
  const owner = privateKeyToAccount(owners[0]!);
  const totp = BigInt(Math.floor(Date.now() / 1000 / 3600));
  const signature = await owner.signTypedData({
    domain: { name: 'Safe Transaction Service', version: '1.0', chainId: BASE_CHAIN_ID },
    types: {
      Delegate: [
        { name: 'delegateAddress', type: 'address' },
        { name: 'totp', type: 'uint256' },
      ],
    },
    primaryType: 'Delegate',
    message: { delegateAddress: executorAddress, totp },
  });
  const delegate = await service('POST', '/v2/delegates/', {
    safe,
    delegate: executorAddress,
    delegator: owner.address,
    label: 'Dispatch engine (flows run)',
    signature,
  });
  if (delegate.status !== 201 && delegate.status !== 200)
    throw new Error(`delegate registration: ${delegate.status} ${delegate.text}`);
  console.log(`registered ${executorAddress} as a delegate of ${safe}`);
  return { safe, executor: executorAddress, owners: ownerAddresses };
}

/** Creates both multisigs once; a rerun reuses them and only tops their wallets up again (Squads). */
export async function prepareMultisigs(assets: Assets): Promise<Multisigs> {
  if (existsSync(MULTISIGS_FILE)) {
    const cached = readJson<Multisigs>(MULTISIGS_FILE);
    await createSquads(assets);
    return cached;
  }
  const squads = await createSquads(assets);
  const safe = await createSafe(assets);
  const multisigs = { squads, safe };
  writeJson(MULTISIGS_FILE, multisigs);
  return multisigs;
}

export { ERC20_ABI };
