import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage } from 'node:http';

import bs58 from 'bs58';
import { keccak256, parseTransaction, serializeTransaction, toHex } from 'viem';

import { CURVES, type Curve, type KeyBackend } from './backends/key-backend.js';
import { lookupKey, type AddressEntry } from './config.js';
import { evaluatePolicy } from './policy.js';

/** A configured address with the backend holding its key. */
export type KeyringEntry = { entry: AddressEntry; backend: KeyBackend };

/** Keyed by `lookupKey`. */
export type Keyring = ReadonlyMap<string, KeyringEntry>;

/**
 * `refused` is a policy refusal (403); `rejected` a request the Signer
 * would never sign (400, 401, 404); `failed` the Signer's own failure.
 */
export type AuditDecision = 'signed' | 'refused' | 'rejected' | 'failed';

export type AuditRecord = {
  time: string;
  address?: string | undefined;
  chain?: string | undefined;
  /** The id the chain will know the signed transaction by: its EVM hash, or its Solana signature. */
  transactionId?: string | undefined;
  decision: AuditDecision;
  status: number;
  reason?: string | undefined;
};

function decisionFor(status: number): AuditDecision {
  if (status === 200) return 'signed';
  if (status === 403) return 'refused';
  return status < 500 ? 'rejected' : 'failed';
}

/** What a request came to, before it is answered and audited. */
type Outcome = {
  status: number;
  body: Record<string, unknown>;
  address?: string;
  chain?: string;
  transactionId?: string;
};

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function isCurve(value: unknown): value is Curve {
  return CURVES.includes(value as Curve);
}

function errorMessage(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

/** The EVM transaction hash once `signature` (r || s || recovery) is applied, as the engine will serialize it. */
function evmTransactionHash(
  transaction: ReturnType<typeof parseTransaction>,
  signature: Uint8Array,
): string {
  return keccak256(
    serializeTransaction(transaction, {
      r: toHex(signature.subarray(0, 32)),
      s: toHex(signature.subarray(32, 64)),
      yParity: signature[64] ?? 0,
    }),
  );
}

async function handleSign(req: IncomingMessage, keyring: Keyring): Promise<Outcome> {
  let body: unknown;
  try {
    body = JSON.parse(await readBody(req));
  } catch {
    return { status: 400, body: { error: 'invalid JSON body' } };
  }
  if (typeof body !== 'object' || body === null) {
    return { status: 400, body: { error: 'the body must be a JSON object' } };
  }

  const { chain, curve, address, unsignedTransaction } = body as Record<string, unknown>;
  const known = {
    ...(typeof address === 'string' ? { address } : {}),
    ...(typeof chain === 'string' ? { chain } : {}),
  };
  const reject = (status: number, error: string): Outcome => ({
    status,
    body: { error },
    ...known,
  });

  if (!isCurve(curve)) return reject(400, `unsupported curve: ${String(curve)}`);
  if (typeof unsignedTransaction !== 'string')
    return reject(400, 'unsignedTransaction is required');
  if (typeof address !== 'string') return reject(400, 'address is required');

  const key = keyring.get(lookupKey(curve, address));
  if (!key || key.entry.curve !== curve) {
    return reject(404, `no key for address ${address} on curve ${curve}`);
  }

  const unsigned = Buffer.from(unsignedTransaction, 'base64');
  if (key.entry.policy) {
    const decision = evaluatePolicy(key.entry.policy, curve, unsigned);
    if (!decision.ok) {
      return { status: 403, body: { error: 'policy refused', reason: decision.reason }, ...known };
    }
  }
  // Parsed before signing, so a signed EVM transaction always has a hash to audit.
  let evmTransaction: ReturnType<typeof parseTransaction> | undefined;
  if (curve === 'secp256k1') {
    try {
      evmTransaction = parseTransaction(toHex(unsigned));
    } catch (cause) {
      return reject(400, `unsignedTransaction is not an EVM transaction: ${errorMessage(cause)}`);
    }
  }

  let signature: Uint8Array;
  try {
    const payload = curve === 'secp256k1' ? keccak256(unsigned, 'bytes') : unsigned;
    signature = await key.backend.sign(curve, key.entry.keyRef, payload);
  } catch (cause) {
    return reject(500, `signing failed: ${errorMessage(cause)}`);
  }

  return {
    status: 200,
    body: { signature: Buffer.from(signature).toString('base64') },
    ...known,
    transactionId: evmTransaction
      ? evmTransactionHash(evmTransaction, signature)
      : bs58.encode(signature),
  };
}

/** Constant-time, so a wrong token's response time says nothing about how much of it matched. */
function carriesToken(header: string | undefined, expected: Buffer): boolean {
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

export type SignerServerOptions = {
  keyring: Keyring;
  authToken: string;
  /** Receives one JSON line per request. Defaults to stdout, kept apart from everything else on stderr. */
  audit?: (line: string) => void;
};

/**
 * The Signer's HTTP surface: the one `/sign` route from ADR-0046's
 * contract, behind a bearer token, with every request audited. Refuses to
 * construct without a token, so the Signer can't start open to anything
 * that reaches it.
 */
export function createSignerServer({
  keyring,
  authToken,
  audit = (line) => process.stdout.write(`${line}\n`),
}: SignerServerOptions) {
  if (authToken === '') {
    throw new Error(
      'SIGNER_AUTH_TOKEN is required: the Signer refuses to start without a bearer token (ADR-0046)',
    );
  }
  const expected = Buffer.from(`Bearer ${authToken}`);

  async function answer(req: IncomingMessage): Promise<Outcome> {
    if (req.method !== 'POST' || req.url !== '/sign') {
      return { status: 404, body: { error: 'not found' } };
    }
    if (!carriesToken(req.headers.authorization, expected)) {
      return { status: 401, body: { error: 'missing or wrong bearer token' } };
    }
    try {
      return await handleSign(req, keyring);
    } catch (cause) {
      return { status: 500, body: { error: `signing failed: ${errorMessage(cause)}` } };
    }
  }

  return createServer((req, res) => {
    void answer(req).then(({ status, body, address, chain, transactionId }) => {
      // Audited before answering, so no signature leaves without its line.
      // A policy refusal's own reason says more than its `error`.
      const reason = body.reason ?? body.error;
      const record: AuditRecord = {
        time: new Date().toISOString(),
        address,
        chain,
        transactionId,
        decision: decisionFor(status),
        status,
        reason: typeof reason === 'string' ? reason : undefined,
      };
      audit(JSON.stringify(record));
      res.writeHead(status, { 'content-type': 'application/json' });
      res.end(JSON.stringify(body));
    });
  });
}
