import { describe, expect, it } from 'vitest';

import { lookupKey, parseSignerConfig } from './config.js';

const EVM = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A';
const SOLANA = '3fJt3SpG7iWcYfo2MnP8b1LaP3eBhzZ57zHBxWSPWoZe';

describe('parseSignerConfig', () => {
  it('maps each address to its curve, backend and keyRef, EVM addresses keyed in lowercase', () => {
    const config = parseSignerConfig({
      [EVM]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'dev-sender' },
      [SOLANA]: { curve: 'ed25519', backend: 'keyfile', keyRef: 'dev-sender' },
    });

    expect([...config.entries()]).toEqual([
      [
        EVM.toLowerCase(),
        { address: EVM, curve: 'secp256k1', backend: 'keyfile', keyRef: 'dev-sender' },
      ],
      [SOLANA, { address: SOLANA, curve: 'ed25519', backend: 'keyfile', keyRef: 'dev-sender' }],
    ]);
  });

  it.each([
    ['an entry that is not an object', 'keyfile', 'must be an object'],
    [
      'an unknown curve',
      { curve: 'p256', backend: 'keyfile', keyRef: 'k' },
      'curve must be one of',
    ],
    [
      'an unknown backend',
      { curve: 'ed25519', backend: 'vault', keyRef: 'k' },
      'unknown backend "vault"',
    ],
    [
      'a missing keyRef',
      { curve: 'ed25519', backend: 'keyfile' },
      'keyRef must be a non-empty string',
    ],
    ['an empty keyRef', { curve: 'ed25519', backend: 'keyfile', keyRef: '' }, 'keyRef must be'],
  ])('refuses %s, naming the address', (_, entry, problem) => {
    expect(() => parseSignerConfig({ [SOLANA]: entry })).toThrow(`${SOLANA}: ${problem}`);
  });

  it('names every bad address at once', () => {
    expect(() =>
      parseSignerConfig({
        [EVM]: { curve: 'secp256k1', backend: 'vault', keyRef: 'k' },
        [SOLANA]: { curve: 'ed25519', backend: 'keyfile' },
      }),
    ).toThrow(new RegExp(`${EVM}: unknown backend[\\s\\S]*${SOLANA}: keyRef`));
  });

  it('refuses one EVM address written twice in different case', () => {
    expect(() =>
      parseSignerConfig({
        [EVM]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'a' },
        [EVM.toLowerCase()]: { curve: 'secp256k1', backend: 'keyfile', keyRef: 'b' },
      }),
    ).toThrow(`${EVM.toLowerCase()}: the same address as ${EVM}`);
  });

  it.each([
    ['an array', []],
    ['null', null],
    ['an empty object', {}],
  ])('refuses %s', (_, raw) => {
    expect(() => parseSignerConfig(raw)).toThrow(/SIGNER_CONFIG/);
  });
});

describe('lookupKey', () => {
  it('ignores case on secp256k1 and keeps it on ed25519', () => {
    expect(lookupKey('secp256k1', EVM)).toBe(lookupKey('secp256k1', EVM.toLowerCase()));
    expect(lookupKey('ed25519', SOLANA)).not.toBe(lookupKey('ed25519', SOLANA.toLowerCase()));
  });
});
