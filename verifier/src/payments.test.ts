import { describe, expect, it } from 'vitest';
import { UsageError } from './errors.js';
import { parsePayments } from './payments.js';

const SOL_A = '2dXk7KqsKDMVK9F9zssWKz18nRvQ6faPonREprwn72zi';
const MINT = '4vmApcQdbZCc8BBXnoLcih69TH1uhGKUnDXU2yb1p18e';
const EVM_A = '0x1111111111111111111111111111111111111111';
const EVM_TOKEN = '0x036CBD53842C5426634E7929541EC2318F3DCF7E';

describe('parsePayments', () => {
  it('reads CSV with columns in any order, quotes and CRLF', () => {
    const csv = `amount,recipient,asset\r\n100,${SOL_A},native\r\n"250",${SOL_A},${MINT}\r\n`;
    const p = parsePayments(csv, 'solana');
    expect(p).toEqual([
      { recipient: SOL_A, asset: 'native', amount: 100n, line: 1 },
      { recipient: SOL_A, asset: MINT, amount: 250n, line: 2 },
    ]);
  });

  it('reads JSON as an array or as {payments}, with string or integer amounts', () => {
    const arr = parsePayments(
      JSON.stringify([{ recipient: SOL_A, asset: 'NATIVE', amount: '12345678901234567890' }]),
      'solana',
    );
    expect(arr[0]).toMatchObject({ asset: 'native', amount: 12345678901234567890n });
    const obj = parsePayments(
      JSON.stringify({ payments: [{ recipient: SOL_A, asset: 'native', amount: 5 }] }),
      'solana',
    );
    expect(obj[0]?.amount).toBe(5n);
  });

  it('lower-cases EVM addresses so checksummed and plain forms compare equal', () => {
    const p = parsePayments(`recipient,asset,amount\n${EVM_A},${EVM_TOKEN},7\n`, 'base');
    expect(p[0]).toMatchObject({ recipient: EVM_A, asset: EVM_TOKEN.toLowerCase() });
  });

  it.each([
    ['recipient,asset,amount\n', /no payments/],
    ['recipient,asset\nx,native\n', /missing "amount"/],
    [`recipient,asset,amount\nnot-an-address,native,1\n`, /not a valid solana address/],
    [`recipient,asset,amount\n${SOL_A},native,1.5\n`, /whole number of base units/],
    [`recipient,asset,amount\n${SOL_A},native,-1\n`, /whole number/],
    [`recipient,asset,amount\n${SOL_A},native,0\n`, /greater than zero/],
    [`recipient,asset,amount\n${SOL_A},usdc,5\n`, /neither "native" nor a valid/],
    [`recipient,asset,amount\n${SOL_A},,5\n`, /asset is empty/],
  ])('rejects %j', (text, message) => {
    expect(() => parsePayments(text, 'solana')).toThrow(UsageError);
    expect(() => parsePayments(text, 'solana')).toThrow(message);
  });

  it('rejects an EVM address on solana and vice versa', () => {
    expect(() => parsePayments(`recipient,asset,amount\n${EVM_A},native,1\n`, 'solana')).toThrow(
      /not a valid solana/,
    );
    expect(() => parsePayments(`recipient,asset,amount\n${SOL_A},native,1\n`, 'base')).toThrow(
      /not a valid base/,
    );
  });

  it('rejects malformed JSON and non-integer JSON numbers', () => {
    expect(() => parsePayments('[{', 'solana')).toThrow(/not valid JSON/);
    expect(() =>
      parsePayments(JSON.stringify([{ recipient: SOL_A, asset: 'native', amount: 1.5 }]), 'solana'),
    ).toThrow(/whole number/);
  });
});
