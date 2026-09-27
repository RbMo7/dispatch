/**
 * Demo 2: a freshly deployed ERC-20 from the Sender to five fresh wallets.
 * The token is deployed outside the engine, registered with it as a known
 * token (what `BASE_KNOWN_TOKENS` does for a real deployment), then paid
 * out as one Managed Dispatch through `POST /v1/dispatch`.
 *
 * Run from the repo root: `pnpm tsx demo/base/token-transfer.ts`
 */
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

import { client, deploy, run, startEngine, waitFor } from './engine.js';

const DEMO_TOKEN_SOURCE = `
// SPDX-License-Identifier: MIT
pragma solidity ^0.8.20;

contract DemoToken {
    string public constant name = "Demo Token";
    string public constant symbol = "DEMO";
    uint8 public constant decimals = 6;
    mapping(address => uint256) public balanceOf;
    event Transfer(address indexed from, address indexed to, uint256 value);

    constructor(uint256 initialSupply) {
        balanceOf[msg.sender] = initialSupply;
        emit Transfer(address(0), msg.sender, initialSupply);
    }

    function transfer(address to, uint256 value) external returns (bool) {
        require(balanceOf[msg.sender] >= value, "insufficient balance");
        balanceOf[msg.sender] -= value;
        balanceOf[to] += value;
        emit Transfer(msg.sender, to, value);
        return true;
    }
}
`;

const AMOUNT = 25_000_000n; // 25 DEMO each (6 decimals)

run(async () => {
  const token = await deploy('DemoToken', DEMO_TOKEN_SOURCE, [1_000_000_000_000n]);
  const recipients = Array.from({ length: 5 }, () => privateKeyToAddress(generatePrivateKey()));
  const engine = await startEngine({ DEMO: { contractAddress: token.address, decimals: 6 } });

  const result = await engine.dispatch(
    recipients.map((recipient) => ({
      type: 'payment',
      recipient,
      asset: 'DEMO',
      amount: AMOUNT.toString(),
    })),
  );
  await engine.close();
  if (result.status !== 'confirmed') throw new Error(`expected confirmed, got ${result.status}`);

  for (const recipient of recipients) {
    const balance = await waitFor(
      () =>
        client.readContract({
          address: token.address,
          abi: token.abi,
          functionName: 'balanceOf',
          args: [recipient],
        }) as Promise<bigint>,
      AMOUNT,
    );
    console.log(`${recipient}: ${balance} DEMO base units`);
    if (balance !== AMOUNT) throw new Error(`${recipient} holds ${balance}, expected ${AMOUNT}`);
  }
  console.log('\n✔ Five ERC-20 transfers dispatched and confirmed on-chain.');
});
