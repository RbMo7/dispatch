import { generatePrivateKey, privateKeyToAccount } from 'viem/accounts';
import { afterEach, describe, expect, it, vi } from 'vitest';

import { SignerClient, type SignRequest } from './client.js';
import { safeTransactionHash, type SafeTransaction } from './safe-transaction.js';

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

describe('SignerClient.signSafeTransaction (ADR-0052)', () => {
  const account = privateKeyToAccount(generatePrivateKey());
  const safeTransaction: SafeTransaction = {
    safe: '0x84Ac281B68de095f6227050F56C74d93d294e609',
    chainId: 84532,
    to: '0x1111111111111111111111111111111111111111',
    value: '1000000000000000',
    data: '0x',
    operation: 0,
    safeTxGas: '0',
    baseGas: '0',
    gasPrice: '0',
    gasToken: '0x0000000000000000000000000000000000000000',
    refundReceiver: '0x0000000000000000000000000000000000000000',
    nonce: '0',
  };
  const safeRequest = { chain: 'base' as const, address: account.address, safeTransaction };
  /** The Safe 1.4.1 reference hash of `safeTransaction` from the #79 spike, not computed by the code under test. */
  const referenceHash = '0xfd11475aa4e3a78acc2033b01fb4fcce98e1f948f4faf7563b73e3853443300e';

  const base64Of = (hex: string) => Buffer.from(hex.slice(2), 'hex').toString('base64');
  const signedResponse = (signature: string) =>
    new Response(JSON.stringify({ signature: base64Of(signature) }), { status: 200 });
  const client = () => new SignerClient('http://signer.local', 'tok-1');

  afterEach(() => {
    vi.unstubAllGlobals();
  });

  it('hashes the transaction as Safe does', () => {
    expect(safeTransactionHash(safeTransaction)).toBe(referenceHash);
  });

  it('sends the safeTransaction kind with the bearer token and returns the verified 0x signature', async () => {
    const signature = await account.sign({ hash: referenceHash });
    const fetchMock = respondWith(signedResponse(signature));

    const result = await client().signSafeTransaction(safeRequest);

    expect(result).toEqual({ ok: true, value: signature });
    expect(fetchMock).toHaveBeenCalledWith(
      new URL('/sign', 'http://signer.local'),
      expect.objectContaining({
        method: 'POST',
        headers: { 'content-type': 'application/json', authorization: 'Bearer tok-1' },
        body: JSON.stringify({
          kind: 'safeTransaction',
          chain: 'base',
          curve: 'secp256k1',
          address: account.address,
          safeTransaction,
        }),
      }),
    );
  });

  it('rejects a signature from another key as SIGNER_UNREACHABLE, naming both addresses', async () => {
    const stranger = privateKeyToAccount(generatePrivateKey());
    respondWith(signedResponse(await stranger.sign({ hash: referenceHash })));

    const result = await client().signSafeTransaction(safeRequest);

    expect(!result.ok && result.error).toEqual({
      code: 'SIGNER_UNREACHABLE',
      message: `signer returned a signature for ${stranger.address}, expected ${account.address}`,
    });
  });

  it('rejects a signature over a different transaction', async () => {
    const other = safeTransactionHash({ ...safeTransaction, nonce: '1' });
    respondWith(signedResponse(await account.sign({ hash: other })));

    const result = await client().signSafeTransaction(safeRequest);

    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });

  it('rejects a signature whose v is 0 or 1, which the Transaction Service refuses', async () => {
    const signature = await account.sign({ hash: referenceHash });
    const lowV = `${signature.slice(0, 130)}${signature.endsWith('1c') ? '01' : '00'}`;
    respondWith(signedResponse(lowV));

    const result = await client().signSafeTransaction(safeRequest);

    expect(!result.ok && result.error.message).toMatch(/v 27 or 28/);
  });

  it('rejects a signature of the wrong length', async () => {
    respondWith(signedResponse('0x1234'));

    const result = await client().signSafeTransaction(safeRequest);

    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });

  it('maps a 403 carrying the Signer’s { error, reason } to SIGNER_REFUSED with the reason', async () => {
    const body = { error: 'policy refused', reason: 'the policy has no allowedSafe' };
    respondWith(new Response(JSON.stringify(body), { status: 403 }));

    const result = await client().signSafeTransaction(safeRequest);

    expect(!result.ok && result.error).toEqual({
      code: 'SIGNER_REFUSED',
      message: 'signer refused: the policy has no allowedSafe',
      chainDetail: body,
    });
  });

  it.each([
    ['a 400 (an old Signer that does not know the kind)', new Response('{}', { status: 400 })],
    ['a 401', new Response('{}', { status: 401 })],
    ['a 403 from a proxy', new Response('<html>Forbidden</html>', { status: 403 })],
    ['a 500', new Response('boom', { status: 500 })],
  ])('maps %s to SIGNER_UNREACHABLE', async (_, response) => {
    respondWith(response);

    const result = await client().signSafeTransaction(safeRequest);

    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });

  it('returns SIGNER_UNREACHABLE when the signer can’t be reached', async () => {
    vi.stubGlobal('fetch', vi.fn().mockRejectedValue(new Error('connect ECONNREFUSED')));

    const result = await client().signSafeTransaction(safeRequest);

    expect(!result.ok && result.error.code).toBe('SIGNER_UNREACHABLE');
  });
});
