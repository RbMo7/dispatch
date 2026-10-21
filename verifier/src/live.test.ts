// Read-only live checks against public testnet data: no funds, no keys. They
// need the network, so they only run when asked for (RUN_VERIFIER_LIVE=1), the
// way the engine's live-chain tier runs locally and not in CI (ADR-0013).
import { describe, expect, it } from 'vitest';
import { RpcError } from './errors.js';
import { JsonRpc } from './jsonrpc.js';
import type { Payment } from './payments.js';
import { evmRpc } from './safe/rpc.js';
import { verifySafe } from './safe/verify.js';
import { solanaReader } from './squads/rpc.js';
import { verifySquads } from './squads/verify.js';

const live = process.env.RUN_VERIFIER_LIVE === '1';
const BASE_SEPOLIA_RPC = process.env.VERIFIER_BASE_SEPOLIA_RPC_URL ?? 'https://sepolia.base.org';
const DEVNET_RPC = process.env.VERIFIER_DEVNET_RPC_URL ?? 'https://api.devnet.solana.com';

const R = '0x1111111111111111111111111111111111111111';

describe.skipIf(!live)('live, read-only', () => {
  it('Base Sepolia: the spike Safe (1.4.1) reproduces the spike vector hash', async () => {
    const payments: Payment[] = [
      { recipient: R, asset: 'native', amount: 1n, line: 1 },
      {
        recipient: R,
        asset: '0x036cbd53842c5426634e7929541ec2318f3dcf7e',
        amount: 5_000_000n,
        line: 2,
      },
    ];
    const report = await verifySafe({
      safe: '0x84Ac281B68de095f6227050F56C74d93d294e609',
      payments,
      bundleSize: 50,
      rpc: evmRpc(new JsonRpc(BASE_SEPOLIA_RPC)),
      nonce: 7n,
      safeTxHash: '0x4ad3beb568f992d2a87b4ab1dcb66bef600254d0b1c428aa15ff842fde28860b',
    });
    expect(report.verdict).toBe('MATCH');
    expect(Object.fromEntries(report.facts)['Chain']).toContain('84532');
  }, 30_000);

  it('devnet: an executed Squads proposal from the spike decodes to its 12 SPL transfers (skipped if it was closed)', async () => {
    try {
      const report = await verifySquads({
        proposal: '93mhkpapTrWCSFU5RaauPTCitwqRtrf441x133TMBRt',
        payments: [
          {
            recipient: '2dXk7KqsKDMVK9F9zssWKz18nRvQ6faPonREprwn72zi',
            asset: 'native',
            amount: 1n,
            line: 1,
          },
        ],
        read: solanaReader(new JsonRpc(DEVNET_RPC)),
      });
      expect(report.proposalItems).toHaveLength(12);
      expect(Object.fromEntries(report.facts)['Status']).toMatch(/^Executed/);
    } catch (e) {
      if (e instanceof RpcError && /does not exist|no longer exists/.test(e.message)) return;
      throw e;
    }
  }, 30_000);
});
