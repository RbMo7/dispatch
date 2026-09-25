import {
  HttpRequestError,
  InvalidInputRpcError,
  InvalidParamsRpcError,
  LimitExceededRpcError,
  RpcRequestError,
  TimeoutError,
  TransactionRejectedRpcError,
} from 'viem';
import { describe, expect, it } from 'vitest';

import { mapBaseFailure } from './error-mapping.js';

const url = 'https://sepolia.base.org';

/** The shape viem gives a JSON-RPC error from the node — `details` carries the node's own text, exactly as observed against real Base Sepolia (#10). */
function nodeRejection(
  Wrapper:
    typeof InvalidInputRpcError | typeof TransactionRejectedRpcError | typeof InvalidParamsRpcError,
  code: number,
  message: string,
) {
  return new Wrapper(new RpcRequestError({ body: {}, error: { code, message }, url }));
}

describe('mapBaseFailure (#10) — real Base Sepolia failure shapes', () => {
  it.each([
    ['connection refused', new HttpRequestError({ url, details: 'fetch failed' })],
    [
      'an HTTP 503 from the RPC',
      new HttpRequestError({ url, status: 503, details: '"Service Unavailable"' }),
    ],
    [
      'an HTTP 429 rate limit',
      new HttpRequestError({ url, status: 429, details: '"Too Many Requests"' }),
    ],
    [
      "the engine's own fetch deadline (rpc-timeout.ts)",
      new HttpRequestError({ url, details: 'The operation was aborted due to timeout' }),
    ],
    ["viem's own request timeout", new TimeoutError({ body: {}, url })],
  ])('maps %s to RPC_UNAVAILABLE', (_label, cause) => {
    expect(mapBaseFailure(cause).code).toBe('RPC_UNAVAILABLE');
  });

  it.each([
    [
      'nonce too low',
      InvalidInputRpcError,
      -32000,
      'nonce too low: next nonce 77, tx nonce 0',
      'NONCE_ALREADY_USED',
    ],
    [
      'insufficient funds',
      TransactionRejectedRpcError,
      -32003,
      'insufficient funds for gas * price + value: have 1 want 2',
      'INSUFFICIENT_FUNDS',
    ],
    [
      'intrinsic gas too low',
      InvalidInputRpcError,
      -32000,
      'intrinsic gas too low',
      'CHAIN_REJECTED',
    ],
    ['a wrong chain ID', InvalidInputRpcError, -32000, 'invalid chain ID', 'CHAIN_REJECTED'],
    [
      'undecodable signed bytes',
      InvalidParamsRpcError,
      -32602,
      'failed to decode signed transaction',
      'CHAIN_REJECTED',
    ],
    [
      'an underpriced replacement',
      InvalidInputRpcError,
      -32000,
      'replacement transaction underpriced',
      'CHAIN_REJECTED',
    ],
  ] as const)(
    'maps a node rejection for %s to its code',
    (_label, Wrapper, rpcCode, text, expected) => {
      expect(mapBaseFailure(nodeRejection(Wrapper, rpcCode, text)).code).toBe(expected);
    },
  );

  it('never reads "429" out of the request body — a real rejection whose signed hex contains 429 stays a rejection (review of #10)', () => {
    const cause = new InvalidInputRpcError(
      new RpcRequestError({
        body: { method: 'eth_sendRawTransaction', params: ['0x02f8a1429aff'] },
        error: { code: -32000, message: 'intrinsic gas too low' },
        url,
      }),
    );
    expect(mapBaseFailure(cause).code).toBe('CHAIN_REJECTED');
  });

  it('maps a JSON-RPC -32005 limit-exceeded answer (a rate limit on HTTP 200) to RPC_UNAVAILABLE (review of #10)', () => {
    const cause = new LimitExceededRpcError(
      new RpcRequestError({
        body: {},
        error: { code: -32005, message: 'request rate exceeded' },
        url,
      }),
    );
    expect(mapBaseFailure(cause).code).toBe('RPC_UNAVAILABLE');
  });

  it('classifies a node rejection sent with an HTTP error status by its JSON-RPC text, not as a transport failure (review of #10)', () => {
    const cause = new HttpRequestError({
      url,
      status: 400,
      details: JSON.stringify({ code: -32000, message: 'nonce too low: next nonce 5, tx nonce 1' }),
    });
    expect(mapBaseFailure(cause).code).toBe('NONCE_ALREADY_USED');
  });

  it('keeps an HTTP 429 or 5xx a transport failure even when its body is a JSON-RPC error (review of #13)', () => {
    for (const status of [429, 503]) {
      const cause = new HttpRequestError({
        url,
        status,
        details: JSON.stringify({
          code: 429,
          message: 'Your app has exceeded its compute units per second capacity',
        }),
      });
      expect(mapBaseFailure(cause).code).toBe('RPC_UNAVAILABLE');
    }
  });

  it("reports the node's own text as the message, not viem's generic wrapper wording", () => {
    const mapped = mapBaseFailure(nodeRejection(InvalidInputRpcError, -32000, 'invalid chain ID'));

    expect(mapped.message).toBe('invalid chain ID');
  });

  it('keeps the JSON-RPC error code and full original text in chainDetail', () => {
    const mapped = mapBaseFailure(
      nodeRejection(InvalidInputRpcError, -32000, 'intrinsic gas too low'),
    );

    expect(mapped.chainDetail).toMatchObject({ rpcCode: -32000, details: 'intrinsic gas too low' });
    expect((mapped.chainDetail as { message: string }).message).toContain('intrinsic gas too low');
  });

  it('keeps the HTTP status in chainDetail for a transport failure', () => {
    const mapped = mapBaseFailure(
      new HttpRequestError({ url, status: 503, details: '"Service Unavailable"' }),
    );

    expect(mapped.chainDetail).toMatchObject({ httpStatus: 503 });
  });

  it('still maps a plain non-viem error safely, with its text preserved', () => {
    const mapped = mapBaseFailure(new Error('something unexpected'));

    expect(mapped).toEqual({
      code: 'CHAIN_REJECTED',
      message: 'something unexpected',
      chainDetail: { message: 'something unexpected' },
    });
  });
});
