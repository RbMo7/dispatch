import { mkdtempSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import path from 'node:path';

import { Keypair } from '@solana/web3.js';
import { getAddress } from 'viem';
import { describe, expect, it } from 'vitest';

import { deriveVaultAddress } from './chain-handler/solana/multisig/multisig-config.js';
import type { Chain } from './domain/chain.js';
import {
  parseSendersConfig,
  readSendersSource,
  type SenderVariables,
  type SendersConfig,
} from './senders-config.js';

const HOT = Keypair.generate().publicKey.toBase58();
const MULTISIG = Keypair.generate().publicKey;
const MEMBER = Keypair.generate().publicKey.toBase58();
const VAULT = deriveVaultAddress(MULTISIG).toBase58();
const BASE_HOT = `0x${'a1'.repeat(20)}`;
const SAFE = `0x${'b2'.repeat(20)}`;
const EXECUTOR = `0x${'c3'.repeat(20)}`;

const NO_VARIABLES: SenderVariables = {
  solana: {
    senderMode: '',
    senderAddress: '',
    multisigAddress: '',
    memberAddress: '',
    approvalDeadlineMs: '',
    approvalRewatchWindowMs: '',
  },
  base: {
    senderMode: '',
    senderAddress: '',
    safeAddress: '',
    safeExecutorAddress: '',
    txServiceUrl: '',
    apiKey: '',
    approvalDeadlineMs: '',
    approvalRewatchWindowMs: '',
    bundleLimit: '',
  },
};

function fromFile(
  file: unknown,
  enabledChains: Chain[] = ['solana', 'base'],
  variables: SenderVariables = NO_VARIABLES,
): SendersConfig {
  const text = typeof file === 'string' ? file : JSON.stringify(file);
  return parseSendersConfig({
    source: { kind: 'file', path: 'senders.json', text },
    enabledChains,
    variables,
  });
}

/** The problems a rejected file reports, one per line. */
function problemsOf(file: unknown, enabledChains: Chain[] = ['solana', 'base']): string[] {
  try {
    fromFile(file, enabledChains);
  } catch (error) {
    const [heading, ...lines] = (error as Error).message.split('\n');
    expect(heading).toBe('invalid senders file senders.json:');
    return lines.map((line) => line.replace(/^ {2}- /, ''));
  }
  throw new Error('the file was accepted');
}

const VALID = {
  solana: {
    default: 'payouts',
    senders: {
      payouts: { address: HOT },
      treasury: {
        mode: 'squads',
        multisig: MULTISIG.toBase58(),
        memberKey: MEMBER,
        approvalDeadlineMs: 3_600_000,
      },
    },
  },
  base: {
    default: 'payouts',
    senders: {
      payouts: { address: BASE_HOT },
      vault: { mode: 'safe', safe: SAFE, executor: EXECUTOR, bundleLimit: 20 },
    },
  },
};

describe('parseSendersConfig without a senders file', () => {
  it("gives each enabled chain one Sender named default, from today's variables", () => {
    const config = parseSendersConfig({
      source: { kind: 'variables' },
      enabledChains: ['solana', 'base'],
      variables: {
        solana: { ...NO_VARIABLES.solana, senderAddress: HOT },
        base: { ...NO_VARIABLES.base, senderAddress: BASE_HOT },
      },
    });

    expect(config.source).toBe('variables');
    expect(config.warnings).toEqual([]);
    expect(config.chains.map(({ chain, default: d, senders }) => ({ chain, d, senders }))).toEqual([
      {
        chain: 'solana',
        d: 'default',
        senders: [expect.objectContaining({ chain: 'solana', name: 'default', address: HOT })],
      },
      {
        chain: 'base',
        d: 'default',
        senders: [
          expect.objectContaining({
            chain: 'base',
            name: 'default',
            address: BASE_HOT,
            handlerAddress: BASE_HOT,
          }),
        ],
      },
    ]);
  });

  it('pays from the vault in multisig mode and from the Safe in safe mode, as before', () => {
    const config = parseSendersConfig({
      source: { kind: 'variables' },
      enabledChains: ['solana', 'base'],
      variables: {
        solana: {
          ...NO_VARIABLES.solana,
          senderMode: 'multisig',
          multisigAddress: MULTISIG.toBase58(),
          memberAddress: MEMBER,
        },
        base: {
          ...NO_VARIABLES.base,
          senderMode: 'safe',
          safeAddress: SAFE,
          safeExecutorAddress: EXECUTOR,
        },
      },
    });

    const [solana, base] = config.chains.map((c) => c.senders[0]);
    expect(solana?.address).toBe(VAULT);
    expect(base).toMatchObject({ address: getAddress(SAFE), handlerAddress: EXECUTOR });
  });

  it('describes only the enabled chains', () => {
    const config = parseSendersConfig({
      source: { kind: 'variables' },
      enabledChains: ['base'],
      variables: NO_VARIABLES,
    });
    expect(config.chains.map((c) => c.chain)).toEqual(['base']);
  });
});

describe('parseSendersConfig with a senders file', () => {
  it('reads named Senders per chain, each in its mode, and the default', () => {
    const config = fromFile(VALID);

    expect(config.source).toBe('file');
    const [solana, base] = config.chains;
    expect(solana?.default).toBe('payouts');
    expect(solana?.senders).toEqual([
      {
        chain: 'solana',
        name: 'payouts',
        address: HOT,
        settings: { ...NO_VARIABLES.solana, senderAddress: HOT },
      },
      {
        chain: 'solana',
        name: 'treasury',
        address: VAULT,
        settings: {
          ...NO_VARIABLES.solana,
          senderMode: 'multisig',
          multisigAddress: MULTISIG.toBase58(),
          memberAddress: MEMBER,
          approvalDeadlineMs: '3600000',
        },
      },
    ]);
    expect(base?.senders).toEqual([
      {
        chain: 'base',
        name: 'payouts',
        address: getAddress(BASE_HOT),
        handlerAddress: getAddress(BASE_HOT),
        settings: { ...NO_VARIABLES.base, senderAddress: getAddress(BASE_HOT) },
      },
      {
        chain: 'base',
        name: 'vault',
        address: getAddress(SAFE),
        handlerAddress: getAddress(EXECUTOR),
        settings: {
          ...NO_VARIABLES.base,
          senderMode: 'safe',
          safeAddress: getAddress(SAFE),
          safeExecutorAddress: getAddress(EXECUTOR),
          bundleLimit: '20',
        },
      },
    ]);
  });

  it('leaves the default unset when the file names none', () => {
    const config = fromFile({ base: { senders: { payouts: { address: BASE_HOT } } } }, ['base']);
    expect(config.chains[0]?.default).toBeNull();
  });

  it('uses BASE_SAFE_API_KEY for a Safe Sender that names no key of its own', () => {
    const config = fromFile(VALID, ['base'], {
      ...NO_VARIABLES,
      base: { ...NO_VARIABLES.base, apiKey: 'from-env' },
    });
    const vault = config.chains[0]?.senders[1];
    expect(vault?.chain === 'base' && vault.settings.apiKey).toBe('from-env');
  });

  it('ignores chains that are not enabled', () => {
    const config = fromFile(VALID, ['solana']);
    expect(config.chains.map((c) => c.chain)).toEqual(['solana']);
  });

  it('warns that the per-chain variables are ignored for a chain the file describes', () => {
    const config = fromFile(VALID, ['solana', 'base'], {
      solana: { ...NO_VARIABLES.solana, senderAddress: HOT, senderMode: 'single' },
      base: NO_VARIABLES.base,
    });
    expect(config.warnings).toEqual([
      "SOLANA_SENDER_ADDRESS ignored: the senders file senders.json describes solana's Senders",
    ]);
  });
});

describe('parseSendersConfig rejects a senders file', () => {
  it('that is not JSON', () => {
    expect(problemsOf('{ "solana": ')).toEqual([expect.stringMatching(/^not valid JSON: /)]);
  });

  it('that is not an object keyed by chain', () => {
    expect(problemsOf([])).toEqual([
      'the file must be a JSON object keyed by chain, e.g. { "solana": { … } }',
    ]);
  });

  it('with two Senders of the same name on a chain', () => {
    const text = `{ "base": { "senders": {
      "payouts": { "address": "${BASE_HOT}" },
      "payouts": { "address": "${EXECUTOR}" } } } }`;
    expect(problemsOf(text, ['base'])).toEqual([
      'base has two Senders named "payouts"; names must be unique per chain',
    ]);
  });

  it('with a name that is not lowercase letters, digits or hyphens', () => {
    expect(problemsOf({ base: { senders: { Payouts: { address: BASE_HOT } } } }, ['base'])).toEqual(
      ['base sender name "Payouts" must be 1 to 40 lowercase letters, digits or hyphens'],
    );
    expect(
      problemsOf({ base: { senders: { ['a'.repeat(41)]: { address: BASE_HOT } } } }, ['base']),
    ).toHaveLength(1);
  });

  it('with no Senders for an enabled chain', () => {
    expect(problemsOf({ solana: VALID.solana })).toEqual([
      'base is enabled (ENABLED_CHAINS) but the file has no Senders for it',
    ]);
    expect(problemsOf({ ...VALID, base: { senders: {} } })).toEqual([
      'base is enabled (ENABLED_CHAINS) but has no Senders: add one under "senders"',
    ]);
  });

  it('whose default is not one of the Senders', () => {
    expect(problemsOf({ base: { ...VALID.base, default: 'treasury' } }, ['base'])).toEqual([
      'base default "treasury" is not one of its Senders (payouts, vault)',
    ]);
  });

  it('where two Senders share an address', () => {
    expect(
      problemsOf(
        {
          base: {
            senders: {
              payouts: { address: BASE_HOT },
              refunds: { address: getAddress(BASE_HOT) },
            },
          },
        },
        ['base'],
      ),
    ).toEqual([
      `base Senders "payouts" and "refunds" share the address ${getAddress(BASE_HOT)}; each Sender needs its own keys and balances`,
    ]);
  });

  it("where a plain Sender is another Sender's engine key", () => {
    expect(
      problemsOf(
        {
          solana: {
            senders: {
              payouts: { address: MEMBER },
              treasury: { mode: 'squads', multisig: MULTISIG.toBase58(), memberKey: MEMBER },
            },
          },
        },
        ['solana'],
      ),
    ).toEqual([
      `solana Senders "payouts" and "treasury" share the address ${MEMBER}; each Sender needs its own keys and balances`,
    ]);
  });

  it('with a field its mode does not take, or a mode its chain does not have', () => {
    expect(
      problemsOf({ base: { senders: { payouts: { address: BASE_HOT, multisig: SAFE } } } }, [
        'base',
      ]),
    ).toEqual(['base sender "payouts": "multisig" is not a field of a single Sender']);
    expect(
      problemsOf({ base: { senders: { payouts: { mode: 'squads', address: BASE_HOT } } } }, [
        'base',
      ]),
    ).toEqual(['base sender "payouts": mode must be "single" or "safe", got "squads"']);
    expect(
      problemsOf({ base: { senders: { payouts: { address: BASE_HOT } }, defualt: 'payouts' } }, [
        'base',
      ]),
    ).toEqual(['base: "defualt" is not a field; a chain has "senders" and an optional "default"']);
  });

  it('with a missing or malformed field', () => {
    expect(
      problemsOf({ solana: { senders: { treasury: { mode: 'squads', multisig: 'nope' } } } }, [
        'solana',
      ]),
    ).toEqual([
      'solana sender "treasury": multisig is not a valid base58 Solana address: nope',
      'solana sender "treasury": memberKey is required for a squads Sender',
    ]);
    expect(
      problemsOf(
        {
          base: {
            senders: { vault: { mode: 'safe', safe: SAFE, executor: EXECUTOR, bundleLimit: 0 } },
          },
        },
        ['base'],
      ),
    ).toEqual(['base sender "vault": bundleLimit must be a positive whole number, got 0']);
  });

  it('naming every problem at once, one per line', () => {
    expect(
      problemsOf({
        solana: { default: 'none', senders: { payouts: { address: HOT } } },
        base: { senders: { Bad: { address: BASE_HOT } } },
      }),
    ).toEqual([
      'solana default "none" is not one of its Senders (payouts)',
      'base sender name "Bad" must be 1 to 40 lowercase letters, digits or hyphens',
    ]);
  });
});

describe('readSendersSource', () => {
  it("falls back to today's variables when there is no senders.json", () => {
    expect(readSendersSource('')).toEqual({ kind: 'variables' });
  });

  it('reads the file SENDERS_FILE names, and refuses one that does not exist', () => {
    const dir = mkdtempSync(path.join(tmpdir(), 'senders-'));
    const file = path.join(dir, 'senders.json');
    writeFileSync(file, '{}');
    expect(readSendersSource(file)).toEqual({ kind: 'file', path: file, text: '{}' });
    expect(() => readSendersSource(path.join(dir, 'missing.json'))).toThrow(
      /SENDERS_FILE names .*missing\.json, which does not exist/,
    );
  });
});
