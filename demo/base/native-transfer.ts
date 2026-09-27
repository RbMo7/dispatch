/**
 * Demo 1: native ETH from the Sender to five fresh wallets, as one Managed
 * Dispatch through `POST /v1/dispatch` — then each balance is checked
 * on-chain, not just the engine's own status.
 *
 * Run from the repo root: `pnpm tsx demo/base/native-transfer.ts`
 */
import { generatePrivateKey, privateKeyToAddress } from 'viem/accounts';

import { client, run, startEngine, waitFor } from './engine.js';

const AMOUNT_WEI = 10_000_000_000n; // 0.00000001 ETH each

run(async () => {
  const recipients = Array.from({ length: 5 }, () => privateKeyToAddress(generatePrivateKey()));
  const engine = await startEngine();

  const result = await engine.dispatch(
    recipients.map((recipient) => ({
      type: 'payment',
      recipient,
      asset: 'ETH',
      amount: AMOUNT_WEI.toString(),
    })),
  );
  await engine.close();
  if (result.status !== 'confirmed') throw new Error(`expected confirmed, got ${result.status}`);

  for (const recipient of recipients) {
    const balance = await waitFor(() => client.getBalance({ address: recipient }), AMOUNT_WEI);
    console.log(`${recipient}: ${balance} wei`);
    if (balance !== AMOUNT_WEI)
      throw new Error(`${recipient} holds ${balance}, expected ${AMOUNT_WEI}`);
  }
  console.log('\n✔ Five native ETH transfers dispatched and confirmed on-chain.');
});
