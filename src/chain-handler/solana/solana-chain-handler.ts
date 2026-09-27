import { createPublicKey, randomUUID, verify as verifySignature } from 'node:crypto';

import { getAccount, TokenAccountNotFoundError } from '@solana/spl-token';
import bs58 from 'bs58';
import {
  ComputeBudgetProgram,
  Connection,
  PACKET_DATA_SIZE,
  PublicKey,
  Transaction,
  TransactionInstruction,
  VersionedTransaction,
} from '@solana/web3.js';
import type { Logger } from 'pino';

import type { CallForChain, Payment, SolanaAccountMeta, SolanaCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';
import { logger as defaultLogger } from '../../logger.js';
import { SignerClient } from '../../signer/client.js';
import type {
  Balance,
  BroadcastResult,
  ChainHandler,
  ChainStatus,
  PreparedTransaction,
  SignedTransaction,
  UnsignedTransaction,
} from '../chain-handler.js';
import { deriveAssociatedTokenAddress } from './account-resolution.js';
import { extractMessage, isBlockhashExpiryMessage, mapSolanaFailure } from './error-mapping.js';
import { validateGenericCall } from './contract-call.js';
import { isNativeTransferCall, toTransactionInstructions } from './instruction-codec.js';
import {
  NATIVE_ASSET_SYMBOL,
  resolveKnownToken,
  type SolanaTokenRegistry,
} from './known-tokens.js';
import {
  buildNativeTransferCall,
  parsePublicKey,
  validateNativeTransferCall,
} from './native-transfer.js';
import {
  buildSplTransferCall,
  isSplTransferCall,
  validateSplTransferCall,
} from './spl-transfer.js';

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}

/**
 * The Coordinator's `abandonmentTimeoutMs` config value for `'solana'`
 * (ADR-0030) — a fallback safety net only, comfortably past a blockhash's
 * ~60-90s validity window, for the one case `getStatus`'s own
 * provable-expiry check can't cover (no `blockhashByHash` record for the
 * hash). In ordinary operation `getStatus` itself reports EXPIRED well
 * before this fires, and `restoreInFlight` rebuilds the records after a
 * restart (ADR-0042).
 */
export const SOLANA_ABANDONMENT_TIMEOUT_MS = 120_000;

/**
 * issue 10: bundles multiple Calls into one transaction via Solana's native
 * multi-instruction support (ADR-0006's Solana-specific answer to batching;
 * no separate Bulk Call concept needed here), at most this many per bundle.
 * #34: a bundle also stops growing before it would pass the 1232-byte
 * transaction limit (`prepare` measures it). Measured (signed, legacy): 8
 * native transfers ~560 bytes, 8 SPL payments of one mint ~1020, but SPL
 * payments of distinct mints (create-ATA + transferChecked each) pass the
 * limit at 7 — the earlier "10 fit" measurement was wrong.
 */
const MAX_BUNDLE_SIZE = 8;

/** Solana's per-transaction compute ceiling: the placeholder limit `prepare` reserves room for, and what `sign` simulates under (#37). */
const MAX_COMPUTE_UNITS = 1_400_000;
/** Headroom over simulated usage (#37): real execution can differ slightly from the simulation, and running out fails the transaction. */
const COMPUTE_UNIT_MARGIN = 1.1;
/** ComputeBudget's SetComputeUnitLimit instruction discriminator. */
const SET_COMPUTE_UNIT_LIMIT = 2;

/** How often `broadcast` resends the identical signed bytes while it waits: leaders drop transactions under load, and resending the same bytes can never execute them twice. */
const RESEND_INTERVAL_MS = 2_000;

/** The opaque `UnsignedTransaction` encoding this Chain Handler chooses (ADR-0027) — its shape is this file's own business, never assumed elsewhere. */
type EncodedInstruction = { programId: string; keys: SolanaAccountMeta[]; data: string };
/**
 * `chunkNonce` ties every item bundled into the same transaction together
 * (issue 10) — generated once per chunk in `prepare`, including for a
 * solo, unbundled item (its own unique chunk of size 1), so two otherwise
 * byte-identical Calls prepared separately never accidentally collide in
 * `signedByChunk` below.
 */
type EncodedTransaction = {
  chunkNonce: string;
  feePayer: string;
  instructions: EncodedInstruction[];
};

/** Bytes these instructions take as a signed, single-signer legacy transaction — the blockhash is 32 bytes whatever its value. */
function signedSize(feePayer: PublicKey, instructions: TransactionInstruction[]): number {
  const tx = new Transaction({ feePayer, blockhash: PublicKey.default.toBase58(), lastValidBlockHeight: 0 });
  tx.add(...instructions);
  try {
    return 1 + 64 + tx.compileMessage().serialize().length; // signature count + one signature + message
  } catch {
    return Infinity; // web3.js throws outright once the instructions alone pass the limit
  }
}

// RFC 8410 SPKI wrapper for a raw 32-byte Ed25519 public key.
const ED25519_SPKI_PREFIX = Buffer.from('302a300506032b6570032100', 'hex');

/** The fee payer's signature — the transaction's id — or undefined when that slot is unsigned (all zeroes). */
function feePayerSignature(tx: VersionedTransaction): Uint8Array | undefined {
  const signature = tx.signatures[0];
  return signature && signature.some((byte) => byte !== 0) ? signature : undefined;
}

/** Every required signer's signature verifies over the message — legacy and v0 alike. */
function allSignaturesVerify(tx: VersionedTransaction): boolean {
  const message = tx.message.serialize();
  const signers = tx.message.staticAccountKeys.slice(0, tx.message.header.numRequiredSignatures);
  return signers.every((signer, i) => {
    const signature = tx.signatures[i];
    if (!signature) return false;
    const key = createPublicKey({
      key: Buffer.concat([ED25519_SPKI_PREFIX, signer.toBuffer()]),
      format: 'der',
      type: 'spki',
    });
    return verifySignature(null, message, key, signature);
  });
}

function encodeInstruction(instruction: TransactionInstruction): EncodedInstruction {
  return {
    programId: instruction.programId.toBase58(),
    keys: instruction.keys.map((k) => ({
      pubkey: k.pubkey.toBase58(),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: instruction.data.toString('base64'),
  };
}

function decodeInstruction(encoded: EncodedInstruction): TransactionInstruction {
  return new TransactionInstruction({
    programId: new PublicKey(encoded.programId),
    keys: encoded.keys.map((k) => ({
      pubkey: new PublicKey(k.pubkey),
      isSigner: k.isSigner,
      isWritable: k.isWritable,
    })),
    data: Buffer.from(encoded.data, 'base64'),
  });
}

function encodeUnsignedTransaction(tx: EncodedTransaction): UnsignedTransaction {
  return Buffer.from(JSON.stringify(tx)).toString('base64');
}

function decodeUnsignedTransaction(unsigned: UnsignedTransaction): EncodedTransaction {
  return JSON.parse(Buffer.from(unsigned, 'base64').toString('utf8')) as EncodedTransaction;
}


export type SolanaChainHandlerDeps = {
  connection: Connection;
  /**
   * Only needed if this handler ever builds+signs a Managed Dispatch
   * transaction (`sign`). A Relay-Dispatch-only deployment never
   * calls `sign` at all (the transaction always arrives already signed,
   * ADR-0005) and can omit this entirely, rather than needing to wire up
   * an unreachable placeholder just to satisfy the constructor.
   */
  signerClient?: SignerClient;
  /** Single-Sender-per-chain (ADR-0016) — the wallet paymentToCall encodes transfers from, before the Coordinator is ever involved. */
  senderAddress: string;
  /** Operator-configured symbol -> {mint, decimals} for SPL transfers (known-tokens.ts) — empty by default, never hardcoded. */
  knownTokens?: SolanaTokenRegistry;
  /**
   * #34: priority fee, in micro-lamports per compute unit, added to every
   * transaction this handler builds. 0 (the default) adds nothing: a
   * priority fee costs more, so it is the operator's opt-in (ADR-0003).
   */
  computeUnitPriceMicroLamports?: number;
  /** Defaults to the shared app logger (src/logger.ts) under a `component: 'solana-chain-handler'` binding. Injectable so tests/tools can point it elsewhere. */
  logger?: Logger;
};

/**
 * The first real Chain Handler (`.scratch/solana-chain-handler/spec.md`).
 * Built incrementally, issue by issue — see each method's doc comment for
 * which issue it belongs to.
 */
export class SolanaChainHandler implements ChainHandler<'solana'> {
  readonly chain = 'solana';

  private readonly connection: Connection;
  private readonly signerClient: SignerClient | undefined;
  private readonly senderAddress: string;
  private readonly knownTokens: SolanaTokenRegistry;
  private readonly computeUnitPriceMicroLamports: number;
  /**
   * `getStatus`'s only way to know whether a not-yet-confirmed transaction's
   * blockhash has provably expired (issue 08) — the interface hands it only
   * a hash, so `sign`/`broadcast` record hash -> blockhash here the moment
   * they know it, and `restoreInFlight` rebuilds it after a restart.
   */
  private readonly blockhashByHash = new Map<string, string>();
  /**
   * issue 10: one signature per bundle chunk, however many Calls share it —
   * see `sign`. Caches the in-flight *promise*, not just its resolved
   * value: the Coordinator signs one Call at a time so this never races in
   * practice, but caching only the resolved value would still let two
   * concurrent callers for the same chunk both slip past the check before
   * either finishes, producing two real signatures for one bundle.
   */
  private readonly signByChunk = new Map<
    string,
    Promise<Result<SignedTransaction, DispatchError>>
  >();
  private readonly logger: Logger;

  constructor(deps: SolanaChainHandlerDeps) {
    this.connection = deps.connection;
    this.signerClient = deps.signerClient;
    this.senderAddress = deps.senderAddress;
    this.knownTokens = deps.knownTokens ?? {};
    this.computeUnitPriceMicroLamports = deps.computeUnitPriceMicroLamports ?? 0;
    if (!Number.isSafeInteger(this.computeUnitPriceMicroLamports) || this.computeUnitPriceMicroLamports < 0) {
      throw new Error(
        `Solana compute-unit price must be a whole, non-negative number of micro-lamports, got ${deps.computeUnitPriceMicroLamports}`,
      );
    }
    this.logger = (deps.logger ?? defaultLogger).child({ component: 'solana-chain-handler' });
  }

  /** issues 02/03: encodes a plain transfer (native or a known SPL token) as a SolanaCall. No RPC (ADR-0028). */
  paymentToCall(payment: Payment): Promise<Result<CallForChain<'solana'>, DispatchError>> {
    if (payment.asset === NATIVE_ASSET_SYMBOL) {
      return Promise.resolve(
        buildNativeTransferCall(this.senderAddress, payment.recipient, BigInt(payment.amount)),
      );
    }

    const token = resolveKnownToken(this.knownTokens, payment.asset);
    if (!token) {
      return Promise.resolve(
        err({
          code: 'UNKNOWN_ASSET',
          message: `no known token configured for asset "${payment.asset}"`,
          chainDetail: { asset: payment.asset },
        }),
      );
    }

    return Promise.resolve(
      buildSplTransferCall(
        this.senderAddress,
        payment.recipient,
        token.mint,
        token.decimals,
        BigInt(payment.amount),
      ),
    );
  }

  /**
   * issues 02/03/(contract-call.ts): cheap shape validation only, dispatched
   * by which program the Call targets. Never an RPC round-trip.
   *
   * Previously mis-dispatched: anything that wasn't an SPL Token call fell
   * through to `validateNativeTransferCall`, which enforces an exact
   * 2-account shape and never checks `programId` at all — so a real
   * arbitrary contract call (CONTEXT.md's Call entry: "a beneficiary's own
   * application-defined contract call ... the engine submits without
   * needing to understand its semantics") with any other account count was
   * wrongly rejected before ever reaching `prepare`, which already handled
   * it correctly. Now dispatches on the actual program id, with a generic,
   * semantics-free fallback for everything that isn't System or Token.
   */
  validateCall(call: SolanaCall): Promise<Result<void, DispatchError>> {
    if (isSplTransferCall(call)) return Promise.resolve(validateSplTransferCall(call));
    if (isNativeTransferCall(call)) return Promise.resolve(validateNativeTransferCall(call));
    return Promise.resolve(validateGenericCall(call));
  }

  /**
   * issues 02/03/10: builds the real instruction(s) for each Call — one for
   * a plain transfer, [create-ATA, transferChecked] for an SPL transfer
   * whose destination might not exist yet (instruction-codec.ts) — then
   * bundles consecutive Calls into chunks of up to `MAX_BUNDLE_SIZE`,
   * sharing one real transaction per chunk (issue 10). Still returns
   * exactly one `PreparedTransaction` per input Call, in order (the
   * conformance suite's own contract): items in the same chunk get
   * byte-identical `unsignedTransaction` encodings, tied together by a
   * `chunkNonce` so `sign` (below) only ever asks the Signer once per
   * chunk. Deliberately does not touch a blockhash at all (issue 04:
   * fetched immediately before signing, not here, or it goes stale under
   * batch volume).
   */
  prepare(
    items: SolanaCall[],
    senderAddress: string,
  ): Promise<Result<PreparedTransaction[], DispatchError>> {
    const feePayer = parsePublicKey(senderAddress);
    if (!feePayer.ok) return Promise.resolve(feePayer);

    const chunks: SolanaCall[][] = [];
    let current: SolanaCall[] = [];
    for (const call of items) {
      const candidate = [...current, call];
      const full =
        candidate.length > MAX_BUNDLE_SIZE ||
        signedSize(feePayer.value, this.instructionsFor(candidate, feePayer.value)) > PACKET_DATA_SIZE;
      if (current.length > 0 && full) {
        chunks.push(current);
        current = [call];
      } else {
        current = candidate;
      }
    }
    if (current.length > 0) chunks.push(current);

    const prepared: PreparedTransaction[] = [];
    for (const chunk of chunks) {
      const encoded: EncodedTransaction = {
        chunkNonce: randomUUID(),
        feePayer: senderAddress,
        instructions: this.instructionsFor(chunk, feePayer.value).map(encodeInstruction),
      };
      const unsignedTransaction = encodeUnsignedTransaction(encoded);
      chunk.forEach(() => prepared.push({ callIndex: prepared.length, unsignedTransaction }));
    }

    return Promise.resolve(ok(prepared));
  }

  /**
   * One transaction's instructions for `calls`, each Call's own after, when
   * a priority fee is configured (#34), a placeholder compute-unit limit
   * and the price. `sign` swaps the placeholder for the simulated usage
   * (#37): the fee is charged on the requested limit, not what's used.
   */
  private instructionsFor(calls: SolanaCall[], feePayer: PublicKey): TransactionInstruction[] {
    const instructions = calls.flatMap((call) => toTransactionInstructions(call, feePayer));
    if (this.computeUnitPriceMicroLamports > 0) {
      instructions.unshift(
        ComputeBudgetProgram.setComputeUnitLimit({ units: MAX_COMPUTE_UNITS }),
        ComputeBudgetProgram.setComputeUnitPrice({ microLamports: this.computeUnitPriceMicroLamports }),
      );
    }
    return instructions;
  }

  /**
   * #37: replaces `prepare`'s placeholder compute-unit limit with the
   * simulated usage plus margin, so the priority fee is paid on what the
   * transaction needs. A failed simulation drops the limit instead (the
   * chain's default applies) and the send's own preflight reports the
   * real error. Instructions without the placeholder are returned as-is.
   */
  private async withSimulatedComputeUnitLimit(
    feePayer: PublicKey,
    instructions: TransactionInstruction[],
    blockhash: string,
    log: Logger,
  ): Promise<TransactionInstruction[]> {
    const [first, ...rest] = instructions;
    if (!first?.programId.equals(ComputeBudgetProgram.programId) || first.data[0] !== SET_COMPUTE_UNIT_LIMIT) {
      return instructions;
    }
    try {
      const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight: 0 }).add(...instructions);
      const { value } = await this.connection.simulateTransaction(new VersionedTransaction(tx.compileMessage()), {
        sigVerify: false,
        replaceRecentBlockhash: true,
        commitment: 'confirmed',
      });
      if (value.err || !value.unitsConsumed) {
        log.debug({ error: value.err }, 'compute-unit simulation failed — no limit set');
        return rest;
      }
      const units = Math.min(MAX_COMPUTE_UNITS, Math.ceil(value.unitsConsumed * COMPUTE_UNIT_MARGIN));
      return [ComputeBudgetProgram.setComputeUnitLimit({ units }), ...rest];
    } catch (cause) {
      log.debug({ error: extractMessage(cause) }, 'compute-unit simulation failed — no limit set');
      return rest;
    }
  }

  /**
   * issue 04: fetches a fresh blockhash right before signing (not in
   * `prepare` — a blockhash fetched too early goes stale under batch
   * volume, per the reference implementation's own documented incident),
   * compiles the message, delegates to the Signer client for the `ed25519`
   * curve, and attaches the returned signature.
   *
   * issue 10: when `prepared` is one of several PreparedTransactions
   * sharing a bundle (identical `unsignedTransaction`, tied together by
   * `chunkNonce`), only the first call actually signs — the rest return the
   * same cached signature rather than asking the Signer again for the
   * identical transaction and, more importantly, rather than producing a
   * *second, differently-blockhashed* signed transaction for the same
   * bundle. That second signature would itself be safe to broadcast
   * (Solana's own signature-based dedup makes resubmitting truly identical
   * bytes a no-op), but it would still legitimately re-execute every
   * instruction in the bundle a second time if it used a different
   * blockhash — this cache is what keeps a bundle a single execution no
   * matter how many of its Calls individually call `sign`.
   */
  async sign(
    prepared: PreparedTransaction,
    senderAddress: string,
  ): Promise<Result<SignedTransaction, DispatchError>> {
    const encoded = decodeUnsignedTransaction(prepared.unsignedTransaction);
    if (encoded.feePayer !== senderAddress) {
      return err({
        code: 'INVALID_RECIPIENT',
        message: `PreparedTransaction was built for ${encoded.feePayer}, asked to sign as ${senderAddress}`,
      });
    }

    const inFlight = this.signByChunk.get(encoded.chunkNonce);
    if (inFlight) return inFlight;

    const promise = this.signInstructions(
      new PublicKey(senderAddress),
      encoded.instructions.map(decodeInstruction),
    );
    this.signByChunk.set(encoded.chunkNonce, promise);

    const result = await promise;
    if (!result.ok) this.signByChunk.delete(encoded.chunkNonce); // don't permanently cache a failure — a later legitimate retry should get a fresh attempt
    return result;
  }

  /** Always fetches its own fresh blockhash, so a resubmission (ADR-0042) really is a new signature over a new message. */
  private async signInstructions(
    feePayer: PublicKey,
    instructions: TransactionInstruction[],
  ): Promise<Result<SignedTransaction, DispatchError>> {
    const senderAddress = feePayer.toBase58();
    const log = this.logger.child({ senderAddress });

    if (!this.signerClient) {
      log.warn('asked to sign but no Signer is configured for this ChainHandler');
      return err({
        code: 'SIGNER_UNREACHABLE',
        message:
          'no Signer configured for this ChainHandler — a Relay-Dispatch-only deployment never signs, so signerClient was never provided',
      });
    }
    log.debug({ instructionCount: instructions.length }, 'signing instructions');

    // prepare keeps bundles under the limit; a single Call can still be too big on its own.
    const size = signedSize(feePayer, instructions);
    if (size > PACKET_DATA_SIZE) {
      return err({
        code: 'CHAIN_REJECTED',
        message: `transaction would be ${size} bytes, over Solana's ${PACKET_DATA_SIZE}-byte limit`,
      });
    }

    let blockhash: string;
    let lastValidBlockHeight: number;
    try {
      ({ blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed'));
    } catch (cause) {
      log.warn(
        { error: extractMessage(cause) },
        'failed to fetch a recent blockhash before signing',
      );
      return err({
        code: 'RPC_UNAVAILABLE',
        message: 'failed to fetch a recent blockhash before signing',
        chainDetail: extractMessage(cause),
      });
    }

    const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
    tx.add(...(await this.withSimulatedComputeUnitLimit(feePayer, instructions, blockhash, log)));

    const message = tx.compileMessage().serialize();
    const signResult = await this.signerClient.requestSignature({
      chain: 'solana',
      curve: 'ed25519',
      address: senderAddress,
      unsignedTxBytes: message.toString('base64'),
    });
    if (!signResult.ok) {
      log.warn({ error: signResult.error }, 'signer request failed');
      return signResult;
    }

    const signatureBytes = Buffer.from(signResult.value.signature, 'base64');
    tx.addSignature(feePayer, signatureBytes);
    if (!tx.verifySignatures()) {
      log.warn('signer returned a signature that does not verify');
      return err({
        code: 'SIGNER_UNREACHABLE',
        message: `signer returned a signature that does not verify for address ${senderAddress}`,
      });
    }

    const hash = bs58.encode(signatureBytes);
    this.blockhashByHash.set(hash, blockhash);
    log.debug({ hash }, 'signed transaction');

    return ok(
      tx.serialize({ requireAllSignatures: true, verifySignatures: false }).toString('base64'),
    );
  }

  /**
   * ADR-0032: decodes the opaque signed-transaction string (via the shared
   * `decodeSignedTransaction` helper) and confirms it really is a signed
   * transaction: a signature present, that signature cryptographically
   * verifying, and a fee payer set. No RPC round-trip; a
   * structurally valid transaction that will fail on-chain for its own
   * reasons still gets broadcast and fails there, exactly like a Managed
   * Dispatch Call does (relay-dispatch's `validateSignedTransaction` is the
   * receiving-side counterpart to `validateCall`'s building-side check).
   */
  validateSignedTransaction(signed: SignedTransaction): Promise<Result<void, DispatchError>> {
    const decodedResult = this.decodeSignedTransaction(Buffer.from(signed, 'base64'));
    if (!decodedResult.ok) return Promise.resolve(decodedResult);
    const tx = decodedResult.value;

    if (tx.message.header.numRequiredSignatures === 0) {
      return Promise.resolve(
        err({ code: 'CHAIN_REJECTED', message: 'signed transaction has no fee payer' }),
      );
    }
    if (!feePayerSignature(tx)) {
      return Promise.resolve(
        err({ code: 'CHAIN_REJECTED', message: 'signed transaction has no signature' }),
      );
    }
    if (!allSignaturesVerify(tx)) {
      return Promise.resolve(
        err({
          code: 'CHAIN_REJECTED',
          message: 'signed transaction signature does not cryptographically verify',
        }),
      );
    }

    return Promise.resolve(ok(undefined));
  }

  /**
   * issues 05/15, ADR-0042: sends the signed bytes and waits for
   * confirmation against their blockhash, resending the identical bytes
   * every `RESEND_INTERVAL_MS` while it is still valid — a dropped
   * transaction lands on a later resend, and identical bytes can never
   * execute twice. Never re-signs: once the blockhash provably expires it
   * returns the same hash, `getStatus` reports EXPIRED, and the Coordinator
   * resubmits as a new Transaction written down first (ADR-0041). A
   * "Blockhash not found" at send time is not terminal either: the node
   * may just lag behind a fresh blockhash, and the validity window decides.
   * Bytes this handler never signed (a Relay Dispatch) are treated
   * identically, their blockhash read from the bytes (ADR-0033).
   */
  async broadcast(signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> {
    const raw = Buffer.from(signed, 'base64');
    const hashResult = this.transactionHash(signed);
    if (!hashResult.ok) return hashResult;
    const hash = hashResult.value;
    const blockhash = this.ensureBlockhashRecord(raw);

    try {
      await this.send(raw);
      this.logger.debug({ hash }, 'sendRawTransaction accepted');
    } catch (cause) {
      if (!blockhash || !isBlockhashExpiryMessage(extractMessage(cause))) {
        this.logger.warn({ hash, error: extractMessage(cause) }, 'sendRawTransaction failed');
        return err(mapSolanaFailure(cause));
      }
      this.logger.warn({ hash }, 'blockhash not found at send — waiting on its validity window');
    }
    if (!blockhash) return ok({ hash }); // defensive only — any decodable signed transaction has one

    const outcome = await this.waitUntilConfirmedOrExpired(hash, blockhash, raw);
    if (outcome.type === 'confirmed') {
      this.logger.info({ hash }, 'transaction confirmed');
      return ok({ hash });
    }
    if (outcome.type === 'failed') {
      this.logger.warn({ hash, chainDetail: outcome.chainDetail }, 'transaction reported failed');
      return err({
        code: 'CHAIN_REJECTED',
        message: `${this.chain} reported this transaction as failed`,
        chainDetail: outcome.chainDetail,
      });
    }
    if (outcome.type === 'error') {
      this.logger.warn({ hash, error: outcome.error }, 'status check failed while awaiting confirmation');
      return err(outcome.error);
    }
    this.logger.warn({ hash }, 'blockhash expired before confirmation — handing off to getStatus');
    return ok({ hash });
  }

  private send(raw: Buffer): Promise<string> {
    return this.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
  }

  /**
   * Polls plain HTTP JSON-RPC only — deliberately never
   * `connection.confirmTransaction`, which defaults to a WebSocket
   * `signatureSubscribe` subscription. Found the hard way (testing against
   * a real alternative RPC provider that doesn't expose that method):
   * `confirmTransaction` doesn't fall back to polling when the subscription
   * itself fails — it retries the broken subscribe call forever and never
   * resolves, hanging `broadcast` indefinitely on any RPC provider without
   * WebSocket support. `getSignatureStatuses` (already `getStatus`'s own
   * mechanism, issue 07) and `isBlockhashValid` (issue 08) are both plain
   * HTTP and work everywhere.
   */
  private async waitUntilConfirmedOrExpired(
    hash: string,
    blockhash: string,
    raw: Buffer,
  ): Promise<
    | { type: 'confirmed' }
    | { type: 'failed'; chainDetail: unknown }
    | { type: 'expired' }
    | { type: 'error'; error: DispatchError }
  > {
    const pollIntervalMs = 1_000;
    let lastSentAt = Date.now();
    for (;;) {
      let statuses: Awaited<ReturnType<Connection['getSignatureStatuses']>>;
      try {
        statuses = await this.connection.getSignatureStatuses([hash], {
          searchTransactionHistory: true,
        });
      } catch (cause) {
        return { type: 'error', error: mapSolanaFailure(cause) };
      }
      const status = statuses.value[0];
      if (status) {
        if (status.err) return { type: 'failed', chainDetail: status.err };
        if (
          status.confirmationStatus === 'confirmed' ||
          status.confirmationStatus === 'finalized'
        ) {
          return { type: 'confirmed' };
        }
      }

      let stillValid: boolean;
      try {
        ({ value: stillValid } = await this.connection.isBlockhashValid(blockhash, {
          commitment: 'confirmed',
        }));
      } catch (cause) {
        return { type: 'error', error: mapSolanaFailure(cause) };
      }
      if (!stillValid) return { type: 'expired' };

      // Not seen yet: resend. A refusal ("already processed", a lagging
      // node's "Blockhash not found") changes nothing — status decides.
      if (!status && Date.now() - lastSentAt >= RESEND_INTERVAL_MS) {
        lastSentAt = Date.now();
        await this.send(raw).catch((cause: unknown) =>
          this.logger.debug({ hash, error: extractMessage(cause) }, 'resend not accepted'),
        );
      }

      await sleep(pollIntervalMs);
    }
  }

  /** #20 (ADR-0041): a Solana transaction's id is its first (fee payer's) signature, base58 — exactly what sendRawTransaction reports. */
  transactionHash(signed: SignedTransaction): Result<string, DispatchError> {
    const decoded = this.decodeSignedTransaction(Buffer.from(signed, 'base64'));
    if (!decoded.ok) return decoded;
    const signature = feePayerSignature(decoded.value);
    if (!signature) {
      return err({ code: 'CHAIN_REJECTED', message: 'signed transaction carries no signature' });
    }
    return ok(bs58.encode(signature));
  }

  /**
   * The one place this handler turns opaque signed bytes back into a decoded
   * transaction, or a structured `CHAIN_REJECTED` if they aren't one
   * (ADR-0032). #36: legacy and versioned (v0) alike — most wallets now
   * produce v0, which legacy `Transaction.from` refuses.
   */
  private decodeSignedTransaction(raw: Buffer): Result<VersionedTransaction, DispatchError> {
    try {
      return ok(VersionedTransaction.deserialize(raw));
    } catch (cause) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'not a decodable Solana transaction',
        chainDetail: extractMessage(cause),
      });
    }
  }

  /**
   * issue 15/ADR-0033: records the blockhash signed bytes carry — public,
   * embedded in the bytes themselves, so no RPC is needed — and returns it.
   * The only bookkeeping source for bytes this handler never signed (a
   * Relay Dispatch), and for any in flight across a restart
   * (`restoreInFlight`). `undefined` for bytes that don't decode or lack a
   * signature/blockhash.
   */
  private ensureBlockhashRecord(raw: Buffer): string | undefined {
    const decodedResult = this.decodeSignedTransaction(raw);
    if (!decodedResult.ok) return undefined;
    const signature = feePayerSignature(decodedResult.value);
    const blockhash = decodedResult.value.message.recentBlockhash;
    if (!signature || !blockhash) return undefined;

    this.blockhashByHash.set(bs58.encode(signature), blockhash);
    return blockhash;
  }

  /** ADR-0042: at worker start, re-learns the blockhash of every in-flight transaction, so `getStatus` can still prove expiry after a restart. */
  restoreInFlight(signed: SignedTransaction[]): Promise<void> {
    for (const bytes of signed) this.ensureBlockhashRecord(Buffer.from(bytes, 'base64'));
    return Promise.resolve();
  }

  /**
   * issue 07: reads Solana's own commitment levels via getSignatureStatuses.
   *
   * `searchTransactionHistory: true` is load-bearing, not cosmetic — found
   * only at issue 12's real volume, never at the small scale of issues
   * 02-11's own tests: getSignatureStatuses's default *recent-status cache*
   * (a few minutes) evicts a signature long before the current polling
   * cadence gets back around to it under real congestion, so a
   * long-since-CONFIRMED transaction reads back as "not found" — which,
   * combined with its now-also-expired blockhash, this method used to
   * misread as issue 08's provable-expiry FAILED for a transaction that had
   * actually succeeded. Searching full history removes that ambiguity: "not
   * found" now means "genuinely never landed," which is what the
   * provable-expiry check below is actually allowed to assume.
   *
   * issue 08's decision: Solana never needs the Coordinator's generic
   * ABANDONED timeout at all. Unlike EVM, a stuck Solana transaction's dead
   * end is *provable*: once its blockhash's ~150-slot validity window has
   * definitively passed with no signature status ever recorded (now
   * correctly checked against full history, not just the recent cache), it
   * mathematically cannot be included in any future block — a definitive
   * outcome (ADR-0030), not "the engine gave up watching without one"
   * (CONTEXT.md's own definition of ABANDONED). It is reported as EXPIRED,
   * so the Coordinator can resubmit the Calls or report FAILED (ADR-0042). This
   * only works because `sign`/`broadcast` (this instance) already recorded
   * that blockhash in `blockhashByHash` — as of issue 15/ADR-0033, that
   * includes bytes this handler never itself signed too (`broadcast`'s
   * `ensureBlockhashRecord` derives the record straight from the bytes), so
   * a Relay Dispatch transaction gets the identical provable-expiry
   * resolution a Managed Dispatch one does. A signature with genuinely no
   * recorded blockhash (every `broadcast` records one, and
   * `restoreInFlight` rebuilds them at restart) falls back to plain PENDING,
   * unresolved by `getStatus` itself; the Coordinator's own
   * `abandonmentTimeoutMs` config for 'solana' is pinned generously past
   * the blockhash window purely as that fallback's safety net, not the
   * primary mechanism.
   */
  async getStatus(hash: string): Promise<Result<ChainStatus, DispatchError>> {
    try {
      const { value } = await this.connection.getSignatureStatuses([hash], {
        searchTransactionHistory: true,
      });
      const status = value[0];
      if (status) {
        if (status.err) {
          this.logger.debug({ hash, chainDetail: status.err }, 'getStatus: FAILED');
          return ok('FAILED');
        }
        if (
          status.confirmationStatus === 'confirmed' ||
          status.confirmationStatus === 'finalized'
        ) {
          this.logger.debug({ hash }, 'getStatus: CONFIRMED');
          return ok('CONFIRMED');
        }
        return ok('PENDING');
      }

      const blockhash = this.blockhashByHash.get(hash);
      if (blockhash) {
        const { value: stillValid } = await this.connection.isBlockhashValid(blockhash, {
          commitment: 'confirmed',
        });
        if (!stillValid) {
          this.logger.debug({ hash }, 'getStatus: EXPIRED (blockhash provably expired)');
          return ok('EXPIRED');
        }
      }
      return ok('PENDING');
    } catch (cause) {
      this.logger.warn({ hash, error: extractMessage(cause) }, 'getStatus failed');
      return err({
        code: 'RPC_UNAVAILABLE',
        message: `failed to check status for ${hash}`,
        chainDetail: extractMessage(cause),
      });
    }
  }

  /** issue for the Funding Check (core-engine-scaffold 09): native lamports, or an SPL token's raw base-unit balance via its ATA. */
  async getBalance(address: string, asset: string): Promise<Result<Balance, DispatchError>> {
    const owner = parsePublicKey(address);
    if (!owner.ok) return owner;

    try {
      if (asset === NATIVE_ASSET_SYMBOL) {
        const lamports = await this.connection.getBalance(owner.value);
        return ok({ asset, amount: lamports.toString() });
      }

      const token = resolveKnownToken(this.knownTokens, asset);
      if (!token) {
        return err({
          code: 'UNKNOWN_ASSET',
          message: `no known token configured for asset "${asset}"`,
          chainDetail: { asset },
        });
      }

      const ata = deriveAssociatedTokenAddress(owner.value, new PublicKey(token.mint));
      try {
        const account = await getAccount(this.connection, ata);
        return ok({ asset, amount: account.amount.toString() });
      } catch (cause) {
        if (cause instanceof TokenAccountNotFoundError) return ok({ asset, amount: '0' });
        throw cause;
      }
    } catch (cause) {
      return err({
        code: 'RPC_UNAVAILABLE',
        message: `failed to fetch balance for ${address} (${asset})`,
        chainDetail: extractMessage(cause),
      });
    }
  }
}
