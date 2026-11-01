import { randomUUID } from 'node:crypto';

import {
  ComputeBudgetProgram,
  type Connection,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  type TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import bs58 from 'bs58';
import type { Logger } from 'pino';

import type { SolanaCall } from '../../../domain/call.js';
import type { DispatchError } from '../../../domain/errors.js';
import type {
  AssetAmount,
  ChainProposalRef,
  CommittedAmounts,
  ExpectedTotals,
  Proposal,
} from '../../../domain/proposal.js';
import { err, ok, type Result } from '../../../domain/result.js';
import { logger as defaultLogger } from '../../../logger.js';
import type { SignerClient } from '../../../signer/client.js';
import type {
  ApprovalCapability,
  ApprovalCost,
  BuiltProposal,
  PreparedTransaction,
  ProposalSnapshot,
  SignedProposal,
} from '../../chain-handler.js';
import { extractMessage, isBlockhashExpiryMessage, mapSolanaFailure } from '../error-mapping.js';
import { createdTokenAccount, toTransactionInstructions } from '../instruction-codec.js';
import { NATIVE_ASSET_SYMBOL, type SolanaTokenRegistry } from '../known-tokens.js';
import {
  BLOCKHASH_VALIDITY_BLOCKS,
  decodeInstruction,
  type EncodedInstruction,
  encodeInstruction,
  encodeUnsignedTransaction,
  EXPIRY_MARGIN_BLOCKS,
} from '../solana-chain-handler.js';
import { tokenAccountRent } from '../token-account-rent.js';
import {
  decodeMultisigAccount,
  MULTISIG_READ_COMMITMENT,
  PERMISSION_INITIATE,
  readMultisigState,
  type MultisigAccount,
} from './multisig-account.js';
import {
  SENDER_VAULT_INDEX,
  SQUADS_PROGRAM_ID,
  type SolanaMultisigConfig,
} from './multisig-config.js';
import { decodeProposalAccount, type ProposalAccount } from './proposal-account.js';
import { summarizeTransfer, type TransferSummary } from './transfer-calls.js';
import {
  compileVaultMessage,
  decodeVaultTransactionAccount,
  deriveProposalPda,
  deriveTransactionPda,
  proposalAccountSize,
  proposalCreateInstruction,
  vaultTransactionAccountsCloseInstruction,
  vaultTransactionCreateInstruction,
  vaultTransactionExecuteInstruction,
} from './vault-transaction.js';

/**
 * ADR-0054's Squads half, propose side (#74): at most this many transfers per
 * Proposal. Measured on devnet (spike #70): 14 to 15 is the hard limit of the
 * create transaction, and an execute transaction of SPL transfers stops
 * fitting around 20 (or 16 with the default heap), so 12 leaves room for the
 * mint and program keys and the token-account creations a mixed bundle adds.
 */
export const MAX_TRANSFERS_PER_PROPOSAL = 12;

/** The base fee per signature; a propose transaction has exactly one (the member's). */
const LAMPORTS_PER_SIGNATURE = 5_000;
/** The compute-unit limit set (only alongside a priority fee) on a propose transaction: two Squads instructions that create accounts. */
const CREATE_COMPUTE_UNIT_LIMIT = 400_000;
/** `getMultipleAccountsInfo`'s per-call cap. */
const MAX_ACCOUNTS_PER_LOOKUP = 100;
/** An index only used to measure sizes: a transaction index is a u64 whatever its value. */
const PROBE_INDEX = 1n;
/** An execute asks for the largest heap frame: the default 32 KB fails a bundle of SPL transfers from 18 up (spike #70). */
const EXECUTE_HEAP_BYTES = 256 * 1024;
/** The most compute units a transaction may ask for. */
const MAX_COMPUTE_UNITS = 1_400_000;
/** The simulated compute units of an execute, with this much room on top, are its limit. */
const EXECUTE_UNITS_MARGIN = 1.5;
const MIN_EXECUTE_UNITS = 100_000;
/** Squads' `TimeLockNotReleased` error code (spike #70). */
const TIME_LOCK_NOT_RELEASED = 6021;
/** How many of a proposal's latest signatures are searched for its execution. A proposal's history is its creation, the votes, the execute and the close. */
const HISTORY_LIMIT = 100;

/** Everything `SquadsApproval` needs of web3.js, so tests can hand it a fake RPC. */
export type SquadsConnection = Pick<
  Connection,
  | 'getAccountInfo'
  | 'getAccountInfoAndContext'
  | 'getBlockHeight'
  | 'getLatestBlockhash'
  | 'getMinimumBalanceForRentExemption'
  | 'getMultipleAccountsInfo'
  | 'getMultipleAccountsInfoAndContext'
  | 'getSignatureStatuses'
  | 'getSignaturesForAddress'
  | 'getTransaction'
  | 'sendRawTransaction'
  | 'simulateTransaction'
>;

export type SquadsApprovalDeps = {
  connection: SquadsConnection;
  /** Signs as the member: the Signer's policy (`allowedMultisig`) only accepts the propose, execute and close instructions. */
  signerClient: Pick<SignerClient, 'requestSignature'>;
  /** The validated #73 config: the multisig, its vault (the Sender) and the member key. */
  multisig: Pick<SolanaMultisigConfig, 'multisigAddress' | 'memberAddress' | 'vaultAddress'>;
  knownTokens?: SolanaTokenRegistry;
  /** Opt-in priority fee in micro-lamports per compute unit for the propose transaction (ADR-0003). Default none. */
  computeUnitPriceMicroLamports?: number;
  /** How often `submitProposal` checks the transaction's status. The devnet RPC has no websocket, so it polls. */
  pollIntervalMs?: number;
  /** How often `submitProposal` sends the same bytes again while the transaction is not seen. */
  resendIntervalMs?: number;
  logger?: Logger;
  /** The clock, for the time lock. Tests inject one. */
  now?: () => Date;
};

/** What `payload` holds: enough to sign the same Proposal again with a fresh blockhash. */
type ProposalPayload = {
  version: 1;
  multisig: string;
  member: string;
  vault: string;
  transactionIndex: string;
  /** The vault transaction and proposal accounts the index names. */
  transaction: string;
  proposal: string;
  /** The create transaction's instructions: compute budget, vaultTransactionCreate, proposalCreate. */
  instructions: EncodedInstruction[];
};

type Quote = {
  index: bigint;
  instructions: TransactionInstruction[];
  expected: ExpectedTotals;
  committed: CommittedAmounts;
  cost: { fee: bigint; rent: bigint; ataRent: bigint };
  account: MultisigAccount;
};

const rpcError = (message: string, cause: unknown): DispatchError => ({
  code: 'RPC_UNAVAILABLE',
  message,
  chainDetail: extractMessage(cause),
});

const rejected = (message: string, chainDetail?: unknown): DispatchError => ({
  code: 'CHAIN_REJECTED',
  message,
  ...(chainDetail === undefined ? {} : { chainDetail }),
});

const sleep = (ms: number): Promise<void> => new Promise((resolve) => setTimeout(resolve, ms));

/** The status check's answers: it landed, it failed on chain, or it is not seen yet. */
type Landed = { type: 'confirmed' } | { type: 'failed'; chainDetail: unknown } | { type: 'unseen' };

/**
 * The Squads v4 implementation of the Chain Handler approval capability
 * (ADR-0054, ADR-0049): the propose half. A Dispatch's transfers become
 * Proposals of at most 12 transfers each; each is one transaction (a vault
 * transaction and a non-draft proposal, Active at once), paid for and signed
 * by the member key. The vault only ever pays out of an execution, so every
 * inner instruction names the vault as payer.
 *
 * #75 adds the other half: `readProposal`, `prepareExecution` (the
 * `vaultTransactionExecute`, signed and sent like any transaction by the
 * Solana handler) and `closeProposal` (reclaiming rent).
 */
export class SquadsApproval implements ApprovalCapability<'solana'> {
  readonly proposerAddress: string;
  /** Creation is serialized per multisig by ApprovalFlow, so any number of Proposals may be open. */
  readonly openProposalLimit = Number.POSITIVE_INFINITY;
  /** Who holds what, for the Funding Check's INSUFFICIENT_FUNDS detail (#76): the vault pays out, the member key pays fees and rent. */
  readonly holders = { sender: 'vault', proposer: 'memberKey' } as const;

  private readonly connection: SquadsConnection;
  private readonly signerClient: Pick<SignerClient, 'requestSignature'>;
  private readonly multisig: PublicKey;
  private readonly member: PublicKey;
  private readonly vault: string;
  private readonly knownTokens: SolanaTokenRegistry;
  private readonly computeUnitPrice: number;
  private readonly pollIntervalMs: number;
  private readonly resendIntervalMs: number;
  private readonly logger: Logger;
  private readonly now: () => Date;
  /** hash -> the last block height its blockhash is valid for, so a submit can prove expiry. */
  private readonly lastValidByHash = new Map<string, number>();

  constructor(deps: SquadsApprovalDeps) {
    this.connection = deps.connection;
    this.signerClient = deps.signerClient;
    this.multisig = new PublicKey(deps.multisig.multisigAddress);
    this.member = new PublicKey(deps.multisig.memberAddress);
    this.proposerAddress = deps.multisig.memberAddress;
    this.vault = deps.multisig.vaultAddress;
    this.knownTokens = deps.knownTokens ?? {};
    this.computeUnitPrice = deps.computeUnitPriceMicroLamports ?? 0;
    if (!Number.isSafeInteger(this.computeUnitPrice) || this.computeUnitPrice < 0) {
      throw new Error(
        `the Squads propose compute-unit price must be a whole, non-negative number of micro-lamports, got ${deps.computeUnitPriceMicroLamports}`,
      );
    }
    this.pollIntervalMs = deps.pollIntervalMs ?? 1_000;
    this.resendIntervalMs = deps.resendIntervalMs ?? 2_000;
    this.logger = (deps.logger ?? defaultLogger).child({ component: 'squads-approval' });
    this.now = deps.now ?? (() => new Date());
  }

  // ---- planning ----------------------------------------------------------------------------

  /**
   * Splits one Dispatch's Calls into Proposals: greedy and in order, a
   * bundle closing at 12 transfers or when the create transaction (the
   * compute-budget instructions, `vaultTransactionCreate` and `proposalCreate`
   * with the message inside, signed by the one member) would pass Solana's
   * 1232 bytes. Mint and program keys and token-account creations count, and
   * the compute-budget instructions are always reserved. Every Call must be a
   * transfer the vault pays (`summarizeTransfer`).
   */
  planBundles(calls: SolanaCall[]): Result<number[][], DispatchError> {
    const perCall: TransactionInstruction[][] = [];
    for (const call of calls) {
      const summary = summarizeTransfer(call, this.vault, this.knownTokens);
      if (!summary.ok) return summary;
      perCall.push(toTransactionInstructions(call, new PublicKey(this.vault)));
    }

    const probe = this.probeAccounts();
    const bundles: number[][] = [];
    let current: number[] = [];
    for (let i = 0; i < calls.length; i++) {
      const candidate = [...current, i];
      const tooBig =
        candidate.length > MAX_TRANSFERS_PER_PROPOSAL ||
        this.createTransactionSize(
          candidate.flatMap((n) => perCall[n]!),
          probe,
        ) > PACKET_DATA_SIZE;
      if (current.length > 0 && tooBig) {
        bundles.push(current);
        current = [i];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) bundles.push(current);

    for (const bundle of bundles) {
      const size = this.createTransactionSize(
        bundle.flatMap((n) => perCall[n]!),
        probe,
      );
      if (size > PACKET_DATA_SIZE) {
        return err(
          rejected(
            `a Proposal for this call would be ${size} bytes, over Solana's ${PACKET_DATA_SIZE}-byte limit`,
          ),
        );
      }
    }
    return ok(bundles);
  }

  /** Placeholder accounts for sizing: their values never change a transaction's size. */
  private probeAccounts(): { transaction: PublicKey; proposal: PublicKey } {
    return {
      transaction: deriveTransactionPda(this.multisig, PROBE_INDEX),
      proposal: deriveProposalPda(this.multisig, PROBE_INDEX),
    };
  }

  /** The signed create transaction's size, always counting both compute-budget instructions. */
  private createTransactionSize(
    inner: TransactionInstruction[],
    probe: { transaction: PublicKey; proposal: PublicKey },
  ): number {
    const message = compileVaultMessage(new PublicKey(this.vault), inner);
    const instructions = [
      ...this.budgetInstructions(true),
      vaultTransactionCreateInstruction({
        multisig: this.multisig,
        transactionIndex: PROBE_INDEX,
        member: this.member,
        vaultIndex: SENDER_VAULT_INDEX,
        message: message.bytes,
        transaction: probe.transaction,
      }),
      proposalCreateInstruction({
        multisig: this.multisig,
        transactionIndex: PROBE_INDEX,
        member: this.member,
        proposal: probe.proposal,
      }),
    ];
    try {
      const tx = new Transaction({
        feePayer: this.member,
        blockhash: PublicKey.default.toBase58(),
        lastValidBlockHeight: 0,
      }).add(...instructions);
      return 1 + 64 + tx.compileMessage().serialize().length;
    } catch {
      return Number.POSITIVE_INFINITY; // web3.js throws outright once the instructions alone pass the limit
    }
  }

  /** The compute limit and price, present only with a priority fee, or always when `reserve` is set for sizing. */
  private budgetInstructions(reserve = false): TransactionInstruction[] {
    if (this.computeUnitPrice === 0 && !reserve) return [];
    return [
      ComputeBudgetProgram.setComputeUnitLimit({ units: CREATE_COMPUTE_UNIT_LIMIT }),
      ComputeBudgetProgram.setComputeUnitPrice({
        microLamports: Math.max(this.computeUnitPrice, 1),
      }),
    ];
  }

  // ---- building ----------------------------------------------------------------------------

  async buildProposal(input: {
    calls: SolanaCall[];
    sender: string;
  }): Promise<Result<BuiltProposal, DispatchError>> {
    if (input.sender !== this.vault) {
      return err(
        rejected(`this Multisig Sender's vault is ${this.vault}, not ${input.sender}`, {
          sender: input.sender,
        }),
      );
    }
    if (input.calls.length === 0) return err(rejected('a Proposal needs at least one call'));
    if (input.calls.length > MAX_TRANSFERS_PER_PROPOSAL) {
      return err(
        rejected(
          `a Proposal holds at most ${MAX_TRANSFERS_PER_PROPOSAL} transfers, got ${input.calls.length}`,
        ),
      );
    }

    const account = await this.readAccount();
    if (!account.ok) return account;
    const quote = await this.quote(input.calls, account.value, new Map());
    if (!quote.ok) return quote;
    const q = quote.value;

    const transaction = deriveTransactionPda(this.multisig, q.index);
    const proposal = deriveProposalPda(this.multisig, q.index);
    const sizeError = this.checkSize(q.instructions);
    if (sizeError) return err(sizeError);

    const payload: ProposalPayload = {
      version: 1,
      multisig: this.multisig.toBase58(),
      member: this.proposerAddress,
      vault: this.vault,
      transactionIndex: q.index.toString(),
      transaction: transaction.toBase58(),
      proposal: proposal.toBase58(),
      instructions: q.instructions.map(encodeInstruction),
    };
    const chainRef: ChainProposalRef = {
      kind: 'squads',
      multisig: this.multisig.toBase58(),
      proposal: proposal.toBase58(),
      transactionIndex: Number(q.index),
    };
    return ok({
      chainRef,
      proposalRef: proposal.toBase58(),
      payload: Buffer.from(JSON.stringify(payload)).toString('base64'),
      sequence: Number(q.index),
      threshold: q.account.threshold,
      // The time lock runs from the moment of approval, so there is nothing to wait for yet.
      executeAfter: null,
      expected: q.expected,
      committed: q.committed,
    });
  }

  /** The create transaction must fit once its real transaction accounts and index are in. */
  private checkSize(instructions: TransactionInstruction[]): DispatchError | undefined {
    const tx = new Transaction({
      feePayer: this.member,
      blockhash: PublicKey.default.toBase58(),
      lastValidBlockHeight: 0,
    }).add(...instructions);
    let size: number;
    try {
      size = 1 + 64 + tx.compileMessage().serialize().length;
    } catch {
      size = Number.POSITIVE_INFINITY;
    }
    return size > PACKET_DATA_SIZE
      ? rejected(
          `the Proposal transaction would be ${size} bytes, over Solana's ${PACKET_DATA_SIZE}-byte limit`,
        )
      : undefined;
  }

  private async readAccount(): Promise<Result<MultisigAccount, DispatchError>> {
    let state;
    try {
      state = await readMultisigState(this.connection, this.multisig.toBase58());
    } catch (cause) {
      return err(rpcError('failed to read the multisig account', cause));
    }
    const found = state.account;
    if (found === undefined) {
      return err(rejected(`no account exists at the multisig ${this.multisig.toBase58()}`));
    }
    if (found.owner !== SQUADS_PROGRAM_ID.toBase58()) {
      return err(rejected(`the multisig ${this.multisig.toBase58()} is not owned by Squads v4`));
    }
    if ('undecodable' in found.multisig) {
      return err(rejected('the multisig account could not be decoded', found.multisig.undecodable));
    }
    const account = found.multisig;
    const member = account.members.find((m) => m.key === this.proposerAddress);
    if (!member || (member.permissions & PERMISSION_INITIATE) === 0) {
      return err(
        rejected(
          `the key ${this.proposerAddress} is not a member of the multisig that may propose`,
        ),
      );
    }
    return ok(account);
  }

  /**
   * Everything about one bundle: its instructions with the next transaction
   * index, what it should pay (`expected`) and what it holds back
   * (`committed`), from the multisig as `account` read it. `ataSeen` holds the
   * token accounts already priced by an earlier bundle of the same estimate.
   */
  private async quote(
    calls: SolanaCall[],
    account: MultisigAccount,
    ataSeen: Map<string, bigint>,
  ): Promise<Result<Quote, DispatchError>> {
    const vault = new PublicKey(this.vault);
    const summaries: TransferSummary[] = [];
    const inner: TransactionInstruction[] = [];
    for (const call of calls) {
      const summary = summarizeTransfer(call, this.vault, this.knownTokens);
      if (!summary.ok) return summary;
      summaries.push(summary.value);
      inner.push(...toTransactionInstructions(call, vault));
    }

    let message;
    try {
      message = compileVaultMessage(vault, inner);
    } catch (cause) {
      return err(
        rejected('the calls cannot be compiled into a vault transaction', extractMessage(cause)),
      );
    }

    const index = account.transactionIndex + 1n;
    const instructions = [
      ...this.budgetInstructions(),
      vaultTransactionCreateInstruction({
        multisig: this.multisig,
        transactionIndex: index,
        member: this.member,
        vaultIndex: SENDER_VAULT_INDEX,
        message: message.bytes,
      }),
      proposalCreateInstruction({
        multisig: this.multisig,
        transactionIndex: index,
        member: this.member,
      }),
    ];

    let vaultTransactionRent: bigint;
    let proposalRent: bigint;
    let ataRent: bigint;
    try {
      vaultTransactionRent = BigInt(
        await this.connection.getMinimumBalanceForRentExemption(message.accountSize),
      );
      proposalRent = BigInt(
        await this.connection.getMinimumBalanceForRentExemption(
          proposalAccountSize(account.members.length),
        ),
      );
      ataRent = await this.missingTokenAccountRent(calls, ataSeen);
    } catch (cause) {
      return err(rpcError('failed to price the Proposal', cause));
    }

    const priorityFee =
      (BigInt(this.computeUnitPrice) * BigInt(CREATE_COMPUTE_UNIT_LIMIT) + 999_999n) / 1_000_000n;
    const fee = BigInt(LAMPORTS_PER_SIGNATURE) + priorityFee;
    const rent = vaultTransactionRent + proposalRent;

    const paid = new Map<string, bigint>();
    for (const summary of summaries) {
      paid.set(summary.asset, (paid.get(summary.asset) ?? 0n) + summary.amount);
    }
    const expected: ExpectedTotals = {
      recipients: new Set(summaries.map((s) => s.recipient)).size,
      totals: toAmounts(paid),
    };
    const fromVault = new Map(paid);
    if (ataRent > 0n) {
      fromVault.set(NATIVE_ASSET_SYMBOL, (fromVault.get(NATIVE_ASSET_SYMBOL) ?? 0n) + ataRent);
    }
    return ok({
      index,
      instructions,
      expected,
      committed: {
        sender: toAmounts(fromVault),
        proposer: [{ asset: NATIVE_ASSET_SYMBOL, amount: (fee + rent).toString() }],
      },
      cost: { fee, rent, ataRent },
      account,
    });
  }

  /**
   * Rent the vault pays for recipient token accounts that do not exist yet
   * (an idempotent create is part of every payment-built token transfer).
   * Over-asks rather than under-asks. `seen` records accounts already priced,
   * so one account two payments create is priced once.
   */
  private async missingTokenAccountRent(
    calls: SolanaCall[],
    seen: Map<string, bigint>,
  ): Promise<bigint> {
    const created = new Map<string, { mint: string; tokenProgram: string }>();
    for (const call of calls) {
      const account = createdTokenAccount(call);
      if (account && !seen.has(account.account)) created.set(account.account, account);
    }
    const keys = [...created.keys()];
    const rentByMint = new Map<string, bigint>();
    let total = 0n;
    for (let i = 0; i < keys.length; i += MAX_ACCOUNTS_PER_LOOKUP) {
      const batch = keys.slice(i, i + MAX_ACCOUNTS_PER_LOOKUP);
      const infos = await this.connection.getMultipleAccountsInfo(
        batch.map((k) => new PublicKey(k)),
      );
      for (const [j, info] of infos.entries()) {
        const key = batch[j]!;
        seen.set(key, 0n);
        if (info) continue; // already exists: nothing to create
        const { mint, tokenProgram } = created.get(key)!;
        let rent = rentByMint.get(mint);
        if (rent === undefined) {
          rent = BigInt(
            await tokenAccountRent(
              this.connection,
              new PublicKey(mint),
              new PublicKey(tokenProgram),
            ),
          );
          rentByMint.set(mint, rent);
        }
        total += rent;
      }
    }
    return total;
  }

  // ---- signing -----------------------------------------------------------------------------

  /**
   * Signs the create transaction as the member (never the vault, which signs
   * only inside an execution), over a fresh blockhash: calling it again with
   * the same payload re-signs the same Proposal, which is what a watch loop
   * does when a signed transaction's blockhash expired before it landed.
   * `SIGNER_REFUSED` and `SIGNER_UNREACHABLE` come back exactly as for a
   * plain Sender.
   */
  async signProposal(built: BuiltProposal): Promise<Result<SignedProposal, DispatchError>> {
    let payload: ProposalPayload;
    let instructions: TransactionInstruction[];
    try {
      payload = JSON.parse(
        Buffer.from(built.payload, 'base64').toString('utf8'),
      ) as ProposalPayload;
      if (payload.version !== 1)
        throw new Error(
          `unknown payload version ${String((payload as { version: unknown }).version)}`,
        );
      instructions = payload.instructions.map(decodeInstruction);
    } catch (cause) {
      return err(rejected('the Proposal payload is not readable', extractMessage(cause)));
    }
    if (payload.member !== this.proposerAddress || payload.multisig !== this.multisig.toBase58()) {
      return err(rejected('the Proposal was built for a different multisig or member key'));
    }
    const sizeError = this.checkSize(instructions);
    if (sizeError) return err(sizeError);
    return this.signAsMember(instructions);
  }

  /**
   * Signs `instructions` as the member (the fee payer, the only signer) over
   * a fresh blockhash, recording its validity so a later send can prove
   * expiry. Shared by the propose and the close.
   */
  private async signAsMember(
    instructions: TransactionInstruction[],
  ): Promise<Result<SignedProposal, DispatchError>> {
    let blockhash: string;
    let lastValidBlockHeight: number;
    try {
      ({ blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed'));
    } catch (cause) {
      return err(rpcError('failed to fetch a recent blockhash before signing', cause));
    }

    const tx = new Transaction({ feePayer: this.member, blockhash, lastValidBlockHeight }).add(
      ...instructions,
    );
    const signResult = await this.signerClient.requestSignature({
      chain: 'solana',
      curve: 'ed25519',
      address: this.proposerAddress,
      unsignedTransaction: tx.compileMessage().serialize().toString('base64'),
    });
    if (!signResult.ok) {
      this.logger.warn({ error: signResult.error }, 'signer request failed');
      return signResult;
    }

    const signature = Buffer.from(signResult.value.signature, 'base64');
    tx.addSignature(this.member, signature);
    if (!tx.verifySignatures()) {
      return err({
        code: 'SIGNER_UNREACHABLE',
        message: `signer returned a signature that does not verify for address ${this.proposerAddress}`,
      });
    }

    const hash = bs58.encode(signature);
    this.lastValidByHash.set(hash, lastValidBlockHeight);
    return ok({
      signedBytes: tx
        .serialize({ requireAllSignatures: true, verifySignatures: false })
        .toString('base64'),
      hash,
    });
  }

  // ---- sending -----------------------------------------------------------------------------

  /**
   * Sends the signed bytes and waits for them to land, polling
   * `getSignatureStatuses` (the devnet RPC has no websocket). Idempotent: a
   * transaction already seen landed counts as success, and the same bytes are
   * sent again while it is not, which can never execute twice. A blockhash
   * proven expired (by block height, with the handler's lag margin) returns
   * `RPC_UNAVAILABLE` with `chainDetail.reason = 'BLOCKHASH_EXPIRED'`: the
   * caller keeps the Proposal and signs the same payload again later.
   */
  async submitProposal(signed: SignedProposal): Promise<Result<void, DispatchError>> {
    let raw: Buffer;
    let hash: string;
    try {
      raw = Buffer.from(signed.signedBytes, 'base64');
      const signature = VersionedTransaction.deserialize(raw).signatures[0];
      if (!signature) throw new Error('no signature');
      hash = bs58.encode(signature);
    } catch (cause) {
      return err(
        rejected('the signed Proposal is not a decodable transaction', extractMessage(cause)),
      );
    }
    if (hash !== signed.hash) {
      return err(rejected('the signed Proposal does not match its hash'));
    }

    let lastValid = this.lastValidByHash.get(hash);
    if (lastValid === undefined) {
      // Signed before a restart: the tip now plus the validity window bounds it from above, so expiry is proven late, never early.
      try {
        lastValid = (await this.connection.getBlockHeight('confirmed')) + BLOCKHASH_VALIDITY_BLOCKS;
      } catch (cause) {
        return err(rpcError('failed to read the block height before sending', cause));
      }
      this.lastValidByHash.set(hash, lastValid);
    }

    let lastSentAt = Number.NEGATIVE_INFINITY;
    for (;;) {
      let landed: Landed;
      let expired = false;
      try {
        landed = await this.landed(hash);
        if (landed.type === 'unseen') {
          const height = await this.connection.getBlockHeight('confirmed');
          if (height > lastValid + EXPIRY_MARGIN_BLOCKS) {
            // Re-checked after the proof: one that landed in its last valid blocks shows now.
            landed = await this.landed(hash);
            expired = landed.type === 'unseen';
          }
        }
      } catch (cause) {
        return err(rpcError('failed to check the Proposal transaction status', cause));
      }
      if (landed.type === 'confirmed') return ok(undefined);
      if (landed.type === 'failed') {
        return err(
          rejected('Solana reported the Proposal transaction as failed', landed.chainDetail),
        );
      }
      if (expired) {
        return err({
          code: 'RPC_UNAVAILABLE',
          message:
            'the Proposal transaction expired before it landed; sign the same payload again and resend',
          chainDetail: { reason: 'BLOCKHASH_EXPIRED', hash },
        });
      }

      if (Date.now() - lastSentAt >= this.resendIntervalMs) {
        lastSentAt = Date.now();
        try {
          await this.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
        } catch (cause) {
          const message = extractMessage(cause);
          // Already processed: it landed, status says so next. A lagging node's "Blockhash not found": the validity window decides.
          if (!/already (been )?processed/i.test(message) && !isBlockhashExpiryMessage(message)) {
            this.logger.warn({ hash, error: message }, 'sending the Proposal transaction failed');
            return err(mapSolanaFailure(cause));
          }
        }
      }
      await sleep(this.pollIntervalMs);
    }
  }

  private async landed(hash: string): Promise<Landed> {
    const { value } = await this.connection.getSignatureStatuses([hash], {
      searchTransactionHistory: true,
    });
    const status = value[0];
    if (!status) return { type: 'unseen' };
    if (status.err) return { type: 'failed', chainDetail: status.err };
    if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
      return { type: 'confirmed' };
    }
    return { type: 'unseen' };
  }

  // ---- cost --------------------------------------------------------------------------------

  /**
   * What proposing these Calls costs the member key, for the Funding Check:
   * the propose fee, one execute fee, and the rent of every vault transaction
   * and Proposal account (`rentLocked`, returned when closed), plus the rent
   * of the recipient token accounts the vault will create (paid by the vault
   * at execution, counted here too so the estimate never under-asks).
   */
  async estimateApprovalCost(
    calls: SolanaCall[],
    sender: string,
  ): Promise<Result<ApprovalCost, DispatchError>> {
    if (sender !== this.vault) {
      return err(rejected(`this Multisig Sender's vault is ${this.vault}, not ${sender}`));
    }
    const plan = this.planBundles(calls);
    if (!plan.ok) return plan;
    const account = await this.readAccount();
    if (!account.ok) return account;

    let amount = 0n;
    let rentLocked = 0n;
    const ataSeen = new Map<string, bigint>();
    for (const bundle of plan.value) {
      const quote = await this.quote(
        bundle.map((i) => calls[i]!),
        account.value,
        ataSeen,
      );
      if (!quote.ok) return quote;
      const { fee, rent, ataRent } = quote.value.cost;
      amount += fee + BigInt(LAMPORTS_PER_SIGNATURE) + rent + ataRent;
      rentLocked += rent;
    }
    return ok({
      asset: NATIVE_ASSET_SYMBOL,
      amount: amount.toString(),
      rentLocked: rentLocked.toString(),
    });
  }

  // ---- #75: reading, executing and closing -------------------------------------------------

  /**
   * What the chain says about a Proposal, read from the Proposal and the
   * multisig account at one slot and one commitment. Closed Proposals vanish
   * (spike #70): a missing account is `executed` when the history holds an
   * execute of it, and otherwise `unknown`, never a guess. A stale Proposal
   * that was not Approved is dead (`stale`); a stale Approved one still
   * executes, so it stays `approved`. The time lock counts from the moment of
   * approval.
   */
  async readProposal(ref: ChainProposalRef): Promise<Result<ProposalSnapshot, DispatchError>> {
    const target = this.squadsRef(ref);
    if (!target.ok) return target;
    const state = await this.readState(target.value);
    if (!state.ok) return state;
    const { proposal, multisig } = state.value;

    if (proposal === undefined) {
      const found = await this.findExecution(target.value);
      if (!found.ok) return found;
      if (found.value === undefined) {
        // Never invent an outcome: it may be a node that has not seen the account yet.
        return ok({
          status: 'unknown',
          approvals: 0,
          threshold: multisig.threshold,
          executable: false,
        });
      }
      this.logger.info(
        {
          proposal: target.value.toBase58(),
          executedHash: found.value.hash,
          executor: found.value.executor,
        },
        'proposal account is closed and its execution is in the history',
      );
      // It was approved by `threshold` members to execute at all.
      return ok({
        status: 'executed',
        approvals: multisig.threshold,
        threshold: multisig.threshold,
        executedHash: found.value.hash,
        executable: false,
      });
    }

    const snapshot = this.snapshotOf(proposal, multisig);
    if (snapshot.status === 'executed') {
      const found = await this.findExecution(target.value);
      if (!found.ok) return found;
      if (found.value) {
        this.logger.info(
          {
            proposal: target.value.toBase58(),
            executedHash: found.value.hash,
            executor: found.value.executor,
          },
          'proposal executed',
        );
        snapshot.executedHash = found.value.hash;
      }
    }
    return ok(snapshot);
  }

  private snapshotOf(proposal: ProposalAccount, multisig: MultisigAccount): ProposalSnapshot {
    const base = {
      approvals: proposal.approved.length,
      threshold: multisig.threshold,
      executable: false,
    };
    switch (proposal.status) {
      case 'executed':
        return { ...base, status: 'executed' };
      case 'rejected':
        return { ...base, status: 'rejected' };
      case 'cancelled':
        return { ...base, status: 'cancelled' };
      case 'executing':
        // Deprecated and never at rest: not something to act on.
        return { ...base, status: 'unknown' };
      case 'approved': {
        // Stale and Approved still executes (spike #70).
        const timeLock = multisig.timeLockSeconds;
        if (timeLock === 0 || proposal.statusTimestamp === undefined) {
          return { ...base, status: 'approved', executable: true };
        }
        const executeAfter = new Date((proposal.statusTimestamp + timeLock) * 1000);
        return {
          ...base,
          status: 'approved',
          executeAfter,
          executable: this.now().getTime() >= executeAfter.getTime(),
        };
      }
      case 'draft':
      case 'active':
        // Stale and not Approved can never be decided: it is dead and only closable.
        return proposal.transactionIndex <= multisig.staleTransactionIndex
          ? { ...base, status: 'stale' }
          : { ...base, status: 'active' };
    }
  }

  /** The Proposal address of a Squads ref for this engine's multisig. */
  private squadsRef(ref: ChainProposalRef): Result<PublicKey, DispatchError> {
    if (ref.kind !== 'squads' || ref.multisig !== this.multisig.toBase58()) {
      return err(rejected('this Proposal belongs to a different multisig', { ref }));
    }
    try {
      return ok(new PublicKey(ref.proposal));
    } catch {
      return err(rejected(`the Proposal address ${ref.proposal} is not a valid address`));
    }
  }

  /** The Proposal (undefined when it does not exist) and the multisig, read together. */
  private async readState(
    proposalAddress: PublicKey,
  ): Promise<
    Result<{ proposal: ProposalAccount | undefined; multisig: MultisigAccount }, DispatchError>
  > {
    let infos;
    try {
      ({ value: infos } = await this.connection.getMultipleAccountsInfoAndContext(
        [proposalAddress, this.multisig],
        MULTISIG_READ_COMMITMENT,
      ));
    } catch (cause) {
      return err(rpcError('failed to read the Proposal and multisig accounts', cause));
    }
    const [proposalInfo, multisigInfo] = infos;
    if (!multisigInfo || !multisigInfo.owner.equals(SQUADS_PROGRAM_ID)) {
      return err(rejected(`the multisig ${this.multisig.toBase58()} is not a Squads v4 account`));
    }
    let multisig: MultisigAccount;
    try {
      multisig = decodeMultisigAccount(multisigInfo.data);
    } catch (cause) {
      return err(rejected('the multisig account could not be decoded', extractMessage(cause)));
    }
    if (!proposalInfo) return ok({ proposal: undefined, multisig });
    if (!proposalInfo.owner.equals(SQUADS_PROGRAM_ID)) {
      return err(rejected(`${proposalAddress.toBase58()} is not owned by Squads v4`));
    }
    let proposal: ProposalAccount;
    try {
      proposal = decodeProposalAccount(proposalInfo.data);
    } catch (cause) {
      return err(rejected('the Proposal account could not be decoded', extractMessage(cause)));
    }
    if (proposal.multisig !== this.multisig.toBase58()) {
      return err(rejected('the Proposal belongs to a different multisig'));
    }
    return ok({ proposal, multisig });
  }

  /**
   * The successful transaction that executed a Proposal, from the Proposal
   * address's own history (it lists the create, every vote, the execute and
   * the close, and outlives the accounts): the one whose logs name
   * `VaultTransactionExecute`. Its fee payer is whoever executed it. A history
   * the RPC cannot answer is an error, never "not executed".
   */
  private async findExecution(
    proposalAddress: PublicKey,
  ): Promise<Result<{ hash: string; executor: string } | undefined, DispatchError>> {
    try {
      const signatures = await this.connection.getSignaturesForAddress(
        proposalAddress,
        { limit: HISTORY_LIMIT },
        'confirmed',
      );
      for (const entry of signatures) {
        if (entry.err) continue;
        const tx = await this.connection.getTransaction(entry.signature, {
          commitment: 'confirmed',
          maxSupportedTransactionVersion: 0,
        });
        if (!tx || tx.meta?.err) continue;
        const logs = tx.meta?.logMessages ?? [];
        if (!logs.some((line) => line.includes('Instruction: VaultTransactionExecute'))) continue;
        const executor = tx.transaction.message.staticAccountKeys[0]?.toBase58() ?? 'unknown';
        return ok({ hash: entry.signature, executor });
      }
    } catch (cause) {
      return err(rpcError("failed to read the Proposal's transaction history", cause));
    }
    return ok(undefined);
  }

  /**
   * The `vaultTransactionExecute` for an approved Proposal: the stored vault
   * transaction is read from the chain, its inner accounts resolved as the
   * SDK's execute helper does, with the largest heap frame and a compute-unit
   * limit from a simulation, the member key paying. The result is the same
   * opaque shape the Solana handler's `sign` takes, so signing, the write-down
   * before the send and the expiry machinery work unchanged. A simulation
   * that fails with `TimeLockNotReleased` is not an error of the Proposal:
   * it is `RPC_UNAVAILABLE`, which the watch loop retries; any other
   * simulation failure is returned as the program's error.
   */
  async prepareExecution(proposal: Proposal): Promise<Result<PreparedTransaction, DispatchError>> {
    const ref = proposal.chainRef;
    if (ref.kind !== 'squads' || ref.multisig !== this.multisig.toBase58()) {
      return err(rejected('this Proposal belongs to a different multisig', { ref }));
    }
    const index = BigInt(ref.transactionIndex);
    const transactionAddress = deriveTransactionPda(this.multisig, index);

    let info;
    try {
      info = await this.connection.getAccountInfo(transactionAddress, MULTISIG_READ_COMMITMENT);
    } catch (cause) {
      return err(rpcError('failed to read the vault transaction', cause));
    }
    if (!info || !info.owner.equals(SQUADS_PROGRAM_ID)) {
      return err(
        rejected(
          `the vault transaction ${transactionAddress.toBase58()} does not exist (closed?)`,
          { reason: 'VAULT_TRANSACTION_MISSING' },
        ),
      );
    }

    let execute: TransactionInstruction;
    try {
      const vaultTransaction = decodeVaultTransactionAccount(info.data);
      if (
        vaultTransaction.multisig !== this.multisig.toBase58() ||
        vaultTransaction.index !== index ||
        vaultTransaction.vaultIndex !== SENDER_VAULT_INDEX
      ) {
        return err(
          rejected("the vault transaction is not this Proposal's, or is not for the Sender vault"),
        );
      }
      execute = vaultTransactionExecuteInstruction({
        multisig: this.multisig,
        transactionIndex: index,
        member: this.member,
        vaultTransaction,
      });
    } catch (cause) {
      return err(rejected('the vault transaction cannot be executed', extractMessage(cause)));
    }

    const build = (unitLimit: number): TransactionInstruction[] => [
      ComputeBudgetProgram.requestHeapFrame({ bytes: EXECUTE_HEAP_BYTES }),
      ComputeBudgetProgram.setComputeUnitLimit({ units: unitLimit }),
      execute,
    ];

    let simulation;
    try {
      const message = new Transaction({
        feePayer: this.member,
        blockhash: PublicKey.default.toBase58(), // replaced by the simulation
        lastValidBlockHeight: 0,
      })
        .add(...build(MAX_COMPUTE_UNITS))
        .compileMessage();
      simulation = await this.connection.simulateTransaction(new VersionedTransaction(message), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      });
    } catch (cause) {
      return err(rpcError('failed to simulate the execute transaction', cause));
    }

    const { err: simulationError, logs, unitsConsumed } = simulation.value;
    if (simulationError) {
      if (customErrorCode(simulationError) === TIME_LOCK_NOT_RELEASED) {
        return err({
          code: 'RPC_UNAVAILABLE',
          message:
            "the Proposal's time lock has not been released yet; the execute is tried again later",
          chainDetail: { reason: 'TIME_LOCK_NOT_RELEASED', error: simulationError },
        });
      }
      this.logger.warn(
        { proposalId: proposal.id, error: simulationError, logs },
        'the execute simulation failed',
      );
      return err(
        rejected('the execute transaction failed its simulation', { error: simulationError, logs }),
      );
    }
    const units =
      unitsConsumed === undefined
        ? MAX_COMPUTE_UNITS
        : Math.min(
            MAX_COMPUTE_UNITS,
            Math.max(MIN_EXECUTE_UNITS, Math.ceil(unitsConsumed * EXECUTE_UNITS_MARGIN)),
          );
    this.logger.debug(
      { proposalId: proposal.id, unitsConsumed, unitLimit: units },
      'execute simulated',
    );

    return ok({
      callIndex: 0,
      unsignedTransaction: encodeUnsignedTransaction({
        // Fresh every time: the handler signs one transaction per chunkNonce, and a resubmitted execute is a new one.
        chunkNonce: randomUUID(),
        feePayer: this.proposerAddress,
        instructions: build(units).map(encodeInstruction),
      }),
    });
  }

  /**
   * Sends the permissionless `vaultTransactionAccountsClose`, signed by the
   * member key, to return both accounts' rent to the multisig's rent
   * collector. Only an Executed, Rejected or Cancelled Proposal, or one that
   * is stale and not Approved, can be closed (anything else fails on chain),
   * and only a multisig with a rent collector can reclaim (otherwise the
   * result says so and nothing is sent). Idempotent: an account that is
   * already gone is success. Never changes what the Calls reported.
   */
  async closeProposal(proposal: Proposal): Promise<Result<void, DispatchError>> {
    const target = this.squadsRef(proposal.chainRef);
    if (!target.ok) return target;
    if (proposal.chainRef.kind !== 'squads') return err(rejected('not a Squads Proposal'));
    const index = BigInt(proposal.chainRef.transactionIndex);
    const log = this.logger.child({ proposalId: proposal.id, proposal: target.value.toBase58() });

    const state = await this.readState(target.value);
    if (!state.ok) return state;
    if (state.value.proposal === undefined) {
      log.info('proposal already closed');
      return ok(undefined);
    }
    const snapshot = this.snapshotOf(state.value.proposal, state.value.multisig);
    const closable =
      snapshot.status === 'executed' ||
      snapshot.status === 'rejected' ||
      snapshot.status === 'cancelled' ||
      snapshot.status === 'stale';
    if (!closable) {
      return err(
        rejected(`a Proposal that is ${snapshot.status} cannot be closed yet`, {
          reason: 'NOT_CLOSABLE',
          status: snapshot.status,
        }),
      );
    }
    const collector = state.value.multisig.rentCollector;
    if (collector === undefined) {
      log.warn(
        'the multisig has no rent collector: the rent of this finished proposal cannot be reclaimed',
      );
      return err(
        rejected('the multisig has no rent collector, so the proposal accounts cannot be closed', {
          reason: 'RENT_RECLAMATION_DISABLED',
        }),
      );
    }

    const signed = await this.signAsMember([
      vaultTransactionAccountsCloseInstruction({
        multisig: this.multisig,
        transactionIndex: index,
        rentCollector: new PublicKey(collector),
        proposal: target.value,
      }),
    ]);
    if (!signed.ok) return signed;
    const sent = await this.submitProposal(signed.value);
    if (sent.ok) {
      log.info({ hash: signed.value.hash, rentCollector: collector }, 'proposal closed');
      return sent;
    }
    // Someone else may have closed it first: gone is success.
    const again = await this.readState(target.value);
    if (again.ok && again.value.proposal === undefined) {
      log.info('proposal was closed by someone else');
      return ok(undefined);
    }
    return sent;
  }
}

/** The program's error number of a failed transaction: `{ InstructionError: [index, { Custom: n }] }`. */
function customErrorCode(error: unknown): number | undefined {
  if (typeof error !== 'object' || error === null) return undefined;
  const instructionError = (error as { InstructionError?: unknown }).InstructionError;
  if (!Array.isArray(instructionError)) return undefined;
  const detail = instructionError[1] as { Custom?: unknown } | undefined;
  return typeof detail === 'object' && detail !== null && typeof detail.Custom === 'number'
    ? detail.Custom
    : undefined;
}

function toAmounts(totals: Map<string, bigint>): AssetAmount[] {
  return [...totals.entries()]
    .sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0))
    .map(([asset, amount]) => ({ asset, amount: amount.toString() }));
}
