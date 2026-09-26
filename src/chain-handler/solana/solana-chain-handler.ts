import { randomUUID } from 'node:crypto';

import { getAccount, TokenAccountNotFoundError } from '@solana/spl-token';
import bs58 from 'bs58';
import { Connection, PublicKey, Transaction, TransactionInstruction } from '@solana/web3.js';
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
 * hash, e.g. after a process restart). In ordinary operation `getStatus`
 * itself resolves a stuck transaction to FAILED well before this fires.
 */
export const SOLANA_ABANDONMENT_TIMEOUT_MS = 120_000;

/**
 * issue 10: bundles multiple Calls into one transaction via Solana's native
 * multi-instruction support (ADR-0006's Solana-specific answer to batching;
 * no separate Bulk Call concept needed here). Measured directly against
 * this codec's own worst case, one create-ATA plus transferChecked pair per
 * payment, all distinct recipients/mints, one signer: 10 payments serialize
 * to about 1204 bytes total, just inside the 1232-byte legacy transaction
 * limit; 11 measures at about 1295 bytes and exceeds it. Shipping 8 rather
 * than the measured ceiling of 10 leaves headroom this synthetic worst case
 * doesn't account for. Re-measure if instruction-codec.ts ever changes
 * what a Call expands into.
 */
const MAX_BUNDLE_SIZE = 8;

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

/**
 * `getStatus`'s only way to know whether a not-yet-confirmed transaction's
 * blockhash has provably expired (issue 08) — the interface hands it only a
 * hash, never the blockhash that produced it, so `sign`/`broadcast` record
 * it here the moment they know it. Lost on process restart, which only
 * widens the fallback window (see issue 08's doc comment on `getStatus`),
 * never causes an incorrect answer.
 */
type BlockhashRecord = {
  blockhash: string;
  /**
   * issue 15 (ADR-0033): whether this handler's own key produced the
   * signature over this blockhash. `true` for anything `signInstructions`
   * itself signed — a fresh blockhash and a fresh Signer-produced
   * signature can replace it on expiry (issue 06). `false` for a record
   * `broadcast` derived from already-signed bytes it never itself
   * produced (a Relay Dispatch transaction) — there is no key here to
   * produce a replacement signature with (ADR-0005), so expiry for one of
   * these must resolve to a clean FAILED instead of an attempted, always-
   * doomed resign.
   */
  resignable: boolean;
};

export type SolanaChainHandlerDeps = {
  connection: Connection;
  /**
   * Only needed if this handler ever builds+signs a Managed Dispatch
   * transaction (`sign`, and the resign-on-expiry path inside `broadcast`
   * for a self-signed transaction). A Relay-Dispatch-only deployment never
   * calls `sign` at all (the transaction always arrives already signed,
   * ADR-0005) and can omit this entirely, rather than needing to wire up
   * an unreachable placeholder just to satisfy the constructor.
   */
  signerClient?: SignerClient;
  /** Single-Sender-per-chain (ADR-0016) — the wallet paymentToCall encodes transfers from, before the Coordinator is ever involved. */
  senderAddress: string;
  /** Operator-configured symbol -> {mint, decimals} for SPL transfers (known-tokens.ts) — empty by default, never hardcoded. */
  knownTokens?: SolanaTokenRegistry;
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
  private readonly blockhashByHash = new Map<string, BlockhashRecord>();
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

    const prepared: PreparedTransaction[] = [];
    for (let chunkStart = 0; chunkStart < items.length; chunkStart += MAX_BUNDLE_SIZE) {
      const chunk = items.slice(chunkStart, chunkStart + MAX_BUNDLE_SIZE);
      const chunkNonce = randomUUID();
      const instructions = chunk.flatMap((call) => toTransactionInstructions(call, feePayer.value));
      const encoded: EncodedTransaction = {
        chunkNonce,
        feePayer: senderAddress,
        instructions: instructions.map(encodeInstruction),
      };
      const unsignedTransaction = encodeUnsignedTransaction(encoded);
      chunk.forEach((_call, offset) => {
        prepared.push({ callIndex: chunkStart + offset, unsignedTransaction });
      });
    }

    return Promise.resolve(ok(prepared));
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

  /**
   * Shared by `sign` and, for issue 06, `resignWithFreshBlockhash` — always
   * fetches its own fresh blockhash (never reuses a caller's), so a refresh
   * really is a new signature over a new message, never a stale resubmit.
   */
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
    tx.add(...instructions);

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
    this.blockhashByHash.set(hash, { blockhash, resignable: true });
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

    if (!tx.feePayer) {
      return Promise.resolve(
        err({ code: 'CHAIN_REJECTED', message: 'signed transaction has no fee payer' }),
      );
    }
    if (tx.signatures.length === 0 || tx.signatures.every((sig) => sig.signature === null)) {
      return Promise.resolve(
        err({ code: 'CHAIN_REJECTED', message: 'signed transaction has no signature' }),
      );
    }
    if (!tx.verifySignatures()) {
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
   * issues 05/06/15: submits the signed bytes via `sendTransaction` and
   * waits for confirmation against the exact blockhash `sign` used (tracked
   * in `blockhashByHash`, since the interface hands `broadcast` only the
   * opaque bytes) — via `pollUntilConfirmedOrExpired` below, plain HTTP
   * polling only, deliberately never `connection.confirmTransaction`
   * (see that method's own doc comment for why).
   *
   * issue 15/ADR-0033: bytes this handler never itself signed (a Relay
   * Dispatch transaction) get the exact same bookkeeping treatment as
   * self-signed ones — `ensureBlockhashRecord` derives it straight from the
   * signed bytes' own embedded blockhash, no RPC needed — but are marked
   * `resignable: false` (see `BlockhashRecord`), since there is no key here
   * to produce a replacement signature with. If that blockhash provably
   * expires — at send time ("Blockhash not found", the reliably-
   * reproducible case: this handler's own `sign` always fetches a
   * genuinely fresh one, so this only fires for bytes held past their
   * ~60-90s window) or while waiting for confirmation (the "sent but
   * dropped" case ADR-0007 exists for — real but not reproducible on
   * demand against a public devnet) — a resignable record refreshes the
   * blockhash and resubmits as a genuinely new Transaction (CONTEXT.md's
   * Attempt-vs-Transaction distinction: the signed bytes changed), up to a
   * bounded number of refreshes; a non-resignable one never attempts that
   * (it would only ever fail, since the Signer holds no key for this
   * transaction's fee payer) and instead hands off to `getStatus`'s own
   * provable-expiry check (issue 08), which now has the bookkeeping it
   * needs to resolve a clean, definitive FAILED for these too.
   */
  async broadcast(signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> {
    let currentRaw: Buffer<ArrayBufferLike> = Buffer.from(signed, 'base64');
    const maxRefreshes = 3;

    for (let attempt = 0; ; attempt++) {
      const record = this.ensureBlockhashRecord(currentRaw);
      this.logger.debug({ attempt, resignable: record?.resignable }, 'broadcasting transaction');

      let hash: string;
      try {
        hash = await this.connection.sendRawTransaction(currentRaw, {
          skipPreflight: false,
          maxRetries: 0,
        });
      } catch (cause) {
        if (
          isBlockhashExpiryMessage(extractMessage(cause)) &&
          attempt < maxRefreshes &&
          record?.resignable !== false
        ) {
          this.logger.warn(
            { attempt },
            'blockhash expired before send, refreshing and resubmitting',
          );
          const refreshed = await this.resignWithFreshBlockhash(currentRaw);
          if (!refreshed.ok) return refreshed;
          currentRaw = refreshed.value;
          continue;
        }
        this.logger.warn({ attempt, error: extractMessage(cause) }, 'sendRawTransaction failed');
        return err(mapSolanaFailure(cause));
      }
      this.logger.debug({ hash }, 'sendRawTransaction accepted');

      const sentRecord = this.blockhashByHash.get(hash);
      if (!sentRecord) return ok({ hash }); // defensive only — ensureBlockhashRecord above already covers any decodable transaction

      const outcome = await this.pollUntilConfirmedOrExpired(hash, sentRecord);
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
        this.logger.warn(
          { hash, error: outcome.error },
          'status check failed while awaiting confirmation',
        );
        return err(outcome.error);
      }

      // outcome.type === 'expired'
      if (!sentRecord.resignable) {
        this.logger.warn(
          { hash },
          'blockhash expired while awaiting confirmation, no key to resign — handing off to getStatus',
        );
        return ok({ hash }); // hand off to getStatus's own expiry check (issue 08/15)
      }
      if (attempt >= maxRefreshes) {
        this.logger.warn(
          { hash, attempt },
          'blockhash expired while awaiting confirmation, out of refreshes — handing off to getStatus',
        );
        return ok({ hash });
      }
      this.logger.warn(
        { hash, attempt },
        'blockhash expired while awaiting confirmation, refreshing and resubmitting',
      );
      const refreshed = await this.resignWithFreshBlockhash(currentRaw);
      if (!refreshed.ok) return refreshed;
      currentRaw = refreshed.value;
    }
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
  private async pollUntilConfirmedOrExpired(
    hash: string,
    record: BlockhashRecord,
  ): Promise<
    | { type: 'confirmed' }
    | { type: 'failed'; chainDetail: unknown }
    | { type: 'expired' }
    | { type: 'error'; error: DispatchError }
  > {
    const pollIntervalMs = 1_000;
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
        ({ value: stillValid } = await this.connection.isBlockhashValid(record.blockhash, {
          commitment: 'confirmed',
        }));
      } catch (cause) {
        return { type: 'error', error: mapSolanaFailure(cause) };
      }
      if (!stillValid) return { type: 'expired' };

      await sleep(pollIntervalMs);
    }
  }

  /**
   * Shared by `resignWithFreshBlockhash` and `validateSignedTransaction`
   * (ADR-0032) — the one place this handler turns opaque signed bytes back
   * into a decoded `Transaction`, or a structured `CHAIN_REJECTED` if they
   * aren't one.
   */
  /** #20 (ADR-0041): a Solana transaction's id is its first (fee payer's) signature, base58 — exactly what sendRawTransaction reports. */
  transactionHash(signed: SignedTransaction): Result<string, DispatchError> {
    const decoded = this.decodeSignedTransaction(Buffer.from(signed, 'base64'));
    if (!decoded.ok) return decoded;
    const signature = decoded.value.signature;
    if (!signature) {
      return err({ code: 'CHAIN_REJECTED', message: 'signed transaction carries no signature' });
    }
    return ok(bs58.encode(signature));
  }

  private decodeSignedTransaction(raw: Buffer): Result<Transaction, DispatchError> {
    try {
      return ok(Transaction.from(raw));
    } catch (cause) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'not a decodable Solana transaction',
        chainDetail: extractMessage(cause),
      });
    }
  }

  /**
   * issue 15/ADR-0033: `broadcast`'s only source of bookkeeping for signed
   * bytes it never itself produced — a transaction's signature (its own
   * hash) and its blockhash are both already public information embedded
   * in the bytes themselves, so no RPC round-trip is needed to read them
   * back out, only to decode. Never downgrades an existing record (e.g.
   * one `signInstructions` already populated as `resignable: true`);
   * returns `undefined` for bytes that don't decode or lack a signature/
   * blockhash, leaving `broadcast`'s own pre-existing behavior for those
   * unchanged.
   */
  private ensureBlockhashRecord(raw: Buffer): BlockhashRecord | undefined {
    const decodedResult = this.decodeSignedTransaction(raw);
    if (!decodedResult.ok) return undefined;
    const tx = decodedResult.value;
    if (!tx.signature || !tx.recentBlockhash) return undefined;

    const hash = bs58.encode(tx.signature);
    const existing = this.blockhashByHash.get(hash);
    if (existing) return existing;

    const record: BlockhashRecord = { blockhash: tx.recentBlockhash, resignable: false };
    this.blockhashByHash.set(hash, record);
    return record;
  }

  /** issue 06: decodes the previously-signed bytes back to feePayer + instructions and re-signs them fresh, under a genuinely new blockhash. */
  private async resignWithFreshBlockhash(raw: Buffer): Promise<Result<Buffer, DispatchError>> {
    const decodedResult = this.decodeSignedTransaction(raw);
    if (!decodedResult.ok) return decodedResult;
    const decoded = decodedResult.value;
    if (!decoded.feePayer) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'cannot refresh: decoded transaction has no feePayer',
      });
    }

    this.logger.debug(
      { senderAddress: decoded.feePayer.toBase58() },
      'resigning with a fresh blockhash',
    );
    const resigned = await this.signInstructions(decoded.feePayer, decoded.instructions);
    if (!resigned.ok) return resigned;
    return ok(Buffer.from(resigned.value, 'base64'));
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
   * mathematically cannot be included in any future block — a clean,
   * honest `FAILED` (ADR-0030), not "the engine gave up watching without a
   * definitive outcome" (CONTEXT.md's own definition of ABANDONED). This
   * only works because `sign`/`broadcast` (this instance) already recorded
   * that blockhash in `blockhashByHash` — as of issue 15/ADR-0033, that
   * includes bytes this handler never itself signed too (`broadcast`'s
   * `ensureBlockhashRecord` derives the record straight from the bytes), so
   * a Relay Dispatch transaction gets the identical provable-FAILED
   * resolution a Managed Dispatch one does. A signature with genuinely no
   * recorded blockhash (only after a process restart, since every
   * `broadcast` call now records one) falls back to plain PENDING,
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

      const record = this.blockhashByHash.get(hash);
      if (record) {
        const { value: stillValid } = await this.connection.isBlockhashValid(record.blockhash, {
          commitment: 'confirmed',
        });
        if (!stillValid) {
          this.logger.debug({ hash }, 'getStatus: FAILED (blockhash provably expired)');
          return ok('FAILED');
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
