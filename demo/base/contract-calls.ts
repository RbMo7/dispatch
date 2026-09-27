/**
 * Demo 3: a freshly deployed contract whose public `run(n)` does its work
 * in an internal `_run`, called 15 times as one Managed Dispatch of raw
 * `call` items through `POST /v1/dispatch` — 15 transactions, 15
 * consecutive nonces, all owned by the engine. The contract's own state
 * is then checked on-chain.
 *
 * Run from the repo root: `pnpm tsx demo/base/contract-calls.ts`
 */
import { encodeFunctionData } from 'viem';

import { client, deploy, run, startEngine, waitFor } from './engine.js';

const RUNNER_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract Runner {
    uint256 public runs;
    uint256 public total;
    event Ran(address indexed caller, uint256 n, uint256 runs);

    function run(uint256 n) external {
        _run(msg.sender, n);
    }

    function _run(address caller, uint256 n) internal {
        runs += 1;
        total += n;
        emit Ran(caller, n, runs);
    }
}
`;

const CALLS = 15;

run(async () => {
  const runner = await deploy('Runner', RUNNER_SOURCE);
  const engine = await startEngine();

  const result = await engine.dispatch(
    Array.from({ length: CALLS }, (_, i) => ({
      type: 'call',
      to: runner.address,
      data: encodeFunctionData({ abi: runner.abi, functionName: 'run', args: [BigInt(i + 1)] }),
      value: '0',
    })),
  );
  await engine.close();
  if (result.status !== 'confirmed') throw new Error(`expected confirmed, got ${result.status}`);

  const read = (functionName: 'runs' | 'total') => () =>
    client.readContract({
      address: runner.address,
      abi: runner.abi,
      functionName,
    }) as Promise<bigint>;
  const runs = await waitFor(read('runs'), BigInt(CALLS));
  const total = await read('total')();
  const expectedTotal = BigInt((CALLS * (CALLS + 1)) / 2);
  console.log(`Runner.runs = ${runs}, Runner.total = ${total}`);
  if (runs !== BigInt(CALLS) || total !== expectedTotal) {
    throw new Error(`expected runs=${CALLS} total=${expectedTotal}`);
  }
  console.log(
    `\n✔ ${CALLS} contract calls dispatched, confirmed, and reflected in contract state.`,
  );
});
