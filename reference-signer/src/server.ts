import { timingSafeEqual } from 'node:crypto';
import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { Keyring } from './keys.js';
import { sign, type Curve } from './sign.js';

type SignRequestBody = {
  chain: unknown;
  curve: unknown;
  address: unknown;
  unsignedTransaction: unknown;
};

function isCurve(value: unknown): value is Curve {
  return value === 'secp256k1' || value === 'ed25519';
}

async function readBody(req: IncomingMessage): Promise<string> {
  const chunks: Buffer[] = [];
  for await (const chunk of req as AsyncIterable<Buffer>) {
    chunks.push(chunk);
  }
  return Buffer.concat(chunks).toString('utf8');
}

function sendJson(res: ServerResponse, status: number, body: unknown): void {
  res.writeHead(status, { 'content-type': 'application/json' });
  res.end(JSON.stringify(body));
}

async function handleSign(req: IncomingMessage, res: ServerResponse, keyring: Keyring) {
  let body: SignRequestBody;
  try {
    body = JSON.parse(await readBody(req)) as SignRequestBody;
  } catch {
    sendJson(res, 400, { error: 'invalid JSON body' });
    return;
  }

  if (!isCurve(body.curve)) {
    sendJson(res, 400, { error: `unsupported curve: ${String(body.curve)}` });
    return;
  }
  if (typeof body.unsignedTransaction !== 'string') {
    sendJson(res, 400, { error: 'unsignedTransaction is required' });
    return;
  }
  if (typeof body.address !== 'string') {
    sendJson(res, 400, { error: 'address is required' });
    return;
  }

  const privateKeyHex = keyring[body.curve][body.address];
  if (!privateKeyHex) {
    sendJson(res, 404, { error: `no key for address ${body.address} on curve ${body.curve}` });
    return;
  }

  const unsignedTransaction = Buffer.from(body.unsignedTransaction, 'base64');
  try {
    const signature = sign(body.curve, privateKeyHex, unsignedTransaction);
    sendJson(res, 200, { signature: signature.toString('base64') });
  } catch (cause) {
    sendJson(res, 500, {
      error: `signing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

/** Constant-time, so a wrong token's response time says nothing about how much of it matched. */
function carriesToken(header: string | undefined, expected: Buffer): boolean {
  const given = Buffer.from(header ?? '');
  return given.length === expected.length && timingSafeEqual(given, expected);
}

/**
 * The reference local-keyfile Signer's HTTP surface — implements just the
 * one `/sign` route from ADR-0046's contract, behind a bearer token. This
 * is dev/reference-only: production signing backends are an operator's own
 * concern. Refuses to construct without a token, so the Signer can't start
 * open to anything that reaches it.
 */
export function createSignerServer(keyring: Keyring, authToken: string) {
  if (authToken === '') {
    throw new Error(
      'SIGNER_AUTH_TOKEN is required: the Signer refuses to start without a bearer token (ADR-0046)',
    );
  }
  const expected = Buffer.from(`Bearer ${authToken}`);
  return createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/sign') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    if (!carriesToken(req.headers.authorization, expected)) {
      sendJson(res, 401, { error: 'missing or wrong bearer token' });
      return;
    }
    void handleSign(req, res, keyring);
  });
}
