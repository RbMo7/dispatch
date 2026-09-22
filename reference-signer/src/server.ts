import { createServer, type IncomingMessage, type ServerResponse } from 'node:http';

import type { Keyring } from './keys.js';
import { sign, type Curve } from './sign.js';

type SignRequestBody = {
  chain: unknown;
  curve: unknown;
  address: unknown;
  unsignedTxBytes: unknown;
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
  if (typeof body.unsignedTxBytes !== 'string') {
    sendJson(res, 400, { error: 'unsignedTxBytes is required' });
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

  const message = Buffer.from(body.unsignedTxBytes, 'base64');
  try {
    const signature = sign(body.curve, privateKeyHex, message);
    sendJson(res, 200, { signature: signature.toString('base64') });
  } catch (cause) {
    sendJson(res, 500, {
      error: `signing failed: ${cause instanceof Error ? cause.message : String(cause)}`,
    });
  }
}

/**
 * The reference local-keyfile Signer's HTTP surface — implements just the
 * one `/sign` route from ADR-0002's contract. This is dev/reference-only:
 * production signing backends are an operator's own concern.
 */
export function createSignerServer(keyring: Keyring) {
  return createServer((req, res) => {
    if (req.method !== 'POST' || req.url !== '/sign') {
      sendJson(res, 404, { error: 'not found' });
      return;
    }
    void handleSign(req, res, keyring);
  });
}
