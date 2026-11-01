import type { Check } from './check.js';
import { network, rpcReachable } from './checks/chain.js';
import { enabledChains, environmentParses, tokens } from './checks/configuration.js';
import { consoleBuilt } from './checks/console.js';
import { databaseMigrated, databaseReachable } from './checks/database.js';
import { multisigAccount, multisigMember } from './checks/multisig.js';
import { exclusiveSender, feeBalance, tokenBalances } from './checks/sender.js';
import { signerKeyHeld, signerNotInApi, signerPinned, signerReachable } from './checks/signer.js';

/** Every setup check, in report order: `doctor` runs the `cli` ones, the worker the `worker` ones. */
export const CHECKS: readonly Check[] = [
  environmentParses,
  tokens,
  enabledChains,
  databaseReachable,
  databaseMigrated,
  rpcReachable,
  network,
  signerReachable,
  signerKeyHeld,
  signerPinned,
  signerNotInApi,
  feeBalance,
  tokenBalances,
  exclusiveSender,
  multisigAccount,
  multisigMember,
  consoleBuilt,
];
