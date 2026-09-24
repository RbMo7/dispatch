import { getAccount, TokenAccountNotFoundError } from '@solana/spl-token';
import bs58 from 'bs58';
import {
  Connection,
  PublicKey,
  Transaction,
  TransactionExpiredBlockheightExceededError,
  TransactionInstruction,
} from '@solana/web3.js';

import type { CallForChain, Payment, SolanaAccountMeta, SolanaCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';
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
import { toTransactionInstructions } from './instruction-codec.js';
import { NATIVE_ASSET_SYMBOL, resolveKnownToken, type SolanaTokenRegistry } from './known-tokens.js';
import { buildNativeTransferCall, parsePublicKey, validateNativeTransferCall } from './native-transfer.js';
import { buildSplTransferCall, isSplTransferCall, validateSplTransferCall } from './spl-transfer.js';

/** The opaque `UnsignedTransaction` encoding this Chain Handler chooses (ADR-0027) — its shape is this file's own business, never assumed elsewhere. */
type EncodedInstruction = { programId: string; keys: SolanaAccountMeta[]; data: string };
type EncodedTransaction = { feePayer: string; instructions: EncodedInstruction[] };

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
 * hash, never the blockhash/lastValidBlockHeight that produced it, so
 * `sign`/`broadcast` record it here the moment they know it. Lost on
 * process restart, which only widens the fallback window (see issue 08's
 * doc comment on `getStatus`), never causes an incorrect answer.
 */
type BlockhashRecord = { blockhash: string; lastValidBlockHeight: number };

/** devnet's real rejection text for a genuinely expired/unknown blockhash at send time — not a mocked signal, this is the RPC's own wording. */
function isBlockhashExpiryDetail(chainDetail: unknown): boolean {
  const text =
    chainDetail instanceof Error
      ? chainDetail.message
      : typeof chainDetail === 'string'
        ? chainDetail
        : '';
  return /blockhash not found/i.test(text);
}

export type SolanaChainHandlerDeps = {
  connection: Connection;
  signerClient: SignerClient;
  /** Single-Sender-per-chain (ADR-0016) — the wallet paymentToCall encodes transfers from, before the Coordinator is ever involved. */
  senderAddress: string;
  /** Operator-configured symbol -> {mint, decimals} for SPL transfers (known-tokens.ts) — empty by default, never hardcoded. */
  knownTokens?: SolanaTokenRegistry;
};

/**
 * The first real Chain Handler (`.scratch/solana-chain-handler/spec.md`).
 * Built incrementally, issue by issue — see each method's doc comment for
 * which issue it belongs to.
 */
export class SolanaChainHandler implements ChainHandler<'solana'> {
  readonly chain = 'solana';

  private readonly connection: Connection;
  private readonly signerClient: SignerClient;
  private readonly senderAddress: string;
  private readonly knownTokens: SolanaTokenRegistry;
  private readonly blockhashByHash = new Map<string, BlockhashRecord>();

  constructor(deps: SolanaChainHandlerDeps) {
    this.connection = deps.connection;
    this.signerClient = deps.signerClient;
    this.senderAddress = deps.senderAddress;
    this.knownTokens = deps.knownTokens ?? {};
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

  /** issues 02/03: cheap shape validation only, dispatched by which program the Call targets. Never an RPC round-trip. */
  validateCall(call: SolanaCall): Promise<Result<void, DispatchError>> {
    if (isSplTransferCall(call)) return Promise.resolve(validateSplTransferCall(call));
    return Promise.resolve(validateNativeTransferCall(call));
  }

  /**
   * issues 02/03: builds the real instruction(s) for each Call — one for a
   * plain transfer, [create-ATA, transferChecked] for an SPL transfer whose
   * destination might not exist yet (instruction-codec.ts). Deliberately
   * does not touch a blockhash at all (issue 04: fetched immediately before
   * signing, not here, or it goes stale under batch volume).
   */
  prepare(
    items: SolanaCall[],
    senderAddress: string,
  ): Promise<Result<PreparedTransaction[], DispatchError>> {
    const feePayer = parsePublicKey(senderAddress);
    if (!feePayer.ok) return Promise.resolve(feePayer);

    const prepared: PreparedTransaction[] = items.map((call, callIndex) => {
      const instructions = toTransactionInstructions(call, feePayer.value);
      const encoded: EncodedTransaction = {
        feePayer: senderAddress,
        instructions: instructions.map(encodeInstruction),
      };
      return { callIndex, unsignedTransaction: encodeUnsignedTransaction(encoded) };
    });

    return Promise.resolve(ok(prepared));
  }

  /**
   * issue 04: fetches a fresh blockhash right before signing (not in
   * `prepare` — a blockhash fetched too early goes stale under batch
   * volume, per the reference implementation's own documented incident),
   * compiles the message, delegates to the Signer client for the `ed25519`
   * curve, and attaches the returned signature.
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
    return this.signInstructions(new PublicKey(senderAddress), encoded.instructions.map(decodeInstruction));
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
    let blockhash: string;
    let lastValidBlockHeight: number;
    try {
      ({ blockhash, lastValidBlockHeight } = await this.connection.getLatestBlockhash('confirmed'));
    } catch (cause) {
      return err({
        code: 'RPC_UNAVAILABLE',
        message: 'failed to fetch a recent blockhash before signing',
        chainDetail: cause instanceof Error ? cause.message : cause,
      });
    }

    const tx = new Transaction({ feePayer, blockhash, lastValidBlockHeight });
    tx.add(...instructions);

    const message = tx.compileMessage().serialize();
    const senderAddress = feePayer.toBase58();
    const signResult = await this.signerClient.requestSignature({
      chain: 'solana',
      curve: 'ed25519',
      address: senderAddress,
      unsignedTxBytes: message.toString('base64'),
    });
    if (!signResult.ok) return signResult;

    const signatureBytes = Buffer.from(signResult.value.signature, 'base64');
    tx.addSignature(feePayer, signatureBytes);
    if (!tx.verifySignatures()) {
      return err({
        code: 'SIGNER_UNREACHABLE',
        message: `signer returned a signature that does not verify for address ${senderAddress}`,
      });
    }

    const hash = bs58.encode(signatureBytes);
    this.blockhashByHash.set(hash, { blockhash, lastValidBlockHeight });

    return ok(tx.serialize({ requireAllSignatures: true, verifySignatures: false }).toString('base64'));
  }

  /**
   * issues 05/06: submits the signed bytes via `sendTransaction` and waits
   * for confirmation against the exact blockhash `sign` used (tracked in
   * `blockhashByHash`, since the interface hands `broadcast` only the
   * opaque bytes). If that blockhash provably expires — at send time
   * ("Blockhash not found", the reliably-reproducible case: this handler's
   * own `sign` always fetches a genuinely fresh one, so this only fires for
   * bytes held past their ~60-90s window) or while waiting for confirmation
   * (`TransactionExpiredBlockheightExceededError`, the "sent but dropped"
   * case ADR-0007 exists for — real but not reproducible on demand against
   * a public devnet) — refreshes the blockhash and resubmits as a genuinely
   * new Transaction (CONTEXT.md's Attempt-vs-Transaction distinction: the
   * signed bytes changed), up to a bounded number of refreshes. Externally
   * produced bytes this handler never signed (no bookkeeping to wait
   * against — e.g. the conformance suite's `invalidSignedTransaction`
   * fixture) get a single bare send, matching issue 05's original scope.
   */
  async broadcast(signed: SignedTransaction): Promise<Result<BroadcastResult, DispatchError>> {
    let currentRaw: Buffer<ArrayBufferLike> = Buffer.from(signed, 'base64');
    const maxRefreshes = 3;

    for (let attempt = 0; ; attempt++) {
      const sendResult = await this.sendOnce(currentRaw);

      if (!sendResult.ok) {
        if (isBlockhashExpiryDetail(sendResult.error.chainDetail) && attempt < maxRefreshes) {
          const refreshed = await this.resignWithFreshBlockhash(currentRaw);
          if (!refreshed.ok) return refreshed;
          currentRaw = refreshed.value;
          continue;
        }
        return sendResult;
      }

      const record = this.blockhashByHash.get(sendResult.value.hash);
      if (!record) return sendResult; // no bookkeeping for these bytes — issue 05's original bare-send behavior

      try {
        const confirmation = await this.connection.confirmTransaction(
          { signature: sendResult.value.hash, blockhash: record.blockhash, lastValidBlockHeight: record.lastValidBlockHeight },
          'confirmed',
        );
        if (confirmation.value.err) {
          return err({
            code: 'CHAIN_REJECTED',
            message: 'devnet reported this transaction as failed',
            chainDetail: confirmation.value.err,
          });
        }
        return sendResult;
      } catch (cause) {
        if (!(cause instanceof TransactionExpiredBlockheightExceededError)) {
          return err({
            code: 'RPC_UNAVAILABLE',
            message: 'failed to confirm broadcast transaction',
            chainDetail: cause instanceof Error ? cause.message : cause,
          });
        }
        if (attempt >= maxRefreshes) return sendResult; // hand off to getStatus's own expiry check (issue 08)
        const refreshed = await this.resignWithFreshBlockhash(currentRaw);
        if (!refreshed.ok) return refreshed;
        currentRaw = refreshed.value;
      }
    }
  }

  private async sendOnce(raw: Buffer): Promise<Result<BroadcastResult, DispatchError>> {
    try {
      const hash = await this.connection.sendRawTransaction(raw, { skipPreflight: false, maxRetries: 0 });
      return ok({ hash });
    } catch (cause) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'devnet rejected this transaction',
        chainDetail: cause instanceof Error ? cause.message : cause,
      });
    }
  }

  /** issue 06: decodes the previously-signed bytes back to feePayer + instructions and re-signs them fresh, under a genuinely new blockhash. */
  private async resignWithFreshBlockhash(raw: Buffer): Promise<Result<Buffer, DispatchError>> {
    let decoded: Transaction;
    try {
      decoded = Transaction.from(raw);
    } catch (cause) {
      return err({
        code: 'CHAIN_REJECTED',
        message: 'cannot refresh: not a decodable Solana transaction',
        chainDetail: cause instanceof Error ? cause.message : cause,
      });
    }
    if (!decoded.feePayer) {
      return err({ code: 'CHAIN_REJECTED', message: 'cannot refresh: decoded transaction has no feePayer' });
    }

    const resigned = await this.signInstructions(decoded.feePayer, decoded.instructions);
    if (!resigned.ok) return resigned;
    return ok(Buffer.from(resigned.value, 'base64'));
  }

  /** issue 07: reads Solana's own commitment levels via getSignatureStatuses. */
  async getStatus(hash: string): Promise<Result<ChainStatus, DispatchError>> {
    try {
      const { value } = await this.connection.getSignatureStatuses([hash]);
      const status = value[0];
      if (!status) return ok('PENDING');
      if (status.err) return ok('FAILED');
      if (status.confirmationStatus === 'confirmed' || status.confirmationStatus === 'finalized') {
        return ok('CONFIRMED');
      }
      return ok('PENDING');
    } catch (cause) {
      return err({
        code: 'RPC_UNAVAILABLE',
        message: `failed to check status for ${hash}`,
        chainDetail: cause instanceof Error ? cause.message : cause,
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
        chainDetail: cause instanceof Error ? cause.message : cause,
      });
    }
  }
}
