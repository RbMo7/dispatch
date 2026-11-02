import { baseNetwork, solanaNetwork } from '../../api/network.js';
import type { Config } from '../../config.js';
import { fail, pass, warn, type Check, type CheckResult, type NetworkRead } from '../check.js';
import { errorText, hostOf, notCheckedFinding, rpcFix, rpcVariable } from '../wording.js';

function rpcUrl(config: Config, chain: NetworkRead['chain']): string {
  return chain === 'solana' ? config.solana.rpcUrl : config.base.rpcUrl;
}

export const rpcReachable: Check = {
  id: 'chain.rpc',
  area: 'chain',
  title: 'RPC reachable',
  runsIn: ['cli', 'worker'],
  scope: 'chain',
  run: async (context, chain) => {
    const where = `${rpcVariable(chain)} (${hostOf(rpcUrl(context.config, chain))})`;
    try {
      await context.chain(chain).network();
      return pass(`${where} answered`);
    } catch (cause) {
      return fail(`${where} did not answer: ${errorText(cause)}`, rpcFix(chain));
    }
  },
};

export const network: Check = {
  id: 'chain.network',
  area: 'chain',
  title: 'Network',
  runsIn: ['cli', 'worker'],
  scope: 'chain',
  run: async (context, chain) => {
    let read: NetworkRead;
    try {
      read = await context.chain(chain).network();
    } catch (cause) {
      return warn(notCheckedFinding(`the RPC did not answer: ${errorText(cause)}`), rpcFix(chain));
    }
    return read.chain === 'solana'
      ? judgeSolanaNetwork(read.genesisHash)
      : judgeBaseNetwork(read.chainId, context.config.base.chainId);
  },
};

function judgeSolanaNetwork(genesisHash: string): CheckResult {
  const cluster = solanaNetwork(genesisHash);
  if (typeof cluster !== 'string' || cluster === 'unknown') {
    return warn(
      `SOLANA_RPC_URL serves a cluster with genesis hash ${genesisHash}, which is not mainnet-beta, devnet or testnet`,
      rpcFix('solana'),
    );
  }
  return pass(`SOLANA_RPC_URL serves ${cluster}`);
}

function judgeBaseNetwork(served: number, configured: number): CheckResult {
  if (served !== configured) {
    return fail(`BASE_RPC_URL serves chain ${served}, but BASE_CHAIN_ID is ${configured}`, {
      setting: 'BASE_RPC_URL',
      value: `an RPC for chain ${configured} (BASE_CHAIN_ID), or set BASE_CHAIN_ID=${served}`,
    });
  }
  const named = baseNetwork(served);
  const name =
    named === 'base' ? 'Base mainnet' : named === 'base-sepolia' ? 'Base Sepolia' : 'chain';
  return pass(`BASE_RPC_URL serves ${name} (${served}), as BASE_CHAIN_ID says`);
}
