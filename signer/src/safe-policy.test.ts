import {
  encodeFunctionData,
  parseAbi,
  serializeTransaction,
  type Address,
  type Hex,
  type TransactionSerializableEIP1559,
} from 'viem';
import { describe, expect, it } from 'vitest';

import {
  evaluatePolicy,
  evaluateSafeTransactionPolicy,
  parsePolicy,
  type Policy,
} from './policy.js';
import { EXEC_TRANSACTION_SELECTOR, parseSafeTransaction } from './safe-transaction.js';
import vectors from './safe-vectors.json' with { type: 'json' };

const SAFE: Address = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const OTHER_SAFE: Address = '0xD784eeEA715626931bAb54b90b4d9cDE61d8DD97';
const MULTISEND_141: Address = '0x9641d764fc13c8B624c04430C7356C1C7C8102e2';
const MULTISEND_130: Address = '0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B';
const MULTISEND_130_CANONICAL: Address = '0x40A2aCCbd92BCA938b02010E17A5b8929b49130D';
const ZERO: Address = '0x0000000000000000000000000000000000000000';
const ELSEWHERE: Address = '0x1111111111111111111111111111111111111111';

const EXEC_ABI = parseAbi([
  'function execTransaction(address to, uint256 value, bytes data, uint8 operation, uint256 safeTxGas, uint256 baseGas, uint256 gasPrice, address gasToken, address refundReceiver, bytes signatures)',
]);

type Exec = {
  to: Address;
  value: bigint;
  data: Hex;
  operation: number;
  safeTxGas: bigint;
  baseGas: bigint;
  gasPrice: bigint;
  gasToken: Address;
  refundReceiver: Address;
};

const goodExec: Exec = {
  to: MULTISEND_141,
  value: 0n,
  data: '0x8d80ff0a',
  operation: 1,
  safeTxGas: 0n,
  baseGas: 0n,
  gasPrice: 0n,
  gasToken: ZERO,
  refundReceiver: ZERO,
};

function execCalldata(overrides: Partial<Exec> = {}): Hex {
  const f = { ...goodExec, ...overrides };
  return encodeFunctionData({
    abi: EXEC_ABI,
    functionName: 'execTransaction',
    args: [
      f.to,
      f.value,
      f.data,
      f.operation,
      f.safeTxGas,
      f.baseGas,
      f.gasPrice,
      f.gasToken,
      f.refundReceiver,
      '0x',
    ],
  });
}

/** As the Base handler serializes the executor's transaction. */
function unsigned(fields: Partial<TransactionSerializableEIP1559> = {}): Uint8Array {
  return Buffer.from(
    serializeTransaction({
      type: 'eip1559',
      chainId: 84532,
      nonce: 3,
      to: SAFE,
      value: 0n,
      data: execCalldata(),
      gas: 300_000n,
      maxFeePerGas: 2_000_000_000n,
      maxPriorityFeePerGas: 1_000_000n,
      ...fields,
    }).slice(2),
    'hex',
  );
}

function policy(raw: Record<string, unknown>): Policy {
  const parsed = parsePolicy('secp256k1', raw);
  if (Array.isArray(parsed)) throw new Error(parsed.join('; '));
  return parsed;
}

const pinned = policy({ chainIds: [84532], allowedSafe: SAFE });
const evaluate = (tx: Uint8Array, p: Policy = pinned) => evaluatePolicy(p, 'secp256k1', tx);
const refusal = (reason: string | RegExp) => ({
  ok: false,
  reason: typeof reason === 'string' ? reason : (expect.stringMatching(reason) as string),
});

describe('allowedSafe: the executor’s execTransaction', () => {
  it('has the selector the engine sends', () => {
    expect(execCalldata().slice(0, 10)).toBe(EXEC_TRANSACTION_SELECTOR);
  });

  it.each([
    ['1.4.1', MULTISEND_141],
    ['1.3.0 eip155', MULTISEND_130],
    ['1.3.0 canonical', MULTISEND_130_CANONICAL],
  ])('signs an execTransaction delegatecalling the %s MultiSendCallOnly', (_, to) => {
    expect(evaluate(unsigned({ data: execCalldata({ to }) }))).toEqual({ ok: true });
  });

  it('matches the Safe address whatever its case', () => {
    expect(evaluate(unsigned({ to: SAFE.toLowerCase() as Address }))).toEqual({ ok: true });
  });

  it('refuses another Safe', () => {
    expect(evaluate(unsigned({ to: OTHER_SAFE }))).toEqual(
      refusal(`destination ${OTHER_SAFE.toLowerCase()} is not the allowedSafe`),
    );
  });

  it('refuses a plain value transfer to the Safe', () => {
    expect(evaluate(unsigned({ value: 5n, data: '0x' }))).toEqual(
      refusal('call (none) is not execTransaction'),
    );
  });

  it('refuses a plain value transfer elsewhere', () => {
    expect(evaluate(unsigned({ to: ELSEWHERE, value: 5n, data: '0x' }))).toEqual(
      refusal(/is not the allowedSafe/),
    );
  });

  it('refuses another selector on the Safe', () => {
    expect(evaluate(unsigned({ data: '0xa9059cbb' }))).toEqual(
      refusal('call 0xa9059cbb is not execTransaction'),
    );
  });

  it('refuses a CALL operation', () => {
    expect(evaluate(unsigned({ data: execCalldata({ operation: 0, to: ELSEWHERE }) }))).toEqual(
      refusal(/is a call; only a delegatecall/),
    );
  });

  it('refuses a delegatecall to anything but an allowed MultiSendCallOnly', () => {
    expect(evaluate(unsigned({ data: execCalldata({ to: ELSEWHERE }) }))).toEqual(
      refusal(
        `the Safe transaction delegatecalls ${ELSEWHERE}, which is not an allowed MultiSendCallOnly`,
      ),
    );
  });

  it.each([
    ['safeTxGas', { safeTxGas: 1n }],
    ['baseGas', { baseGas: 1n }],
    ['gasPrice', { gasPrice: 1n }],
  ])('refuses a non-zero %s', (field, change) => {
    expect(evaluate(unsigned({ data: execCalldata(change) }))).toEqual(
      refusal(`the Safe transaction's ${field} is not zero`),
    );
  });

  it.each([
    ['gasToken', { gasToken: ELSEWHERE }],
    ['refundReceiver', { refundReceiver: ELSEWHERE }],
  ])('refuses a non-zero %s', (field, change) => {
    expect(evaluate(unsigned({ data: execCalldata(change) }))).toEqual(
      refusal(`the Safe transaction's ${field} is not the zero address`),
    );
  });

  it('refuses another chain id', () => {
    expect(evaluate(unsigned({ chainId: 8453 }))).toEqual(
      refusal('chain id 8453 is not in chainIds'),
    );
  });

  it('refuses a malformed execTransaction payload', () => {
    expect(evaluate(unsigned({ data: execCalldata().slice(0, 200) as Hex }))).toEqual(
      refusal(/^undecodable transaction: execTransaction calldata/),
    );
  });

  it('refuses calldata with bytes the ABI does not account for', () => {
    expect(evaluate(unsigned({ data: `${execCalldata()}00` as Hex }))).toEqual(
      refusal(/not canonically encoded/),
    );
  });

  it('refuses an operation other than 0 or 1', () => {
    expect(evaluate(unsigned({ data: execCalldata({ operation: 2 }) }))).toEqual(
      refusal(/operation 2 is not 0 or 1/),
    );
  });

  it('refuses a legacy transaction, a contract creation and unreadable bytes', () => {
    const legacy = Buffer.from(
      serializeTransaction({
        chainId: 84532,
        nonce: 0,
        to: SAFE,
        data: execCalldata(),
        gas: 1n,
        gasPrice: 1n,
      }).slice(2),
      'hex',
    );
    expect(evaluate(legacy)).toEqual(refusal(/signs only EIP-1559 transactions/));
    expect(evaluate(unsigned({ to: undefined }))).toEqual(refusal(/is not the allowedSafe/));
    expect(evaluate(Uint8Array.from([1, 2, 3]))).toEqual(refusal(/^undecodable transaction/));
  });

  it('honours a configured MultiSend allowlist in place of the defaults', () => {
    const custom = policy({ chainIds: [84532], allowedSafe: SAFE, allowedMultiSend: [ELSEWHERE] });

    expect(evaluate(unsigned({ data: execCalldata({ to: ELSEWHERE }) }), custom)).toEqual({
      ok: true,
    });
    expect(evaluate(unsigned(), custom)).toEqual(refusal(/not an allowed MultiSendCallOnly/));
  });

  it('still applies the other rules of the policy', () => {
    const narrow = policy({
      chainIds: [84532],
      allowedSafe: SAFE,
      allowedDestinations: [OTHER_SAFE],
    });

    expect(evaluate(unsigned(), narrow)).toEqual(refusal(/is not in allowedDestinations/));
  });
});

describe('allowedSafe: the safeTransaction typed data', () => {
  const plainTransfer = vectors[0]?.tx;
  const delegatecall = vectors[1]?.tx;
  const nonzeroGas = vectors[2]?.tx;
  const otherSafeDelegatecall = vectors[4]?.tx;
  const parse = (raw: unknown) => {
    const parsed = parseSafeTransaction(raw);
    if (typeof parsed === 'string') throw new Error(parsed);
    return parsed;
  };
  const check = (raw: unknown, p: Policy = pinned) => evaluateSafeTransactionPolicy(p, parse(raw));

  it('passes the pinned Safe’s MultiSend delegatecall, on 1.4.1 and 1.3.0 alike', () => {
    expect(check(delegatecall)).toEqual({ ok: true });
    expect(
      check(otherSafeDelegatecall, policy({ chainIds: [84532], allowedSafe: OTHER_SAFE })),
    ).toEqual({ ok: true });
  });

  it('refuses another Safe', () => {
    expect(check(otherSafeDelegatecall)).toEqual(refusal(/is not the allowedSafe/));
  });

  it('refuses another chain id', () => {
    expect(check({ ...delegatecall, chainId: 8453 })).toEqual(
      refusal('chain id 8453 is not in chainIds'),
    );
  });

  it('refuses a CALL (the plain transfer vector)', () => {
    expect(check(plainTransfer)).toEqual(refusal(/is a call; only a delegatecall/));
  });

  it('refuses non-zero gas and refund fields', () => {
    expect(check({ ...nonzeroGas, operation: 1, to: MULTISEND_141 })).toEqual(
      refusal(`the Safe transaction's safeTxGas is not zero`),
    );
    expect(check({ ...delegatecall, refundReceiver: ELSEWHERE })).toEqual(
      refusal(`the Safe transaction's refundReceiver is not the zero address`),
    );
    expect(check({ ...delegatecall, gasToken: ELSEWHERE })).toEqual(
      refusal(`the Safe transaction's gasToken is not the zero address`),
    );
  });

  it('refuses a delegatecall to another contract', () => {
    expect(check({ ...delegatecall, to: ELSEWHERE })).toEqual(
      refusal(/not an allowed MultiSendCallOnly/),
    );
  });

  it('still refuses every Safe transaction when the policy has no allowedSafe (ADR-0052)', () => {
    expect(check(delegatecall, policy({ chainIds: [84532] }))).toEqual(
      refusal('the policy has no allowedSafe, so it does not sign Safe transactions'),
    );
  });
});

describe('parsePolicy: allowedSafe', () => {
  it('defaults the MultiSend allowlist to the three canonical addresses, lowercase', () => {
    expect(policy({ chainIds: [1], allowedSafe: SAFE })).toMatchObject({
      allowedSafe: SAFE.toLowerCase(),
      allowedMultiSend: new Set([
        MULTISEND_141.toLowerCase(),
        MULTISEND_130.toLowerCase(),
        MULTISEND_130_CANONICAL.toLowerCase(),
      ]),
    });
  });

  it('rejects it on an ed25519 address', () => {
    expect(parsePolicy('ed25519', { allowedSafe: SAFE })).toEqual([
      'policy.allowedSafe applies only to secp256k1 (EVM) addresses',
    ]);
  });

  it.each([['0xnope'], [42], [null]])('rejects a malformed address %j', (bad) => {
    expect(parsePolicy('secp256k1', { chainIds: [1], allowedSafe: bad })).toEqual([
      `policy.allowedSafe must be an EVM address, got ${JSON.stringify(bad)}`,
    ]);
  });

  it('requires chainIds, since a Safe address names no chain', () => {
    expect(parsePolicy('secp256k1', { allowedSafe: SAFE })).toEqual([
      'policy.allowedSafe requires policy.chainIds',
    ]);
  });

  it('validates allowedMultiSend, and only alongside allowedSafe', () => {
    expect(
      parsePolicy('secp256k1', { chainIds: [1], allowedSafe: SAFE, allowedMultiSend: ['0xnope'] }),
    ).toEqual(['policy.allowedMultiSend has a bad address "0xnope"']);
    expect(
      parsePolicy('secp256k1', { chainIds: [1], allowedSafe: SAFE, allowedMultiSend: [] }),
    ).toEqual(['policy.allowedMultiSend must be a non-empty array of addresses']);
    expect(parsePolicy('secp256k1', { allowedMultiSend: [ELSEWHERE] })).toEqual([
      'policy.allowedMultiSend applies only with policy.allowedSafe',
    ]);
  });

  it('leaves a policy without allowedSafe as it was', () => {
    expect(parsePolicy('secp256k1', { chainIds: [1] })).toEqual({ chainIds: new Set([1]) });
  });
});
