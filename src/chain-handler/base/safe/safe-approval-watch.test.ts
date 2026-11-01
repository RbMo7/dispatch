import { decodeFunctionData, serializeTransaction, size, type Hex } from 'viem';
import { afterEach, describe, expect, it, vi } from 'vitest';

import type { DispatchError } from '../../../domain/errors.js';
import type { Proposal } from '../../../domain/proposal.js';
import { err, ok, type Result } from '../../../domain/result.js';
import type { BuiltProposal, PreparedTransaction } from '../../chain-handler.js';
import {
  RETURNS_FALSE,
  SAFE,
  atNoncePath,
  byHashPath,
  ecdsaSignature,
  ethSignSignature,
  executionSuccessReceipt,
  executor,
  fakeNode,
  outsider,
  owners,
  ownerKeys,
  ownersAscending,
  serviceTransaction,
  startFakeService,
  type FakeNodeState,
  type FakeService,
} from '../../test-support/fake-safe.js';
import { encodeUnsignedTransaction, decodeUnsignedTransaction } from '../transaction-codec.js';
import {
  EXEC_TRANSACTION_ABI,
  GAS_FIXED,
  GAS_PER_ITEM,
  GAS_PER_SIGNATURE,
  GAS_PRICE_ORACLE,
  L1_FEE_MULTIPLIER,
  withGasMargin,
} from './execution-cost.js';
import { MULTI_SEND_CALL_ONLY, SafeApproval } from './safe-approval.js';
import type { BaseSafeConfig } from './safe-config.js';
import { SafeTxServiceClient } from './tx-service-client.js';
import { registryFromConfig } from '../../../asset-registry/configured-assets.js';

const USDC = '0x036CbD53842c5426634e7929541eC2318f3dCF7e';
const A = '0x1111111111111111111111111111111111111111';
const B = '0x2222222222222222222222222222222222222222';
const API_KEY = 'sk_live_super_secret_key';
const HASH_X: Hex = `0x${'ab'.repeat(32)}`;
const EXEC_HASH: Hex = `0x${'cd'.repeat(32)}`;

const native = (to: string, value: string) => ({ to, value, data: '0x' });
const usdc = (to: string, amount: bigint) => ({
  to: USDC,
  value: '0',
  data: `0xa9059cbb${to.slice(2).toLowerCase().padStart(64, '0')}${amount.toString(16).padStart(64, '0')}`,
});

let services: FakeService[] = [];
afterEach(async () => {
  await Promise.all(services.map((s) => s.close()));
  services = [];
});

function expectOk<T>(result: Result<T, DispatchError>): T {
  if (!result.ok) throw new Error(`expected ok, got ${JSON.stringify(result.error)}`);
  return result.value;
}

function expectErr<T>(result: Result<T, DispatchError>): DispatchError {
  if (result.ok) throw new Error(`expected an error, got ${JSON.stringify(result.value)}`);
  return result.error;
}

/** The unsigned transaction the Base handler's `prepare` would answer for one call to `to`. */
function preparedFor(items: { to: string; value: string; data: string }[]): PreparedTransaction[] {
  return items.map((item, callIndex) => ({
    callIndex,
    unsignedTransaction: encodeUnsignedTransaction({
      senderAddress: executor.address,
      chainId: 84532,
      nonce: null,
      to: item.to as Hex,
      value: item.value,
      data: item.data as Hex,
      gas: '500000',
      maxFeePerGas: '2000000',
      maxPriorityFeePerGas: '1000000',
      preparedId: 'prepared-1',
    }),
  }));
}

async function setup(
  options: {
    node?: Partial<FakeNodeState>;
    calls?: { to: string; value: string; data: string }[];
    bundleLimit?: number;
    prepare?: (
      items: { to: string; value: string; data: string }[],
      sender: string,
    ) => Promise<Result<PreparedTransaction[], DispatchError>>;
  } = {},
) {
  const service = await startFakeService();
  services.push(service);
  const node = fakeNode(options.node);
  const config: BaseSafeConfig = {
    safeAddress: SAFE,
    executorAddress: executor.address,
    txServiceUrl: service.url,
    apiKey: API_KEY,
    approvalDeadlineMs: 1,
    approvalRewatchWindowMs: 1,
    bundleLimit: options.bundleLimit ?? 50,
  };
  const prepare = vi.fn<NonNullable<typeof options.prepare>>(
    options.prepare ?? ((items) => Promise.resolve(ok(preparedFor(items)))),
  );
  const subject = new SafeApproval({
    config,
    chainId: 84532,
    client: node.client,
    signer: { signSafeTransaction: () => Promise.reject(new Error('never signs here')) },
    service: new SafeTxServiceClient({ baseUrl: service.url, apiKey: API_KEY }),
    assets: registryFromConfig({ base: `USDC:${USDC}:${6}` }).forChain('base'),
    prepare,
    staleReadRetryDelayMs: 0,
  });
  const built: BuiltProposal = expectOk(
    await subject.buildProposal({
      calls: options.calls ?? [native(A, '5'), usdc(B, 7n)],
      sender: SAFE,
    }),
  );
  if (built.chainRef.kind !== 'safe') throw new Error('not a Safe proposal');
  const ref = built.chainRef;
  const hash = built.proposalRef as Hex;
  const proposal = { chainRef: ref, payload: built.payload, proposalRef: hash } as Proposal;
  const respond = (body: ReturnType<typeof serviceTransaction> | null, status = 200) =>
    service.routes.set(byHashPath(hash), {
      status: body === null ? 404 : status,
      ...(body === null ? {} : { body }),
    });
  const confirm = async (indexes: number[], signatureType = 'EOA') =>
    Promise.all(
      indexes.map(async (i) => ({
        owner: owners[i]!.address,
        signature: await ecdsaSignature(ownerKeys[i]!, hash),
        signatureType,
      })),
    );
  return { service, node, subject, built, ref, hash, proposal, prepare, respond, confirm };
}

describe('readProposal', () => {
  it('is unknown, never active, for a proposal the service has never seen', async () => {
    const t = await setup();
    // No route for the proposal: the service answers 404, so it was never posted.
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'unknown',
      executable: false,
    });
  });

  it('is active with no confirmations, and reads threshold and approvals from the chain', async () => {
    const t = await setup();
    t.respond(serviceTransaction({ safeTxHash: t.hash, nonce: 12 }));
    expect(expectOk(await t.subject.readProposal(t.ref))).toEqual({
      status: 'active',
      approvals: 0,
      threshold: 2,
      approvers: owners.map((owner) => ({ address: owner.address, decision: 'pending' })),
      executable: false,
    });
  });

  it('lists every owner in on-chain order: a valid confirmation or approveHash is approved, anything else pending', async () => {
    const t = await setup();
    t.node.state.approved = new Set([owners[2]!.address.toLowerCase()]);
    t.respond(
      serviceTransaction({
        safeTxHash: t.hash,
        nonce: 12,
        confirmations: [
          ...(await t.confirm([0])),
          // Claimed for owner 1 but signed by an outsider: never counted as owner 1's approval.
          {
            owner: owners[1]!.address,
            signature: await ecdsaSignature(`0x${'f4'.padStart(64, '0')}`, t.hash),
          },
        ],
      }),
    );
    expect(expectOk(await t.subject.readProposal(t.ref)).approvers).toEqual([
      { address: owners[0]!.address, decision: 'approved' },
      { address: owners[1]!.address, decision: 'pending' },
      { address: owners[2]!.address, decision: 'approved' },
    ]);
  });

  it('is approved by ECDSA signatures alone, once the threshold is met', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0]) }),
    );
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'active',
      approvals: 1,
    });
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 2]) }),
    );
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'approved',
      approvals: 2,
      threshold: 2,
      executable: true,
    });
  });

  it('is approved by on-chain approveHash alone, without the service knowing', async () => {
    const t = await setup();
    t.node.state.approved = new Set([
      owners[0]!.address.toLowerCase(),
      owners[1]!.address.toLowerCase(),
    ]);
    t.respond(null); // the service has not indexed the proposal at all
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'approved',
      approvals: 2,
    });
  });

  it('counts a mix of ECDSA and approveHash, and an owner who did both once', async () => {
    const t = await setup();
    t.node.state.approved = new Set([
      owners[1]!.address.toLowerCase(),
      owners[0]!.address.toLowerCase(),
    ]);
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0]) }),
    );
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'approved',
      approvals: 2,
    });
  });

  it("ignores a non-owner's, the delegate's, a forged and a duplicated signature", async () => {
    const t = await setup();
    const real = await t.confirm([0]);
    const forged = {
      owner: owners[1]!.address,
      // Signed by owner 2's key but claimed for owner 1.
      signature: await ecdsaSignature(ownerKeys[2], t.hash),
      signatureType: 'EOA',
    };
    t.respond(
      serviceTransaction({
        safeTxHash: t.hash,
        nonce: 12,
        confirmations: [
          ...real,
          ...real,
          forged,
          {
            owner: outsider.address,
            signature: await ecdsaSignature(`0x${'f4'.padStart(64, '0')}`, t.hash),
          },
          {
            owner: executor.address,
            signature: await ecdsaSignature(`0x${'e1'.padStart(64, '0')}`, t.hash),
          },
          // Garbage that is not a signature at all.
          { owner: owners[2]!.address, signature: '0x1234' },
          // A contract-signature marker (v 0) is not an EOA signature.
          { owner: owners[2]!.address, signature: `0x${'00'.repeat(65)}` },
        ],
      }),
    );
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'active',
      approvals: 1,
    });
  });

  it('counts an eth_sign style signature (v 31 or 32) from an owner', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({
        safeTxHash: t.hash,
        nonce: 12,
        confirmations: [
          {
            owner: owners[0]!.address,
            signature: await ethSignSignature(ownerKeys[0], t.hash),
            signatureType: 'ETH_SIGN',
          },
          ...(await t.confirm([1])),
        ],
      }),
    );
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'approved',
      approvals: 2,
    });
  });

  it('honours an owner-set change: a confirmation from a removed owner no longer counts', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({ status: 'approved' });

    // Owner 1 is swapped out on-chain; the service still lists their confirmation.
    t.node.state.owners = [owners[0]!.address, owners[2]!.address, outsider.address];
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'active',
      approvals: 1,
    });
  });

  it('honours a threshold change on-chain, not the service', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    t.node.state.threshold = 3;
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'active',
      approvals: 2,
      threshold: 3,
    });
  });

  it('reports executed when the service says so, with the executing hash', async () => {
    const t = await setup();
    t.node.state.nonce = 13n;
    t.node.state.receipts.set(EXEC_HASH.toLowerCase(), executionSuccessReceipt(t.hash));
    t.respond(
      serviceTransaction({
        safeTxHash: t.hash,
        nonce: 12,
        isExecuted: true,
        transactionHash: EXEC_HASH,
      }),
    );
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'executed',
      executedHash: EXEC_HASH,
      executable: false,
    });
  });

  describe('the on-chain cross-check of an execution (#88)', () => {
    const executed = async () => {
      const t = await setup();
      t.node.state.nonce = 13n;
      t.respond(
        serviceTransaction({
          safeTxHash: t.hash,
          nonce: 12,
          isExecuted: true,
          transactionHash: EXEC_HASH,
        }),
      );
      return t;
    };

    it('settles nothing when the receipt cannot be read', async () => {
      const t = await executed();
      t.node.state.receipts.set(EXEC_HASH.toLowerCase(), new Error('node down'));
      const result = await t.subject.readProposal(t.ref);
      expect(result).toMatchObject({
        ok: false,
        error: { code: 'RPC_UNAVAILABLE', chainDetail: { reason: 'EXECUTION_NOT_VERIFIED' } },
      });
    });

    it('settles nothing when the receipt is not there yet', async () => {
      const t = await executed();
      expect(await t.subject.readProposal(t.ref)).toMatchObject({
        ok: false,
        error: { code: 'RPC_UNAVAILABLE' },
      });
    });

    it('settles nothing when the receipt has no ExecutionSuccess for this safeTxHash', async () => {
      const t = await executed();
      t.node.state.receipts.set(EXEC_HASH.toLowerCase(), executionSuccessReceipt(HASH_X));
      expect(await t.subject.readProposal(t.ref)).toMatchObject({
        ok: false,
        error: { code: 'RPC_UNAVAILABLE' },
      });
    });

    it('verifies an execution in the Safe 1.4.1 layout, where txHash is an indexed topic', async () => {
      const t = await executed();
      t.node.state.receipts.set(
        EXEC_HASH.toLowerCase(),
        executionSuccessReceipt(t.hash, undefined, 'indexed'),
      );
      expect(await t.subject.readProposal(t.ref)).toMatchObject({
        ok: true,
        value: { status: 'executed', executedHash: EXEC_HASH },
      });
    });

    it('verifies an execution in the Safe 1.3.0 layout, where txHash is in the data', async () => {
      const t = await executed();
      t.node.state.receipts.set(
        EXEC_HASH.toLowerCase(),
        executionSuccessReceipt(t.hash, undefined, 'legacy'),
      );
      expect(await t.subject.readProposal(t.ref)).toMatchObject({
        ok: true,
        value: { status: 'executed', executedHash: EXEC_HASH },
      });
    });

    it('settles nothing when an indexed ExecutionSuccess names another hash', async () => {
      const t = await executed();
      t.node.state.receipts.set(
        EXEC_HASH.toLowerCase(),
        executionSuccessReceipt(HASH_X, undefined, 'indexed'),
      );
      expect(await t.subject.readProposal(t.ref)).toMatchObject({ ok: false });
    });

    it('settles nothing when the matching event came from another contract', async () => {
      const t = await executed();
      t.node.state.receipts.set(
        EXEC_HASH.toLowerCase(),
        executionSuccessReceipt(t.hash, '0x2222222222222222222222222222222222222222'),
      );
      expect(await t.subject.readProposal(t.ref)).toMatchObject({ ok: false });
    });

    it('settles nothing when the transaction reverted', async () => {
      const t = await executed();
      t.node.state.receipts.set(EXEC_HASH.toLowerCase(), {
        ...executionSuccessReceipt(t.hash),
        status: 'reverted',
      });
      expect(await t.subject.readProposal(t.ref)).toMatchObject({ ok: false });
    });

    it('settles nothing when the service gives no transaction hash', async () => {
      const t = await setup();
      t.node.state.nonce = 13n;
      t.respond(serviceTransaction({ safeTxHash: t.hash, nonce: 12, isExecuted: true }));
      expect(await t.subject.readProposal(t.ref)).toMatchObject({ ok: false });
    });

    it('also checks the execution found by nonce when the by-hash record lags', async () => {
      const t = await setup();
      t.node.state.nonce = 13n;
      t.respond(serviceTransaction({ safeTxHash: t.hash, nonce: 12 }));
      t.service.routes.set(atNoncePath(12), {
        status: 200,
        body: { results: [{ safeTxHash: t.hash, isExecuted: true, transactionHash: EXEC_HASH }] },
      });
      expect(await t.subject.readProposal(t.ref)).toMatchObject({ ok: false });
      t.node.state.receipts.set(EXEC_HASH.toLowerCase(), executionSuccessReceipt(t.hash));
      expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
        status: 'executed',
        executedHash: EXEC_HASH,
      });
    });
  });

  it("does not take the engine's own execution for a rejection: the nonce moved and this very hash won", async () => {
    const t = await setup();
    t.node.state.nonce = 13n;
    t.node.state.receipts.set(EXEC_HASH.toLowerCase(), executionSuccessReceipt(t.hash));
    // The by-hash record lags; the transactions at nonce 12 show this proposal executed.
    t.respond(serviceTransaction({ safeTxHash: t.hash, nonce: 12 }));
    t.service.routes.set(atNoncePath(12), {
      status: 200,
      body: {
        results: [
          { safeTxHash: HASH_X, isExecuted: false, transactionHash: null },
          { safeTxHash: t.hash, isExecuted: true, transactionHash: EXEC_HASH },
        ],
      },
    });
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'executed',
      executedHash: EXEC_HASH,
    });
  });

  it.each([['a same-nonce self-call (a rejection)'], ['a different transaction (a replacement)']])(
    'is rejected when the nonce moved and %s executed instead',
    async () => {
      const t = await setup();
      t.node.state.nonce = 13n;
      t.respond(serviceTransaction({ safeTxHash: t.hash, nonce: 12 }));
      t.service.routes.set(atNoncePath(12), {
        status: 200,
        body: {
          results: [
            { safeTxHash: t.hash, isExecuted: false, transactionHash: null },
            { safeTxHash: HASH_X, isExecuted: true, transactionHash: EXEC_HASH },
          ],
        },
      });
      expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
        status: 'rejected',
        executable: false,
      });
    },
  );

  it('keeps watching, never approved or rejected, when the nonce moved but no winner is indexed yet', async () => {
    const t = await setup();
    t.node.state.nonce = 13n;
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    t.service.routes.set(atNoncePath(12), {
      status: 200,
      body: { results: [{ safeTxHash: t.hash, isExecuted: false, transactionHash: null }] },
    });
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({
      status: 'active',
      executable: false,
    });
  });

  it('is not approved when the Safe nonce is below the proposal (a lagging read)', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    t.node.state.nonce = 11n;
    expect(expectOk(await t.subject.readProposal(t.ref))).toMatchObject({ status: 'active' });
  });

  it('pins every Safe read to one block and re-reads a block older than one already seen', async () => {
    const t = await setup();
    t.respond(serviceTransaction({ safeTxHash: t.hash, nonce: 12 }));
    t.node.state.blocks = [950n];
    expectOk(await t.subject.readProposal(t.ref)); // highest block seen is now 950
    t.node.log.pinned.length = 0;
    // The node first answers from an older block, then catches up.
    t.node.state.blocks = [940n, 951n];
    expectOk(await t.subject.readProposal(t.ref));
    expect(new Set(t.node.log.pinned)).toEqual(new Set([951n]));
  });

  it('fails as RPC_UNAVAILABLE rather than trust a node that stays behind', async () => {
    const t = await setup();
    t.respond(serviceTransaction({ safeTxHash: t.hash, nonce: 12 }));
    t.node.state.blocks = [950n];
    expectOk(await t.subject.readProposal(t.ref));
    t.node.state.blocks = [940n];
    const error = expectErr(await t.subject.readProposal(t.ref));
    expect(error.code).toBe('RPC_UNAVAILABLE');
    expect(error.message).toMatch(/stale/);
  });

  it.each([429, 500, 502, 503])(
    'maps a %s from the service to RPC_UNAVAILABLE, never leaking the key',
    async (status) => {
      const t = await setup();
      t.service.routes.set(byHashPath(t.hash), { status, body: { detail: 'busy' } });
      const error = expectErr(await t.subject.readProposal(t.ref));
      expect(error.code).toBe('RPC_UNAVAILABLE');
      expect(JSON.stringify(error)).not.toContain(API_KEY);
    },
  );

  it('maps a refused API key to CHAIN_REJECTED', async () => {
    const t = await setup();
    t.service.routes.set(byHashPath(t.hash), { status: 401, body: { detail: 'bad key' } });
    const error = expectErr(await t.subject.readProposal(t.ref));
    expect(error.code).toBe('CHAIN_REJECTED');
    expect(JSON.stringify(error)).not.toContain(API_KEY);
  });

  it('maps an unreachable service and an unreachable node to RPC_UNAVAILABLE', async () => {
    const t = await setup();
    await t.service.close();
    expect(expectErr(await t.subject.readProposal(t.ref)).code).toBe('RPC_UNAVAILABLE');

    const u = await setup();
    u.node.client.getBlockNumber = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(expectErr(await u.subject.readProposal(u.ref)).code).toBe('RPC_UNAVAILABLE');
  });

  it("refuses another Safe's proposal and a Squads reference", async () => {
    const t = await setup();
    expect(
      expectErr(
        await t.subject.readProposal({
          ...t.ref,
          safe: '0x0000000000000000000000000000000000000009',
        }),
      ).code,
    ).toBe('CHAIN_REJECTED');
    expect(
      expectErr(
        await t.subject.readProposal({
          kind: 'squads',
          multisig: 'm',
          proposal: 'p',
          transactionIndex: 1,
        }),
      ).code,
    ).toBe('CHAIN_REJECTED');
  });

  it('sends the API key as a bearer header', async () => {
    const t = await setup();
    t.respond(serviceTransaction({ safeTxHash: t.hash, nonce: 12 }));
    await t.subject.readProposal(t.ref);
    expect(t.service.hits.at(-1)?.authorization).toBe(`Bearer ${API_KEY}`);
  });
});

describe('prepareExecution', () => {
  const sigsOf = (data: Hex): Hex => {
    const decoded = decodeFunctionData({ abi: EXEC_TRANSACTION_ABI, data });
    return decoded.args[9];
  };
  const pad32 = (address: string) => address.slice(2).toLowerCase().padStart(64, '0');

  it('packs ECDSA signatures sorted by ascending owner address, matching an independent computation', async () => {
    const t = await setup();
    // Confirm in descending order: the packing must still be ascending by owner address.
    const confirmations = await t.confirm([0, 1]);
    t.respond(
      serviceTransaction({
        safeTxHash: t.hash,
        nonce: 12,
        confirmations: [...confirmations].reverse(),
      }),
    );
    const prepared = expectOk(await t.subject.prepareExecution(t.proposal));

    const expected = (
      await Promise.all(
        [0, 1].map(async (i) => ({
          address: owners[i]!.address.toLowerCase(),
          signature: await ecdsaSignature(ownerKeys[i]!, t.hash),
        })),
      )
    )
      .sort((a, b) => (a.address < b.address ? -1 : 1))
      .map((e) => e.signature.slice(2))
      .join('');

    const encoded = decodeUnsignedTransaction(prepared.unsignedTransaction);
    expect(sigsOf(encoded.data)).toBe(`0x${expected}`);
    expect(size(sigsOf(encoded.data))).toBe(130);
  });

  it('encodes an approveHash entry as r = owner padded, s = 0, v = 1, in owner order beside ECDSA', async () => {
    const t = await setup();
    // Owner 0 signs; owner 1 approves on-chain.
    t.node.state.approved = new Set([owners[1]!.address.toLowerCase()]);
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0]) }),
    );
    const encoded = decodeUnsignedTransaction(
      expectOk(await t.subject.prepareExecution(t.proposal)).unsignedTransaction,
    );
    const ecdsa = (await ecdsaSignature(ownerKeys[0], t.hash)).slice(2);
    const approve = `${pad32(owners[1]!.address)}${'00'.repeat(32)}01`;
    const ordered =
      owners[0]!.address.toLowerCase() < owners[1]!.address.toLowerCase()
        ? `${ecdsa}${approve}`
        : `${approve}${ecdsa}`;
    expect(sigsOf(encoded.data)).toBe(`0x${ordered}`);
  });

  it('sends exactly threshold-many signatures even when more owners confirmed', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({
        safeTxHash: t.hash,
        nonce: 12,
        confirmations: await t.confirm([0, 1, 2]),
      }),
    );
    const encoded = decodeUnsignedTransaction(
      expectOk(await t.subject.prepareExecution(t.proposal)).unsignedTransaction,
    );
    expect(size(sigsOf(encoded.data))).toBe(2 * 65);
    // The lowest two addresses, in order.
    const lowest = ownersAscending.slice(0, 2).map((o) => o.address.toLowerCase());
    const signers = [0, 1, 2].map((i) => ({ i, a: owners[i]!.address.toLowerCase() }));
    const idx = lowest.map((a) => signers.find((s) => s.a === a)!.i);
    const expected = (await Promise.all(idx.map((i) => ecdsaSignature(ownerKeys[i]!, t.hash))))
      .map((s) => s.slice(2))
      .join('');
    expect(sigsOf(encoded.data)).toBe(`0x${expected}`);
  });

  it('builds execTransaction from the persisted payload, as one call to the Safe through prepare', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    const prepared = expectOk(await t.subject.prepareExecution(t.proposal));
    expect(t.prepare).toHaveBeenCalledTimes(1);
    const [items, sender] = t.prepare.mock.calls[0] as [
      { to: string; value: string; data: Hex }[],
      string,
    ];
    expect(sender).toBe(executor.address);
    expect(items).toHaveLength(1);
    expect(items[0]).toMatchObject({ to: SAFE, value: '0' });

    const decoded = decodeFunctionData({ abi: EXEC_TRANSACTION_ABI, data: items[0]!.data });
    const payload = JSON.parse(t.built.payload) as Record<string, string | number>;
    expect(decoded.args.slice(0, 9)).toEqual([
      MULTI_SEND_CALL_ONLY['1.4.1'],
      0n,
      payload.data,
      1,
      0n,
      0n,
      0n,
      '0x0000000000000000000000000000000000000000',
      '0x0000000000000000000000000000000000000000',
    ]);
    // The returned transaction is the handler's, unsigned, with no nonce yet (assigned at sign, ADR-0039).
    expect(prepared.callIndex).toBe(0);
    expect(decodeUnsignedTransaction(prepared.unsignedTransaction)).toMatchObject({
      to: SAFE,
      value: '0',
      nonce: null,
      senderAddress: executor.address,
    });
  });

  it('simulates with eth_call from the executor before preparing anything', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    expectOk(await t.subject.prepareExecution(t.proposal));
    expect(t.node.log.calls).toHaveLength(1);
    expect(t.node.log.calls[0]).toMatchObject({ account: executor.address, to: SAFE });
  });

  it('applies a 1.2x margin to the gas estimate, and never less than what prepare chose', async () => {
    const t = await setup({ node: { estimate: 1_000_000n } });
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    const first = expectOk(await t.subject.prepareExecution(t.proposal));
    expect(decodeUnsignedTransaction(first.unsignedTransaction).gas).toBe('1200000');

    // prepare's own estimate (here 500,000) wins when it is larger than ours.
    t.node.state.estimate = 100_000n;
    const second = expectOk(await t.subject.prepareExecution(t.proposal));
    expect(decodeUnsignedTransaction(second.unsignedTransaction).gas).toBe('500000');
  });

  it('fails cleanly on a GS013 simulation: CHAIN_REJECTED, nothing prepared', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    t.node.state.callResult = new Error('execution reverted: GS013');
    const error = expectErr(await t.subject.prepareExecution(t.proposal));
    expect(error.code).toBe('CHAIN_REJECTED');
    expect(error.message).toMatch(/GS013/);
    expect(t.prepare).not.toHaveBeenCalled();
    expect(t.node.log.estimates).toHaveLength(0);
  });

  it('fails any other revert the same way, and a simulation that returns false', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    t.node.state.callResult = new Error('execution reverted: GS026');
    expect(expectErr(await t.subject.prepareExecution(t.proposal)).code).toBe('CHAIN_REJECTED');
    t.node.state.callResult = RETURNS_FALSE;
    expect(expectErr(await t.subject.prepareExecution(t.proposal)).code).toBe('CHAIN_REJECTED');
    expect(t.prepare).not.toHaveBeenCalled();
  });

  it('keeps an RPC outage during the simulation retryable, not a verdict on the proposal', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    t.node.state.callResult = new Error('fetch failed: ETIMEDOUT');
    expect(expectErr(await t.subject.prepareExecution(t.proposal)).code).toBe('RPC_UNAVAILABLE');
    expect(t.prepare).not.toHaveBeenCalled();
  });

  it('does not simulate or prepare while fewer than threshold valid signatures are readable', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0]) }),
    );
    expect(expectErr(await t.subject.prepareExecution(t.proposal)).code).toBe('RPC_UNAVAILABLE');
    expect(t.node.log.calls).toHaveLength(0);
    expect(t.prepare).not.toHaveBeenCalled();
  });

  it('refuses a proposal whose nonce the Safe has passed: it can never execute', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    t.node.state.nonce = 13n;
    const error = expectErr(await t.subject.prepareExecution(t.proposal));
    expect(error.code).toBe('CHAIN_REJECTED');
    expect(t.prepare).not.toHaveBeenCalled();
  });

  it('refuses a payload that does not hash to its own safeTxHash, or is for another Safe', async () => {
    const t = await setup();
    const payload = JSON.parse(t.built.payload) as Record<string, unknown>;
    const tampered = {
      ...t.proposal,
      payload: JSON.stringify({ ...payload, value: '1' }),
    };
    expect(expectErr(await t.subject.prepareExecution(tampered)).code).toBe('CHAIN_REJECTED');
    const otherSafe = {
      ...t.proposal,
      chainRef: { ...t.ref, safe: '0x0000000000000000000000000000000000000009' },
    } as Proposal;
    expect(expectErr(await t.subject.prepareExecution(otherSafe)).code).toBe('CHAIN_REJECTED');
    expect(t.prepare).not.toHaveBeenCalled();
  });

  it("passes prepare's own failure through", async () => {
    const t = await setup({
      prepare: () => Promise.resolve(err({ code: 'RPC_UNAVAILABLE', message: 'no block' })),
    });
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    expect(expectErr(await t.subject.prepareExecution(t.proposal))).toMatchObject({
      code: 'RPC_UNAVAILABLE',
    });
  });

  it('serializes to a valid unsigned EIP-1559 transaction at the prepared gas', async () => {
    const t = await setup();
    t.respond(
      serviceTransaction({ safeTxHash: t.hash, nonce: 12, confirmations: await t.confirm([0, 1]) }),
    );
    const encoded = decodeUnsignedTransaction(
      expectOk(await t.subject.prepareExecution(t.proposal)).unsignedTransaction,
    );
    expect(() =>
      serializeTransaction({
        type: 'eip1559',
        chainId: encoded.chainId,
        nonce: 0,
        to: encoded.to,
        data: encoded.data,
        gas: BigInt(encoded.gas),
        maxFeePerGas: BigInt(encoded.maxFeePerGas),
        maxPriorityFeePerGas: BigInt(encoded.maxPriorityFeePerGas),
      }),
    ).not.toThrow();
  });
});

describe('estimateApprovalCost and the committed executor gas', () => {
  /** An independent computation of one bundle's cost with the fake node's fees. */
  const cost = (items: number, signatures: number, baseFee = 1_000_000n, l1 = 1_000n) => {
    const gas = withGasMargin(
      GAS_FIXED + GAS_PER_SIGNATURE * BigInt(signatures) + GAS_PER_ITEM * BigInt(items),
    );
    return gas * (baseFee * 2n) + l1 * L1_FEE_MULTIPLIER;
  };

  it('prices the execute in the native asset with the L2 fee cap, the margin and the doubled L1 fee', async () => {
    const t = await setup({ calls: [native(A, '1')] });
    const calls = [native(A, '5'), usdc(B, 7n), native(B, '9')];
    expect(expectOk(await t.subject.estimateApprovalCost(calls, SAFE))).toEqual({
      asset: 'ETH',
      amount: cost(3, 2).toString(),
      rentLocked: '0',
    });
  });

  it('sizes the L1 data fee from calldata carrying threshold-many dummy signatures', async () => {
    const t = await setup({ node: { threshold: 3 }, calls: [native(A, '1')] });
    t.node.log.l1FeeArgs.length = 0;
    expectOk(await t.subject.estimateApprovalCost([native(A, '5')], SAFE));
    expect(t.node.log.l1FeeArgs).toHaveLength(1);
    // The oracle prices the serialized transaction, which carries the execTransaction calldata.
    const serialized = t.node.log.l1FeeArgs[0]!;
    expect(serialized.startsWith('0x02')).toBe(true);
    const bigger = (await setup({ node: { threshold: 2 }, calls: [native(A, '1')] })).node;
    bigger.log.l1FeeArgs.length = 0;
    // A third signature adds 65 bytes, which the ABI pads to 64 more bytes of calldata.
    const t2 = await setup({ node: { threshold: 2 }, calls: [native(A, '1')] });
    t2.node.log.l1FeeArgs.length = 0;
    expectOk(await t2.subject.estimateApprovalCost([native(A, '5')], SAFE));
    expect(size(serialized) - size(t2.node.log.l1FeeArgs[0]!)).toBe(64);
    expect(GAS_PRICE_ORACLE).toBe('0x420000000000000000000000000000000000000F');
  });

  it('adds one execute per bundle when a Dispatch is larger than the bundle limit', async () => {
    const t = await setup({ bundleLimit: 3, calls: [native(A, '1')] });
    const calls = [native(A, '1'), native(A, '2'), native(A, '3'), native(A, '4')];
    expect(expectOk(await t.subject.estimateApprovalCost(calls, SAFE)).amount).toBe(
      (cost(3, 2) + cost(1, 2)).toString(),
    );
  });

  it('follows a changed base fee and a changed threshold', async () => {
    const t = await setup({ calls: [native(A, '1')] });
    t.node.state.baseFeePerGas = 5_000_000n;
    t.node.state.threshold = 4;
    expect(expectOk(await t.subject.estimateApprovalCost([native(A, '5')], SAFE)).amount).toBe(
      cost(1, 4, 5_000_000n).toString(),
    );
  });

  it('is zero for no Calls, and refuses another sender and a Call the bundle cannot hold', async () => {
    const t = await setup();
    expect(expectOk(await t.subject.estimateApprovalCost([], SAFE)).amount).toBe('0');
    expect(
      expectErr(
        await t.subject.estimateApprovalCost(
          [native(A, '1')],
          '0x0000000000000000000000000000000000000009',
        ),
      ).code,
    ).toBe('CHAIN_REJECTED');
    expect(
      expectErr(
        await t.subject.estimateApprovalCost([{ to: A, value: '0', data: '0xdeadbeef' }], SAFE),
      ).code,
    ).toBe('CHAIN_REJECTED');
  });

  it('reports an unreachable node as RPC_UNAVAILABLE', async () => {
    const t = await setup();
    t.node.client.getBlock = () => Promise.reject(new Error('ECONNREFUSED'));
    expect(expectErr(await t.subject.estimateApprovalCost([native(A, '1')], SAFE)).code).toBe(
      'RPC_UNAVAILABLE',
    );
  });

  it("commits the executor's gas for an open proposal, equal to the estimate for the same Calls", async () => {
    const calls = [native(A, '5'), usdc(B, 7n)];
    const t = await setup({ calls });
    const estimate = expectOk(await t.subject.estimateApprovalCost(calls, SAFE));
    expect(t.built.committed.proposer).toEqual([
      { asset: estimate.asset, amount: estimate.amount },
    ]);
    // The payments leave the Safe: ETH natively and the USDC token, each under its own asset id.
    expect(t.built.committed.sender).toEqual([
      { asset: 'ETH', amount: '5' },
      { asset: 'USDC', amount: '7' },
    ]);
  });
});

describe('buildProposal: the stale-nonce guard (minSequence)', () => {
  it('builds at max(chain nonce, minSequence): right after our own execution the chain read is stale', async () => {
    const t = await setup({ node: { nonce: 12n } });
    // We executed proposal 12 (CONFIRMED); the node still answers 12.
    const built = expectOk(
      await t.subject.buildProposal({ calls: [native(A, '1')], sender: SAFE, minSequence: 13 }),
    );
    expect(built.sequence).toBe(13);
    expect(built.chainRef).toMatchObject({ kind: 'safe', nonce: 13 });
    expect(JSON.parse(built.payload)).toMatchObject({ nonce: '13' });
  });

  it('lets a higher chain nonce win: an owner executed something else', async () => {
    const t = await setup({ node: { nonce: 12n } });
    t.node.state.nonce = 15n;
    const built = expectOk(
      await t.subject.buildProposal({ calls: [native(A, '1')], sender: SAFE, minSequence: 13 }),
    );
    expect(built.sequence).toBe(15);
    expect(JSON.parse(built.payload)).toMatchObject({ nonce: '15' });
  });

  it('uses the chain nonce when there is no minSequence, and hashes the nonce it chose', async () => {
    const t = await setup({ node: { nonce: 12n } });
    const stale = expectOk(
      await t.subject.buildProposal({ calls: [native(A, '1')], sender: SAFE, minSequence: 13 }),
    );
    const plain = expectOk(
      await t.subject.buildProposal({ calls: [native(A, '1')], sender: SAFE }),
    );
    expect(plain.sequence).toBe(12);
    expect(stale.proposalRef).not.toBe(plain.proposalRef);
  });
});
