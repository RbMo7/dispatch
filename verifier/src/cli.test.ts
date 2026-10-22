import { mkdtempSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { describe, expect, it } from 'vitest';
import { main, type Deps, type Io } from './cli.js';
import { RpcError } from './errors.js';

const fx = JSON.parse(
  readFileSync(new URL('../fixtures/squads.json', import.meta.url), 'utf8'),
) as {
  recipients: Record<string, string>;
  cases: Record<string, { proposal: string }>;
  accounts: Record<string, { owner: string; data: string }>;
};

const SECRET_URL = 'https://rpc.example.com/v2/SUPERSECRETKEY123';

const deps: Deps = {
  solanaReader: () => ({
    read: (addresses) =>
      Promise.resolve(
        addresses.map((a) => {
          const acc = fx.accounts[a];
          return acc
            ? { owner: acc.owner, data: Uint8Array.from(Buffer.from(acc.data, 'base64')) }
            : null;
        }),
      ),
    cluster: () => Promise.resolve(undefined),
  }),
  evmRpc: () => ({
    chainId: () =>
      Promise.reject(
        new RpcError(`RPC request eth_chainId failed: fetch failed for ${SECRET_URL}`),
      ),
    call: () => Promise.reject(new Error('unused')),
  }),
  service: () => ({ getTx: () => Promise.resolve(null), listByNonce: () => Promise.resolve([]) }),
};

function run(argv: string[], env: Record<string, string> = {}) {
  const out: string[] = [];
  const err: string[] = [];
  const io: Io = { out: (t) => out.push(t), err: (t) => err.push(t), env };
  return main(argv, io, deps).then((code) => ({ code, out: out.join('\n'), err: err.join('\n') }));
}

const dir = mkdtempSync(join(tmpdir(), 'verifier-'));
const file = (name: string, text: string) => {
  const p = join(dir, name);
  writeFileSync(p, text);
  return p;
};

const r = fx.recipients;
const matching = file(
  'ok.json',
  JSON.stringify([
    { recipient: r.r1, asset: 'native', amount: '1000000' },
    { recipient: r.r2, asset: 'native', amount: '2000000' },
  ]),
);

describe('cli', () => {
  it('exit 1 and MISMATCH for a proposal with other payments in it', async () => {
    // the sol-spl proposal also pays tokens that this file does not mention
    const res = await run([
      'verify',
      '--chain',
      'solana',
      '--rpc-url',
      SECRET_URL,
      '--proposal',
      fx.cases['sol-spl']!.proposal,
      '--payments',
      matching,
    ]);
    expect(res.code).toBe(1);
    expect(res.out.split('\n')[0]).toBe('MISMATCH');
    expect(res.out).toContain('EXTRA');
    expect(res.out).not.toContain('SUPERSECRETKEY123');
  });

  it('exit 0 and MATCH, reading the URL from the environment', async () => {
    const all = file('all.csv', `recipient,asset,amount\n${r.r1},native,1000000\n`);
    const res = await run(
      [
        'verify',
        '--chain',
        'solana',
        '--proposal',
        fx.cases['cancelled']!.proposal,
        '--payments',
        all,
      ],
      { VERIFIER_RPC_URL: SECRET_URL },
    );
    expect(res.code).toBe(0);
    expect(res.out.split('\n')[0]).toBe('MATCH');
    expect(res.out).toContain('Cancelled');
    expect(res.out).toMatch(/Coverage: this proposal pays 1 of the 1 payments/);
  });

  it('exit 2 for usage errors, with the usage text', async () => {
    for (const argv of [
      [],
      ['frobnicate'],
      ['verify'],
      ['verify', '--chain', 'solana', '--rpc-url', SECRET_URL, '--payments', matching],
      [
        'verify',
        '--chain',
        'base',
        '--rpc-url',
        SECRET_URL,
        '--safe',
        '0x1111111111111111111111111111111111111111',
        '--payments',
        matching,
      ],
      [
        'verify',
        '--chain',
        'solana',
        '--rpc-url',
        SECRET_URL,
        '--proposal',
        fx.cases['sol-spl']!.proposal,
        '--payments',
        '/no/such/file.csv',
      ],
      ['verify', '--chain', 'solana', '--bogus', 'x'],
    ]) {
      const res = await run(argv);
      expect(res.code, JSON.stringify(argv)).toBe(2);
    }
  });

  it('exit 2 on an RPC error and never prints the RPC URL or its key', async () => {
    const evm = file(
      'evm.csv',
      'recipient,asset,amount\n0x1111111111111111111111111111111111111111,native,1\n',
    );
    const res = await run([
      'verify',
      '--chain',
      'base',
      '--rpc-url',
      SECRET_URL,
      '--safe',
      '0x84Ac281B68de095f6227050F56C74d93d294e609',
      '--safe-tx-hash',
      `0x${'ab'.repeat(32)}`,
      '--payments',
      evm,
    ]);
    expect(res.code).toBe(2);
    expect(res.err).toContain('eth_chainId');
    expect(res.err).not.toContain('SUPERSECRETKEY123');
    expect(res.err).not.toContain('rpc.example.com/v2');
  });
});
