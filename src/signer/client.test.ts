import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignerClient, type SignRequest } from './client.js';

const request: SignRequest = {
  chain: 'base',
  curve: 'secp256k1',
  address: 'addr-1',
  unsignedTransaction: 'dW5zaWduZWQ=',
};

function respondWith(response: Response) {
  const fetchMock = vi.fn().mockResolvedValue(response);
  vi.stubGlobal('fetch', fetchMock);
  return fetchMock;
}

describe('SignerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the request with its bearer token to <signerUrl>/sign and returns the signature', async () => {
    const fetchMock = respondWith(
      new Response(JSON.stringify({ signature: 'c2ln' }), { status: 200 }),
    );

    const result = await new SignerClient('http://signer.local', 'tok-1').requestSignature(request);

    expect(result).toEqual({ ok: true, value: { signature: 'c2ln' } });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/sign', 'http://signer.local'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1' },
        body: JSON.stringify(request),
      }),
    );
  });

  it('sends no authorization header when no token is configured', async () => {
    const fetchMock = respondWith(
      new Response(JSON.stringify({ signature: 'c2ln' }), { status: 200 }),
    );

    await new SignerClient('http://signer.local', undefined).requestSignature(request);

    expect(fetchMock).toHaveBeenCalledWith(
      expect.anything(),
      expect.objectContaining({ headers: { 'content-type': 'application/json' } }),
    );
  });

  it('returns a SIGNER_UNREACHABLE DispatchError when the signer can’t be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));

    const result = await new SignerClient('http://signer.local', 'tok-1').requestSignature(request);

    expect(!result.ok && result.error).toEqual({
      code: 'SIGNER_UNREACHABLE',
      message: 'failed to reach signer at http://signer.local',
      chainDetail: 'connect ECONNREFUSED',
    });
  });

  it('maps a 403 carrying the Signer’s { error, reason } to SIGNER_REFUSED with the reason', async () => {
    const body = { error: 'policy', reason: 'destination 0xabc is not allowed' };
    respondWith(new Response(JSON.stringify(body), { status: 403 }));

    const result = await new SignerClient('http://signer.local', 'tok-1').requestSignature(request);

    expect(!result.ok && result.error).toEqual({
      code: 'SIGNER_REFUSED',
      message: 'signer refused: destination 0xabc is not allowed',
      chainDetail: body,
    });
  });

  it.each([
    [
      'a 401 (wrong or missing token)',
      new Response(JSON.stringify({ error: 'unauthorized' }), { status: 401 }),
    ],
    [
      'a 403 with an HTML body (a proxy or WAF)',
      new Response('<html>Forbidden</html>', { status: 403 }),
    ],
    [
      'a 403 whose JSON lacks a reason',
      new Response(JSON.stringify({ error: 'forbidden' }), { status: 403 }),
    ],
    ['a 500', new Response('boom', { status: 500 })],
    [
      'a 503 with a refusal-shaped body',
      new Response(JSON.stringify({ error: 'x', reason: 'y' }), { status: 503 }),
    ],
    ['a 2xx with an unparsable body', new Response('not json', { status: 200 })],
  ])('maps %s to SIGNER_UNREACHABLE', async (_, response) => {
    respondWith(response);

    const result = await new SignerClient('http://signer.local', 'tok-1').requestSignature(request);

    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });
});
