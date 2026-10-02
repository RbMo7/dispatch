import {
  createApproveInstruction,
  createAssociatedTokenAccountIdempotentInstruction,
  createTransferCheckedInstruction,
  createTransferInstruction,
  getAssociatedTokenAddressSync,
  TOKEN_2022_PROGRAM_ID,
  TOKEN_PROGRAM_ID,
} from '@solana/spl-token';
import {
  AddressLookupTableAccount,
  ComputeBudgetProgram,
  Keypair,
  NONCE_ACCOUNT_LENGTH,
  PublicKey,
  SystemProgram,
  Transaction,
  TransactionInstruction,
  TransactionMessage,
} from '@solana/web3.js';
import {
  encodeFunctionData,
  erc20Abi,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { describe, expect, it } from 'vitest';

import type { Curve } from './backends/key-backend.js';
import { evaluatePolicy, parsePolicy, type Policy } from './policy.js';

function policy(curve: Curve, raw: Record<string, unknown>): Policy {
  const parsed = parsePolicy(curve, raw);
  if (Array.isArray(parsed)) throw new Error(parsed.join('; '));
  return parsed;
}

describe('EVM policy', () => {
  const RECIPIENT: Address = '0x000000000000000000000000000000000000dEaD';
  const OTHER: Address = '0x00000000000000000000000000000000000b0b00';
  const TOKEN: Address = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
  const AGGREGATOR: Address = '0xcA11bde05977b3631167028862bE2a173976CA11';

  // The engine's Bulk Call encoding (src/chain-handler/base/bulk-call.ts).
  const AGGREGATE3_VALUE_ABI = [
    {
      type: 'function',
      name: 'aggregate3Value',
      stateMutability: 'payable',
      inputs: [
        {
          name: 'calls',
          type: 'tuple[]',
          components: [
            { name: 'target', type: 'address' },
            { name: 'allowFailure', type: 'bool' },
            { name: 'value', type: 'uint256' },
            { name: 'callData', type: 'bytes' },
          ],
        },
      ],
      outputs: [],
    },
  ] as const;

  type Call = { to: Address; value: bigint; data: Hex };

  function transfer(to: Address, amount: bigint): Hex {
    return encodeFunctionData({ abi: erc20Abi, functionName: 'transfer', args: [to, amount] });
  }

  function bulk(calls: Call[]): Hex {
    return encodeFunctionData({
      abi: AGGREGATE3_VALUE_ABI,
      args: [
        calls.map((c) => ({ target: c.to, allowFailure: false, value: c.value, callData: c.data })),
      ],
    });
  }

  /** As the Base handler's sign() serializes it (transaction-codec.ts). */
  function unsigned(fields: Partial<TransactionSerializableEIP1559>): Uint8Array {
    return Buffer.from(
      serializeTransaction({
        type: 'eip1559',
        chainId: 84532,
        nonce: 3,
        to: RECIPIENT,
        value: 0n,
        data: '0x',
        gas: 100_000n,
        maxFeePerGas: 2_000_000_000n,
        maxPriorityFeePerGas: 1_000_000n,
        ...fields,
      }).slice(2),
      'hex',
    );
  }

  const evaluate = (raw: Record<string, unknown>, tx: Uint8Array) =>
    evaluatePolicy(policy('secp256k1', raw), 'secp256k1', tx);

  const nativePayment = unsigned({ to: RECIPIENT, value: 1_000n });
  const tokenPayment = unsigned({ to: TOKEN, data: transfer(RECIPIENT, 500n) });
  const bulkPayments = unsigned({
    to: AGGREGATOR,
    value: 300n,
    data: bulk([
      { to: RECIPIENT, value: 100n, data: '0x' },
      { to: OTHER, value: 200n, data: '0x' },
      { to: TOKEN, value: 0n, data: transfer(RECIPIENT, 40n) },
      { to: TOKEN, value: 0n, data: transfer(OTHER, 60n) },
    ]),
  });

  it.each([
    ['a native Payment', nativePayment],
    ['an ERC-20 Payment', tokenPayment],
    ['a Bulk Call of native and ERC-20 Payments', bulkPayments],
  ])('signs %s the engine sends when the policy allows exactly what it does', (_, tx) => {
    const allowed = evaluate(
      {
        chainIds: [84532],
        allowedDestinations: [RECIPIENT, OTHER, TOKEN, AGGREGATOR],
        maxNativePerTransaction: '1000',
        maxTokenPerTransaction: { [TOKEN]: '500' },
      },
      tx,
    );
    expect(allowed).toEqual({ ok: true });
  });

  it('chainIds refuses another chain', () => {
    expect(evaluate({ chainIds: [8453] }, nativePayment)).toEqual({
      ok: false,
      reason: 'chain id 84532 is not in chainIds',
    });
  });

  it('allowedDestinations compares case-insensitively and refuses an unlisted `to`', () => {
    expect(
      evaluate(
        { allowedDestinations: [RECIPIENT.toUpperCase().replace('0X', '0x')] },
        nativePayment,
      ),
    ).toEqual({ ok: true });
    expect(evaluate({ allowedDestinations: [OTHER] }, nativePayment)).toEqual({
      ok: false,
      reason: `destination ${RECIPIENT.toLowerCase()} is not in allowedDestinations`,
    });
  });

  it('allowedDestinations refuses an unlisted target nested in aggregate3Value', () => {
    expect(evaluate({ allowedDestinations: [AGGREGATOR, RECIPIENT, TOKEN] }, bulkPayments)).toEqual(
      { ok: false, reason: `destination ${OTHER} is not in allowedDestinations` },
    );
  });

  it('allowedDestinations refuses a contract creation', () => {
    const creation = unsigned({ to: null, data: '0x6000' });
    expect(evaluate({ allowedDestinations: [RECIPIENT] }, creation)).toEqual({
      ok: false,
      reason: 'a contract creation has no allowed destination',
    });
  });

  it('maxNativePerTransaction refuses a value over the cap', () => {
    expect(evaluate({ maxNativePerTransaction: '999' }, nativePayment)).toEqual({
      ok: false,
      reason: 'native 1000 exceeds maxNativePerTransaction 999',
    });
  });

  it('maxNativePerTransaction counts a Bulk Call once, not its value plus the values it forwards', () => {
    expect(evaluate({ maxNativePerTransaction: '300' }, bulkPayments)).toEqual({ ok: true });
    expect(evaluate({ maxNativePerTransaction: '299' }, bulkPayments)).toEqual({
      ok: false,
      reason: 'native 300 exceeds maxNativePerTransaction 299',
    });
  });

  it('maxNativePerTransaction counts the forwarded values when an aggregator is sent less than it forwards', () => {
    const underfunded = unsigned({
      to: AGGREGATOR,
      value: 0n,
      data: bulk([{ to: RECIPIENT, value: 5_000n, data: '0x' }]),
    });
    expect(evaluate({ maxNativePerTransaction: '1000' }, underfunded)).toEqual({
      ok: false,
      reason: 'native 5000 exceeds maxNativePerTransaction 1000',
    });
  });

  it('maxTokenPerTransaction refuses a transfer over the cap', () => {
    expect(evaluate({ maxTokenPerTransaction: { [TOKEN]: '499' } }, tokenPayment)).toEqual({
      ok: false,
      reason: `token ${TOKEN.toLowerCase()} amount 500 exceeds maxTokenPerTransaction 499`,
    });
  });

  it('maxTokenPerTransaction sums the transfers nested in aggregate3Value', () => {
    expect(evaluate({ maxTokenPerTransaction: { [TOKEN]: '100' } }, bulkPayments)).toEqual({
      ok: true,
    });
    expect(evaluate({ maxTokenPerTransaction: { [TOKEN]: '99' } }, bulkPayments)).toEqual({
      ok: false,
      reason: `token ${TOKEN.toLowerCase()} amount 100 exceeds maxTokenPerTransaction 99`,
    });
  });

  it.each([
    [
      'approve',
      encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [OTHER, 1n] }),
      'call 0x095ea7b3',
    ],
    [
      'transferFrom',
      encodeFunctionData({
        abi: erc20Abi,
        functionName: 'transferFrom',
        args: [RECIPIENT, OTHER, 1n],
      }),
      'call 0x23b872dd',
    ],
  ])(
    'maxTokenPerTransaction refuses %s on a capped token, at the top level and nested',
    (_, data, what) => {
      const reason = `${what} to token ${TOKEN.toLowerCase()} can't be counted against maxTokenPerTransaction`;
      const caps = { maxTokenPerTransaction: { [TOKEN]: '1000' } };
      expect(evaluate(caps, unsigned({ to: TOKEN, data }))).toEqual({ ok: false, reason });
      expect(
        evaluate(caps, unsigned({ to: AGGREGATOR, data: bulk([{ to: TOKEN, value: 0n, data }]) })),
      ).toEqual({ ok: false, reason });
    },
  );

  it('maxTokenPerTransaction ignores tokens it does not cap', () => {
    const approveOther = unsigned({
      to: OTHER,
      data: encodeFunctionData({ abi: erc20Abi, functionName: 'approve', args: [RECIPIENT, 1n] }),
    });
    expect(evaluate({ maxTokenPerTransaction: { [TOKEN]: '1' } }, approveOther)).toEqual({
      ok: true,
    });
  });

  it.each([
    ['bytes that are no transaction', Uint8Array.from([0x02, 0xff, 0x00])],
    [
      'an aggregate3Value whose calldata does not decode',
      unsigned({ to: AGGREGATOR, data: '0x174dea710000' }),
    ],
    ['a truncated ERC-20 transfer', unsigned({ to: TOKEN, data: '0xa9059cbb0000' })],
  ])('refuses %s as undecodable', (_, tx) => {
    const decision = evaluate({}, tx);
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toMatch(/^undecodable transaction: /);
  });
});

describe('Solana policy', () => {
  const sender = Keypair.generate().publicKey;
  const recipient = Keypair.generate().publicKey;
  const mint = Keypair.generate().publicKey;
  const MEMO = new PublicKey('MemoSq4gqABAXKb96qnH8TuNyNpdXxkHrWzBKjN2YmX');
  const blockhash = Keypair.generate().publicKey.toBase58();

  /** As the Solana handler's sign() builds the message it sends the Signer. */
  function legacy(...instructions: TransactionInstruction[]): Uint8Array {
    return new Transaction({ feePayer: sender, blockhash, lastValidBlockHeight: 0 })
      .add(...instructions)
      .compileMessage()
      .serialize();
  }

  function v0(
    instructions: TransactionInstruction[],
    lookupAddresses: PublicKey[] = [],
  ): Uint8Array {
    const table = new AddressLookupTableAccount({
      key: Keypair.generate().publicKey,
      state: {
        deactivationSlot: 2n ** 64n - 1n,
        lastExtendedSlot: 0,
        lastExtendedSlotStartIndex: 0,
        addresses: lookupAddresses,
      },
    });
    return new TransactionMessage({ payerKey: sender, recentBlockhash: blockhash, instructions })
      .compileToV0Message(lookupAddresses.length > 0 ? [table] : [])
      .serialize();
  }

  function splTransfer(amount: bigint, programId = TOKEN_PROGRAM_ID): TransactionInstruction[] {
    const source = getAssociatedTokenAddressSync(mint, sender, false, programId);
    const destination = getAssociatedTokenAddressSync(mint, recipient, false, programId);
    return [
      createAssociatedTokenAccountIdempotentInstruction(
        sender,
        destination,
        recipient,
        mint,
        programId,
      ),
      createTransferCheckedInstruction(source, mint, destination, sender, amount, 6, [], programId),
    ];
  }

  const solTransfer = (lamports: bigint) =>
    SystemProgram.transfer({ fromPubkey: sender, toPubkey: recipient, lamports });

  const memo = new TransactionInstruction({ programId: MEMO, keys: [], data: Buffer.from('hi') });

  const evaluate = (raw: Record<string, unknown>, message: Uint8Array) =>
    evaluatePolicy(policy('ed25519', raw), 'ed25519', message);

  const priorityFee = [
    ComputeBudgetProgram.setComputeUnitLimit({ units: 200_000 }),
    ComputeBudgetProgram.setComputeUnitPrice({ microLamports: 1_000 }),
  ];
  const enginePayments = legacy(
    ...priorityFee,
    solTransfer(700n),
    ...splTransfer(250n),
    solTransfer(300n),
  );

  it('signs the engine’s bundled SOL and SPL Payments under a policy listing no extra program', () => {
    const decision = evaluate(
      {
        allowedDestinations: [],
        maxNativePerTransaction: '1000',
        maxTokenPerTransaction: { [mint.toBase58()]: '250' },
      },
      enginePayments,
    );
    expect(decision).toEqual({ ok: true });
  });

  it('allowedDestinations refuses a program outside the default set, and allows it once listed', () => {
    const withMemo = legacy(solTransfer(1n), memo);
    expect(evaluate({ allowedDestinations: [] }, withMemo)).toEqual({
      ok: false,
      reason: `destination ${MEMO.toBase58()} is not in allowedDestinations`,
    });
    expect(evaluate({ allowedDestinations: [MEMO.toBase58()] }, withMemo)).toEqual({ ok: true });
  });

  it('maxNativePerTransaction sums every System transfer', () => {
    expect(evaluate({ maxNativePerTransaction: '999' }, enginePayments)).toEqual({
      ok: false,
      reason: 'native 1000 exceeds maxNativePerTransaction 999',
    });
  });

  it.each([
    [
      'CreateAccount',
      SystemProgram.createAccount({
        fromPubkey: sender,
        newAccountPubkey: recipient,
        lamports: 4_000,
        space: 0,
        programId: SystemProgram.programId,
      }),
    ],
    [
      'CreateAccountWithSeed',
      SystemProgram.createAccountWithSeed({
        fromPubkey: sender,
        newAccountPubkey: recipient,
        basePubkey: sender,
        seed: 'a seed of some length',
        lamports: 4_000,
        space: 0,
        programId: SystemProgram.programId,
      }),
    ],
    [
      'TransferWithSeed',
      SystemProgram.transfer({
        fromPubkey: recipient,
        basePubkey: sender,
        toPubkey: mint,
        lamports: 4_000,
        seed: 'seed',
        programId: SystemProgram.programId,
      }),
    ],
    [
      'WithdrawNonceAccount',
      SystemProgram.nonceWithdraw({
        noncePubkey: recipient,
        authorizedPubkey: sender,
        toPubkey: mint,
        lamports: 4_000,
      }),
    ],
  ])('maxNativePerTransaction counts %s', (_, instruction) => {
    expect(evaluate({ maxNativePerTransaction: '3999' }, legacy(instruction))).toEqual({
      ok: false,
      reason: 'native 4000 exceeds maxNativePerTransaction 3999',
    });
    expect(evaluate({ maxNativePerTransaction: '4000' }, legacy(instruction))).toEqual({
      ok: true,
    });
  });

  it('maxNativePerTransaction allows System instructions that move no lamports', () => {
    const assign = SystemProgram.assign({ accountPubkey: sender, programId: MEMO });
    const allocate = SystemProgram.allocate({ accountPubkey: sender, space: NONCE_ACCOUNT_LENGTH });
    expect(evaluate({ maxNativePerTransaction: '0' }, legacy(assign, allocate))).toEqual({
      ok: true,
    });
  });

  it('maxTokenPerTransaction refuses a TransferChecked over the cap, for Token and Token-2022', () => {
    for (const programId of [TOKEN_PROGRAM_ID, TOKEN_2022_PROGRAM_ID]) {
      expect(
        evaluate(
          { maxTokenPerTransaction: { [mint.toBase58()]: '249' } },
          legacy(...splTransfer(250n, programId)),
        ),
      ).toEqual({
        ok: false,
        reason: `token ${mint.toBase58()} amount 250 exceeds maxTokenPerTransaction 249`,
      });
    }
  });

  it('maxTokenPerTransaction sums TransferChecked by mint across the message', () => {
    const twice = legacy(...splTransfer(250n), ...splTransfer(250n));
    expect(evaluate({ maxTokenPerTransaction: { [mint.toBase58()]: '499' } }, twice)).toEqual({
      ok: false,
      reason: `token ${mint.toBase58()} amount 500 exceeds maxTokenPerTransaction 499`,
    });
  });

  it.each([
    ['Approve', createApproveInstruction(sender, recipient, sender, 1n), 'Token instruction 4'],
    [
      'a Transfer without its mint',
      createTransferInstruction(sender, recipient, sender, 1n),
      'Token instruction 3',
    ],
  ])('maxTokenPerTransaction refuses %s, which it could not count', (_, instruction, what) => {
    const message = legacy(instruction);
    expect(evaluate({ maxTokenPerTransaction: { [mint.toBase58()]: '1000' } }, message)).toEqual({
      ok: false,
      reason: `${what} can't be counted against maxTokenPerTransaction`,
    });
    expect(evaluate({ maxNativePerTransaction: '0' }, message)).toEqual({ ok: true });
  });

  it('reads v0 messages: a statically keyed mint is counted', () => {
    const message = v0([...priorityFee, ...splTransfer(250n), solTransfer(10n)]);
    expect(
      evaluate(
        { maxNativePerTransaction: '10', maxTokenPerTransaction: { [mint.toBase58()]: '249' } },
        message,
      ),
    ).toEqual({
      ok: false,
      reason: `token ${mint.toBase58()} amount 250 exceeds maxTokenPerTransaction 249`,
    });
  });

  it('refuses a TransferChecked whose mint comes from a lookup table only when a token cap is set', () => {
    const message = v0([splTransfer(250n)[1]!], [mint]);
    expect(evaluate({ maxTokenPerTransaction: { [mint.toBase58()]: '1000' } }, message)).toEqual({
      ok: false,
      reason:
        "a TransferChecked whose mint comes from an address lookup table can't be counted against maxTokenPerTransaction",
    });
    expect(evaluate({ allowedDestinations: [], maxNativePerTransaction: '0' }, message)).toEqual({
      ok: true,
    });
  });

  it.each([
    ['bytes that are no message', Uint8Array.from([1, 2, 3])],
    ['a message with a trailing byte', Uint8Array.from([...legacy(solTransfer(1n)), 0])],
    [
      'System data that does not parse',
      legacy(
        new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: [],
          data: Buffer.from([2, 0, 0, 0, 1]),
        }),
      ),
    ],
    [
      'an unknown System instruction',
      legacy(
        new TransactionInstruction({
          programId: SystemProgram.programId,
          keys: [],
          data: Buffer.from([99, 0, 0, 0]),
        }),
      ),
    ],
  ])('refuses %s as undecodable', (_, message) => {
    const decision = evaluate({}, message);
    expect(decision.ok).toBe(false);
    expect(!decision.ok && decision.reason).toMatch(/^undecodable transaction: /);
  });
});

describe('parsePolicy', () => {
  const EVM = '0x7499BC37AcA4f0F4a7A982Afdfea340AfDd74e6A';

  it('accepts an empty policy: no rules', () => {
    expect(parsePolicy('secp256k1', {})).toEqual({});
  });

  it('names every problem: unknown rule, bad chain ids, bad address, bad amounts', () => {
    expect(
      parsePolicy('secp256k1', {
        maxNativePerTx: '1',
        chainIds: [84532, -1],
        allowedDestinations: [EVM, '0xnope'],
        maxNativePerTransaction: 1000,
        maxTokenPerTransaction: { notAnAddress: '1', [EVM]: '1.5' },
      }),
    ).toEqual([
      'policy has an unknown rule "maxNativePerTx"',
      'policy.chainIds must be an array of positive integers',
      'policy.allowedDestinations has a bad address "0xnope"',
      'policy.maxNativePerTransaction must be a decimal string of base units, got 1000',
      'policy.maxTokenPerTransaction has a bad token address "notAnAddress"',
      `policy.maxTokenPerTransaction.${EVM} must be a decimal string of base units, got "1.5"`,
    ]);
  });

  it('refuses chainIds on an ed25519 address, and an EVM address as a Solana program', () => {
    expect(parsePolicy('ed25519', { chainIds: [1], allowedDestinations: [EVM] })).toEqual([
      'policy.chainIds applies only to secp256k1 (EVM) addresses',
      `policy.allowedDestinations has a bad address "${EVM}"`,
    ]);
  });
});
