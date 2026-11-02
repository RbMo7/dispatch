import { encodeErrorResult } from 'viem';
import { describe, expect, it } from 'vitest';

import { InMemoryNonceHistoryStore } from '../../repository/in-memory-nonce-history-store.js';
import { BaseChainHandler } from './base-chain-handler.js';
import { revertReason } from './revert-reason.js';

const SENDER = '0x90C91Bd4Bc2f5e194a16Bb2062fe97BF5E4933b4';
const VAULT = '0x6101864ad086cecf28d91b25068969a4d1129278';
const HASH = '0x371e2361ccd2e79bff8bed7befdf6084545e5c864ec08dc146f80fbede150d96';
const BLOCK = '0x32af48f';
const SELECTOR = '0x975af67a';

const errorString = encodeErrorResult({
  abi: [{ type: 'error', name: 'Error', inputs: [{ name: 'message', type: 'string' }] }],
  errorName: 'Error',
  args: ['always reverts'],
});

/** The node's answers for FlowVault.revertAlways(), reverted on Base Sepolia in block 53146767; the eth_call error is the one sepolia.base.org gave. */
function fakeRpc(opts: { gasUsed: string; call: { error?: unknown; result?: string } }) {
  const calls: { method: string; params: unknown[] }[] = [];
  const fetcher: typeof fetch = (_input, init) => {
    const { id, method, params } = JSON.parse(init?.body as string) as {
      id: number;
      method: string;
      params: unknown[];
    };
    calls.push({ method, params });
    const results: Record<string, unknown> = {
      eth_chainId: '0x14a34',
      eth_getTransactionCount: '0x0',
      eth_getTransactionByHash: {
        blockHash: `0x${'ab'.repeat(32)}`,
        blockNumber: BLOCK,
        chainId: '0x14a34',
        from: SENDER.toLowerCase(),
        gas: '0x7a120',
        maxFeePerGas: '0xf4240',
        maxPriorityFeePerGas: '0x1',
        hash: HASH,
        input: SELECTOR,
        nonce: '0x2a',
        to: VAULT.toLowerCase(),
        transactionIndex: '0x3',
        value: '0x0',
        type: '0x2',
        accessList: [],
        v: '0x0',
        r: `0x${'11'.repeat(32)}`,
        s: `0x${'22'.repeat(32)}`,
        yParity: '0x0',
      },
      eth_getTransactionReceipt: {
        blockHash: `0x${'ab'.repeat(32)}`,
        blockNumber: BLOCK,
        contractAddress: null,
        cumulativeGasUsed: '0x1d4c0',
        effectiveGasPrice: '0xf4240',
        from: SENDER.toLowerCase(),
        gasUsed: opts.gasUsed,
        logs: [],
        logsBloom: `0x${'00'.repeat(256)}`,
        status: '0x0',
        to: VAULT.toLowerCase(),
        transactionHash: HASH,
        transactionIndex: '0x3',
        type: '0x2',
      },
    };
    if (method === 'eth_call') {
      return Promise.resolve(Response.json({ jsonrpc: '2.0', id, ...opts.call }));
    }
    return Promise.resolve(Response.json({ jsonrpc: '2.0', id, result: results[method] }));
  };
  return { fetcher, calls };
}

async function handlerWith(fetcher: typeof fetch) {
  return BaseChainHandler.create({
    rpcUrl: 'http://base.invalid',
    chainId: 84532,
    senderAddress: SENDER,
    nonceHistoryStore: new InMemoryNonceHistoryStore(),
    fetch: fetcher,
  });
}

describe('BaseChainHandler.failureReason (#169)', () => {
  it('replays a reverted transaction at its block and reports the revert reason', async () => {
    const { fetcher, calls } = fakeRpc({
      gasUsed: '0x53ed',
      call: {
        error: { code: 3, message: 'execution reverted: always reverts', data: errorString },
      },
    });
    const handler = await handlerWith(fetcher);

    const error = await handler.failureReason(HASH);

    expect(error).toEqual({
      code: 'CHAIN_REJECTED',
      message: 'reverted: always reverts',
      chainDetail: {
        block: '53146767',
        gasUsed: '21485',
        gasLimit: String(0x7a120),
        reason: 'always reverts',
        revertData: errorString,
      },
    });
    const replay = calls.find((c) => c.method === 'eth_call');
    expect(replay?.params[1]).toBe(BLOCK);
    expect(replay?.params[0]).toMatchObject({
      from: SENDER.toLowerCase(),
      to: VAULT.toLowerCase(),
      data: SELECTOR,
    });
  });

  it('says a transaction that used all its gas ran out of it, without a replay', async () => {
    const { fetcher, calls } = fakeRpc({ gasUsed: '0x7a120', call: { result: '0x' } });
    const handler = await handlerWith(fetcher);

    const error = await handler.failureReason(HASH);

    expect(error?.message).toBe('reverted: ran out of gas (used all 500000 of its gas limit)');
    expect(calls.some((c) => c.method === 'eth_call')).toBe(false);
  });

  it('says so when the replay does not revert', async () => {
    const { fetcher } = fakeRpc({ gasUsed: '0x53ed', call: { result: '0x' } });
    const handler = await handlerWith(fetcher);

    const error = await handler.failureReason(HASH);

    expect(error).toMatchObject({ code: 'CHAIN_REJECTED' });
    expect(error?.message).toContain('did not revert');
  });

  it('gives no reason when the chain cannot be read', async () => {
    const { fetcher } = fakeRpc({ gasUsed: '0x53ed', call: { result: '0x' } });
    const handler = await handlerWith(fetcher);
    const down: typeof fetch = (input, init) =>
      (JSON.parse(init?.body as string) as { method: string }).method === 'eth_getTransactionByHash'
        ? Promise.resolve(new Response('bad gateway', { status: 502 }))
        : fetcher(input, init);
    const flaky = await handlerWith(down);

    expect(await flaky.failureReason(HASH)).toBeNull();
    expect(await handler.failureReason(HASH)).not.toBeNull();
  });
});

describe('revertReason', () => {
  it('reads a Panic code, a custom error and empty revert data', () => {
    const panic = encodeErrorResult({
      abi: [{ type: 'error', name: 'Panic', inputs: [{ name: 'code', type: 'uint256' }] }],
      errorName: 'Panic',
      args: [0x11n],
    });

    expect(revertReason(panic).reason).toBe('panic 0x11: arithmetic overflow or underflow');
    expect(revertReason('0xfb8f41b2000000').reason).toBe('custom error 0xfb8f41b2');
    expect(revertReason('0x').reason).toBe('reverted with no reason');
  });
});
