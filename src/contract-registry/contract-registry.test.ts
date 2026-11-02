import bs58 from 'bs58';
import { toFunctionSelector } from 'viem';
import { describe, expect, it } from 'vitest';

import type { KnownContract } from '../domain/known-contract.js';
import { decodeCall, decodeEffects } from '../effects/decode.js';
import {
  assetAt,
  BASE_PAYOUTS,
  ETH,
  FLOW,
  FSPL,
  readRecorded,
  recorded,
  SOL,
  VAULT,
  asset,
} from '../effects/test-support/recorded.js';
import type { Known } from '../effects/view.js';
import { parseAbi } from './abi.js';
import { ContractRegistry } from './contract-registry.js';
import { parseIdl } from './idl.js';

/** FlowVault as `scripts/flows/contracts.ts` compiles it: what an operator would paste. */
const FLOW_VAULT_ABI = [
  {
    type: 'event',
    name: 'Deposited',
    anonymous: false,
    inputs: [
      { name: 'from', type: 'address', indexed: true },
      { name: 'amount', type: 'uint256', indexed: false },
      { name: 'note', type: 'string', indexed: false },
    ],
  },
  {
    type: 'function',
    name: 'deposit',
    stateMutability: 'payable',
    inputs: [{ name: 'note', type: 'string' }],
    outputs: [],
  },
  { type: 'function', name: 'revertAlways', stateMutability: 'pure', inputs: [], outputs: [] },
];

const PROGRAM = 'GmaDrppBC7P5ARKV8g3djiwP89vz1jLK23V2GBjuAEGB';
const PAYER = '2KW2XRd9kwqet15Aha2oK3tYvd3nWbTFH1MBiRAv1BE1';
const TO = 'J2xccRtuG43drESLYznHhLhQkLTdfepcKYbiQ9BsJVaf';

/** A payroll program's IDL as Anchor 0.30 writes it. */
const IDL = {
  address: PROGRAM,
  metadata: { name: 'payroll', version: '0.1.0', spec: '0.1.0' },
  instructions: [
    {
      name: 'pay',
      discriminator: [119, 18, 216, 65, 192, 117, 122, 220],
      accounts: [
        { name: 'payer', writable: true, signer: true },
        { name: 'mint' },
        { name: 'route', accounts: [{ name: 'to', writable: true }] },
      ],
      args: [
        { name: 'amount', type: 'u64' },
        { name: 'memo', type: 'string' },
        { name: 'tip_lamports', type: 'u64' },
        { name: 'schedule', type: { option: { defined: { name: 'Schedule' } } } },
        { name: 'tags', type: { vec: 'u16' } },
        { name: 'beneficiary', type: 'pubkey' },
      ],
    },
  ],
  types: [
    {
      name: 'Schedule',
      type: {
        kind: 'enum',
        variants: [{ name: 'Once' }, { name: 'Every', fields: [{ name: 'days', type: 'u8' }] }],
      },
    },
  ],
};

/** The same program in the format before Anchor 0.30, which leaves discriminators out. */
const LEGACY_IDL = {
  version: '0.1.0',
  name: 'payroll',
  instructions: [
    {
      name: 'pay',
      accounts: [
        { name: 'payer', isMut: true, isSigner: true },
        { name: 'mint', isMut: false, isSigner: false },
        { name: 'route', accounts: [{ name: 'to', isMut: true, isSigner: false }] },
      ],
      args: [
        { name: 'amount', type: 'u64' },
        { name: 'memo', type: 'string' },
        { name: 'tip_lamports', type: 'u64' },
        { name: 'schedule', type: { option: { defined: 'Schedule' } } },
        { name: 'tags', type: { vec: 'u16' } },
        { name: 'beneficiary', type: 'publicKey' },
      ],
    },
  ],
  types: IDL.types,
};

/** `pay(1.5 FSPL, "October", 0.002 SOL tip, Every 14 days, tags [7, 300], TO)`, Borsh-encoded by hand. */
function payData(): string {
  const u64 = (n: bigint) => {
    const b = Buffer.alloc(8);
    b.writeBigUInt64LE(n);
    return b;
  };
  const u32 = (n: number) => {
    const b = Buffer.alloc(4);
    b.writeUInt32LE(n);
    return b;
  };
  const u16 = (n: number) => {
    const b = Buffer.alloc(2);
    b.writeUInt16LE(n);
    return b;
  };
  return Buffer.concat([
    Buffer.from([119, 18, 216, 65, 192, 117, 122, 220]),
    u64(1_500_000n),
    u32(7),
    Buffer.from('October'),
    u64(2_000_000n),
    Buffer.from([1, 1, 14]),
    u32(2),
    u16(7),
    u16(300),
    Buffer.from(bs58.decode(TO)),
  ]).toString('base64');
}

function contract(fields: Partial<KnownContract> & Pick<KnownContract, 'chain' | 'address'>) {
  return {
    id: crypto.randomUUID(),
    label: 'FlowVault',
    source: 'console',
    addedBy: 'operator',
    addedAt: new Date('2026-11-01T12:00:00Z'),
    enabled: true,
    ...fields,
  } as KnownContract;
}

const knownWith = (rows: KnownContract[]): Known => ({
  assetAt,
  contractAt: ContractRegistry.of(rows).at,
});

const baseInput = (name: string) => {
  const { to, input, value } = recorded(name).rpc.eth_getTransactionByHash as {
    to: string;
    input: string;
    value: string;
  };
  return { to, data: input, value: BigInt(value).toString() };
};

describe('reading a pasted ABI (ADR-0063)', () => {
  it('takes an ABI array or a compiler artifact holding one', () => {
    expect(parseAbi(FLOW_VAULT_ABI).ok).toBe(true);
    const artifact = parseAbi({ contractName: 'FlowVault', abi: FLOW_VAULT_ABI });
    expect(artifact.ok && artifact.value.abi).toEqual(FLOW_VAULT_ABI);
  });

  it.each([
    [{ abi: 'deposit(string)' }, 'abi: must be a JSON array of ABI items'],
    [
      [{ type: 'function', name: 'pay', inputs: [{ name: 'amount', type: 'uint' }] }],
      'abi[0].inputs[0].type: "uint" needs its size: write uint256',
    ],
    [
      [{ type: 'function', name: 'pay', inputs: [{ name: 'to', type: 'adress' }] }],
      'abi[0].inputs[0].type: "adress" is not a Solidity type',
    ],
    [[{ type: 'event', inputs: [] }], 'abi[0].name: a event needs a name'],
    [
      [{ type: 'constructor', inputs: [] }],
      'abi: has no functions or events, so it explains nothing',
    ],
    [
      [{ type: 'function', name: 'f', inputs: [{ type: 'tuple' }] }],
      'abi[0].inputs[0].components: a tuple needs its components',
    ],
  ])('refuses %j, naming what is wrong', (raw, message) => {
    expect(parseAbi(raw)).toEqual({ ok: false, error: message });
  });
});

describe('reading a pasted Anchor IDL (ADR-0063)', () => {
  it.each([
    [{ instructions: [] }, 'idl.instructions: must list at least one instruction'],
    [
      { instructions: [{ name: 'pay', args: [{ name: 'a', type: 'u65' }] }] },
      'idl.instructions[0].args[0].type: "u65" is not an IDL type',
    ],
    [
      { instructions: [{ name: 'pay', args: [{ name: 'a', type: { defined: 'Missing' } }] }] },
      'idl.types: has no type named "Missing"',
    ],
    [
      { instructions: [{ name: 'pay', discriminator: [1, 300] }] },
      'idl.instructions[0].discriminator: must be an array of bytes',
    ],
  ])('refuses %j, naming what is wrong', (raw, message) => {
    expect(parseIdl(raw)).toEqual({ ok: false, error: message });
  });

  it("derives an older IDL's discriminators as Anchor does", () => {
    const idl = parseIdl({
      name: 'any',
      instructions: [{ name: 'initialize', accounts: [], args: [] }],
    });
    // Anchor's own discriminator for `initialize`, sha256("global:initialize")[..8].
    expect(idl.ok && idl.value.instructions[0]!.discriminator).toBe('afaf6d1f0d989bed');
  });
});

describe('the contract registry explains calls at read time (ADR-0063)', () => {
  it('row 4: registering FlowVault after the call confirmed names deposit(note) and its Deposited event', async () => {
    const effects = await readRecorded('base-call-with-value');
    const before = { assetAt, contractAt: ContractRegistry.of([]).at };
    expect(decodeCall('base', baseInput('base-call-with-value'), before).decoded).toBe(false);
    expect(decodeEffects(effects, before).undecodedEvents).toBe(1);

    const known = knownWith([contract({ chain: 'base', address: VAULT, abi: FLOW_VAULT_ABI })]);

    expect(decodeCall('base', baseInput('base-call-with-value'), known)).toEqual({
      target: VAULT,
      label: 'FlowVault',
      decoded: true,
      decoder: 'abi',
      function: 'deposit',
      args: [{ name: 'note', type: 'string', value: 'flows row 4' }],
      selector: toFunctionSelector('deposit(string)'),
      value: { amount: '1000000000000', asset: ETH, formatted: '0.000001' },
    });
    const view = decodeEffects(effects, known);
    expect(view.events).toEqual([
      {
        kind: 'log',
        source: VAULT,
        label: 'FlowVault',
        decoder: 'abi',
        name: 'Deposited',
        args: [
          { name: 'from', type: 'address', value: BASE_PAYOUTS },
          { name: 'amount', type: 'uint256', value: '1000000000000' },
          { name: 'note', type: 'string', value: 'flows row 4' },
        ],
      },
    ]);
    expect(view.undecodedEvents).toBe(0);
    expect(view.transfers.map((t) => t.standard)).toEqual(['native']);
  });

  it('labels a registered contract whose ABI lacks the event, and a disabled one explains nothing', async () => {
    const effects = await readRecorded('base-call-with-value');
    const callsOnly = FLOW_VAULT_ABI.filter((item) => item.type === 'function');
    expect(
      decodeEffects(
        effects,
        knownWith([contract({ chain: 'base', address: VAULT, abi: callsOnly })]),
      ).undecodedEventSources,
    ).toEqual([{ source: VAULT, label: 'FlowVault', count: 1 }]);

    const disabled = knownWith([
      contract({ chain: 'base', address: VAULT, abi: FLOW_VAULT_ABI, enabled: false }),
    ]);
    expect(decodeCall('base', baseInput('base-call-with-value'), disabled)).toMatchObject({
      decoded: false,
    });
    expect(decodeCall('base', baseInput('base-call-with-value'), disabled)).not.toHaveProperty(
      'label',
    );
  });

  it('shows an amount argument in the token the call names, when that token is a Known Asset', () => {
    const abi = [
      {
        type: 'function',
        name: 'deposit',
        inputs: [
          { name: 'token', type: 'address' },
          { name: 'amount', type: 'uint256' },
          { name: 'nonce', type: 'uint256' },
        ],
      },
    ];
    const known = knownWith([contract({ chain: 'base', address: VAULT, label: 'Escrow', abi })]);
    const data = `0x${toFunctionSelector('deposit(address,uint256,uint256)').slice(2)}${FLOW.slice(2).toLowerCase().padStart(64, '0')}${1_250_000n.toString(16).padStart(64, '0')}${9n.toString(16).padStart(64, '0')}`;

    expect(decodeCall('base', { to: VAULT, data, value: '0' }, known).args).toEqual([
      { name: 'token', type: 'address', value: FLOW },
      {
        name: 'amount',
        type: 'uint256',
        value: '1250000',
        asset: asset(FLOW, 'FLOW', 6),
        formatted: '1.25',
      },
      { name: 'nonce', type: 'uint256', value: '9' },
    ]);
  });

  it.each([
    ['Anchor 0.30', IDL],
    ['older Anchor', LEGACY_IDL],
  ])('decodes a program call with its registered %s IDL: accounts, then arguments', (_, idl) => {
    const known = knownWith([
      contract({ chain: 'solana', address: PROGRAM, label: 'Payroll', idl }),
    ]);
    const call = {
      programId: PROGRAM,
      accounts: [PAYER, FSPL, TO].map((pubkey) => ({ pubkey, isSigner: false, isWritable: false })),
      data: payData(),
    };

    expect(decodeCall('solana', call, known)).toEqual({
      target: PROGRAM,
      label: 'Payroll',
      decoded: true,
      decoder: 'idl',
      function: 'pay',
      selector: '7712d841c0757adc',
      args: [
        { name: 'payer', type: 'pubkey', value: PAYER },
        { name: 'mint', type: 'pubkey', value: FSPL },
        { name: 'route.to', type: 'pubkey', value: TO },
        {
          name: 'amount',
          type: 'u64',
          value: '1500000',
          asset: asset(FSPL, 'FSPL', 6),
          formatted: '1.5',
        },
        { name: 'memo', type: 'string', value: 'October' },
        { name: 'tip_lamports', type: 'u64', value: '2000000', asset: SOL, formatted: '0.002' },
        { name: 'schedule', type: 'option<Schedule>', value: { Every: { days: '14' } } },
        { name: 'tags', type: 'vec<u16>', value: ['7', '300'] },
        { name: 'beneficiary', type: 'pubkey', value: TO },
      ],
    });
  });

  it('leaves a program call raw when its data does not fit the IDL', () => {
    const known = knownWith([
      contract({ chain: 'solana', address: PROGRAM, label: 'Payroll', idl: IDL }),
    ]);
    const data = Buffer.from(payData(), 'base64').subarray(0, 12).toString('base64');

    expect(decodeCall('solana', { programId: PROGRAM, accounts: [], data }, known)).toEqual({
      target: PROGRAM,
      label: 'Payroll',
      decoded: false,
      selector: '7712d841c0757adc',
      data,
    });
  });
});
