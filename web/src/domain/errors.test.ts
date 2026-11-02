// @vitest-environment node
import { readFileSync } from 'node:fs';

import { describe, expect, it } from 'vitest';
import { parse } from 'yaml';

import { CATALOGUE, errorRow, explainError } from './errors';

type Schema = { properties: { code: { enum: string[] } } };
const spec = parse(
  readFileSync(new URL('../../../docs/openapi.yaml', import.meta.url), 'utf8'),
) as { components: { schemas: Record<string, Schema> } };

describe('the error catalogue', () => {
  it('has an entry for every error code docs/openapi.yaml documents', () => {
    const documented = ['Error', 'RequestError'].flatMap(
      (name) => spec.components.schemas[name]!.properties.code.enum,
    );
    expect(documented.length).toBeGreaterThan(20);
    expect(documented.filter((code) => !(code in CATALOGUE))).toEqual([]);
  });

  it('names an unknown asset and links to adding it under Assets, chain and symbol filled in', () => {
    const explained = explainError(
      {
        code: 'UNKNOWN_ASSET',
        message: 'no known token configured for asset "USDT"',
        detail: { asset: 'USDT' },
      },
      { chain: 'base' },
    );

    expect(explained.text).toBe('USDT is not a known asset on Base.');
    expect(explained.next).toBe('Add it under Assets, then send again.');
    expect(explained.fix).toEqual({
      label: 'Add it under Assets',
      href: '/console/assets?chain=base&symbol=USDT',
    });
  });

  it('puts a mint or contract address in the Assets link as the address', () => {
    const mint = '4zMMC9srt5Ri5X14GAgXhaHii3GnPAEERYPJgZJDncDU';
    const { fix } = explainError(
      { code: 'UNKNOWN_ASSET', message: '', detail: { asset: mint } },
      { chain: 'solana' },
    );
    expect(fix?.href).toBe(`/console/assets?chain=solana&add=${mint}`);
  });

  it('explains a refused asset change by what was refused and the symbol typed', () => {
    const refused = (
      code: string,
      asset: NonNullable<Parameters<typeof explainError>[1]['asset']>,
    ) => {
      const { text, next } = explainError({ code, message: '' }, { chain: 'solana', asset });
      return typeof text === 'string' ? `${text} ${next}` : text;
    };

    expect(refused('SYMBOL_REQUIRED', { change: 'add' })).toBe(
      'This token publishes no symbol. Give it one under Symbol, then preview again.',
    );
    expect(refused('SYMBOL_TAKEN', { change: 'add', symbol: 'FLOW' })).toBe(
      'FLOW is already used on Solana. Choose another symbol, then preview again.',
    );
    expect(refused('SYMBOL_TAKEN', { change: 'add' })).toBe(
      "The token's own symbol is already used on Solana. Give it another under Symbol, then preview again.",
    );
    expect(refused('SYMBOL_TAKEN', { change: 'enable' })).toBe(
      'Another enabled asset on Solana uses this symbol. Disable that one first.',
    );
    expect(refused('NOT_A_TOKEN', { change: 'add' })).toBe(
      "This address is not a token on Solana. Paste the token's mint address, not a wallet.",
    );
    expect(refused('RPC_UNAVAILABLE', { change: 'disable' })).toBe(
      'The Solana RPC could not be reached or did not answer. Try again in a moment.',
    );
  });

  it("quotes the engine's own words only where they add a fact", () => {
    const message = "Fq2… can't be paid out: the mint has a transfer fee";
    expect(explainError({ code: 'NOT_PAYABLE', message }, { chain: 'solana' }).quote).toBe(message);
    expect(
      explainError({ code: 'SYMBOL_REQUIRED', message }, { chain: 'solana' }).quote,
    ).toBeNull();
  });

  it('says which Sender is short, by how much, and which address to fund', () => {
    const { text, fix } = explainError(
      {
        code: 'INSUFFICIENT_FUNDS',
        message: 'insufficient USDC balance',
        detail: { asset: 'USDC', short: '40000000' },
      },
      {
        chain: 'base',
        sender: { name: 'payouts', address: '0x8b21c4f0E2a9D3b1c7A6e5F4d3C2b1A0f9e844fe' },
        amountIn: (asset) =>
          asset === 'USDC' ? { asset, name: 'USD Coin', raw: '1', decimals: 6 } : undefined,
      },
    );

    expect(text).toEqual([
      'payouts is short ',
      { asset: 'USDC', name: 'USD Coin', raw: '40000000', decimals: 6 },
      '. Fund 0x8b21…44fe.',
    ]);
    expect(fix?.href).toBe('/console/senders');
  });

  it("names a Multisig Sender's short balance and its own address", () => {
    const { text } = explainError(
      {
        code: 'INSUFFICIENT_FUNDS',
        message: 'insufficient SOL balance',
        detail: {
          asset: 'SOL',
          short: '2039280',
          holder: 'memberKey',
          address: 'Member1111111111111111111111111111111111111',
        },
      },
      {
        chain: 'solana',
        sender: { name: 'treasury', address: 'Vault1111111111111111111111111111111111111' },
      },
    );
    expect(text).toBe('treasury, its member key, cannot cover it in SOL. Fund Member…1111.');
  });

  it('gives the revert reason a Base transaction reverted with', () => {
    const explained = explainError(
      {
        code: 'CHAIN_REJECTED',
        message: 'reverted: always reverts',
        detail: { reason: 'always reverts' },
      },
      { chain: 'base' },
    );
    expect(explained.line).toBe('Reverted: always reverts');
    expect(explained.text).toBe(
      'The transaction reverted on chain with the reason "always reverts".',
    );
  });

  it("gives the Signer's reason for a policy refusal", () => {
    const explained = explainError(
      { code: 'SIGNER_REFUSED', message: 'signer refused: chainId 1 is not allowed for this key' },
      { chain: 'base' },
    );
    expect(explained.text).toBe(
      "The Signer's policy refused this transaction: chainId 1 is not allowed for this key.",
    );
  });

  it('explains a plain error by its message, and a code it does not know by its own words', () => {
    expect(
      explainError({ code: null, message: 'items must be a non-empty array' }, { chain: 'base' }),
    ).toMatchObject({ title: 'Invalid request', text: 'Items must be a non-empty array.' });
    expect(
      explainError({ code: 'SOMETHING_NEW', message: 'a new failure' }, { chain: null }),
    ).toMatchObject({ title: 'SOMETHING_NEW', text: 'A new failure.' });
  });
});

describe("an item row's error line", () => {
  const base = { chain: 'base' as const };

  it('keeps the catalogue line where it names the fact', () => {
    expect(
      errorRow(
        {
          code: 'CHAIN_REJECTED',
          message: 'reverted',
          detail: { reason: 'FlowVault: always reverts' },
        },
        base,
      ),
    ).toBe('Reverted: FlowVault: always reverts');
  });

  it("adds the engine's message where the line is only the kind of error", () => {
    expect(
      errorRow(
        { code: 'CHAIN_REJECTED', message: 'base reported this transaction as failed' },
        base,
      ),
    ).toBe('Not valid on the chain: base reported this transaction as failed');
  });
});
