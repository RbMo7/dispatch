import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignerClient } from './client.js';

describe('SignerClient', () => {
  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('POSTs the request to <signerUrl>/sign and returns the signature', async () => {
    const fetchMock = vi
      .fn()
      .mockResolvedValue(new Response(JSON.stringify({ signature: 'c2ln' }), { status: 200 }));
    vi.stubGlobal('fetch', fetchMock);

    const client = new SignerClient('http://signer.local');
    const result = await client.requestSignature({
      chain: 'solana',
      curve: 'ed25519',
      address: 'addr-1',
      unsignedTxBytes: 'dW5zaWduZWQ=',
    });

    expect(result).toEqual({ ok: true, value: { signature: 'c2ln' } });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/sign', 'http://signer.local'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({
          chain: 'solana',
          curve: 'ed25519',
          address: 'addr-1',
          unsignedTxBytes: 'dW5zaWduZWQ=',
        }),
      }),
    );
  });

  it('returns a SIGNER_UNREACHABLE DispatchError when the signer can’t be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));

    const client = new SignerClient('http://signer.local');
    const result = await client.requestSignature({
      chain: 'base',
      curve: 'secp256k1',
      address: 'addr-1',
      unsignedTxBytes: 'dW5zaWduZWQ=',
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error).toEqual({
      code: 'SIGNER_UNREACHABLE',
      message: 'failed to reach signer at http://signer.local',
      chainDetail: 'connect ECONNREFUSED',
    });
  });

  it('returns a SIGNER_UNREACHABLE DispatchError when the signer responds with a non-2xx status', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('boom', { status: 500 })));

    const client = new SignerClient('http://signer.local');
    const result = await client.requestSignature({
      chain: 'base',
      curve: 'secp256k1',
      address: 'addr-1',
      unsignedTxBytes: 'dW5zaWduZWQ=',
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });

  it('returns a SIGNER_UNREACHABLE DispatchError when a 2xx response has an unparsable body', async () => {
    vi.stubGlobal('fetch', vi.fn().mockResolvedValue(new Response('not json', { status: 200 })));

    const client = new SignerClient('http://signer.local');
    const result = await client.requestSignature({
      chain: 'base',
      curve: 'secp256k1',
      address: 'addr-1',
      unsignedTxBytes: 'dW5zaWduZWQ=',
    });

    expect(result.ok).toBe(false);
    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });
});
