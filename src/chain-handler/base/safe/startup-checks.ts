import { serializeTransaction, zeroAddress, type Address } from 'viem';

import type { SignerClient } from '../../../signer/client.js';
import type { BaseSafeConfig } from './safe-config.js';
import type { SafeOnChainState } from './safe-reads.js';
import { SafeTxServiceError, type SafeTxServiceClient } from './tx-service-client.js';

/** ADR-0051: the Safe versions whose hashing and execution were verified (spike #79). L1 and L2 variants both report these. */
export const SUPPORTED_SAFE_VERSIONS = ['1.3.0', '1.4.1'];

/**
 * Whether the Signer holds a key for the executor. `refused` still proves
 * the key exists: ADR-0046's per-address policy refuses a transaction it
 * does not allow, and the probe is deliberately not one it allows.
 */
export type SignerProbe = 'can-sign' | 'refused-by-policy' | 'no-key' | 'unreachable';

export type SafeStartupDeps = {
  config: BaseSafeConfig;
  /** The chain ID the engine is configured for (BASE_CHAIN_ID). */
  chainId: number;
  service: Pick<SafeTxServiceClient, 'about' | 'getSafe' | 'getDelegates'>;
  /** Reads the Safe from the chain, pinned to one block (safe-reads.ts). */
  readSafe: (safe: Address) => Promise<SafeOnChainState>;
  probeSigner: (executor: Address) => Promise<SignerProbe>;
  now?: () => number;
};

/** One thing wrong that stops startup: `check` names it, so an operator can tell which. */
export type SafeStartupFailure = { check: string; message: string };

export class SafeStartupError extends Error {
  constructor(readonly failures: SafeStartupFailure[]) {
    super(
      `Safe sender startup checks failed (nothing was sent):\n${failures.map((f) => `  - [${f.check}] ${f.message}`).join('\n')}`,
    );
    this.name = 'SafeStartupError';
  }
}

/**
 * ADR-0051: fails loudly, before anything is sent, on a Safe the engine
 * cannot safely act for. Throws `SafeStartupError` listing every failed
 * check; on success returns the warnings (data, so the caller logs them).
 */
export async function runSafeStartupChecks(deps: SafeStartupDeps): Promise<{ warnings: string[] }> {
  const { config, service } = deps;
  const failures: SafeStartupFailure[] = [];
  const warnings: string[] = [];
  const fail = (check: string, message: string) => failures.push({ check, message });

  // The service first: it is the one dependency that can be down or refuse us.
  let serviceUp = true;
  try {
    await service.about();
  } catch (cause) {
    serviceUp = false;
    fail('service reachable', describeServiceError(cause));
  }

  let chain: SafeOnChainState | undefined;
  try {
    chain = await deps.readSafe(config.safeAddress);
  } catch (cause) {
    fail(
      'safe readable',
      `could not read the Safe ${config.safeAddress} from the chain RPC: ${errorText(cause)}`,
    );
  }

  if (chain) {
    if (chain.chainId !== deps.chainId) {
      fail(
        'chain id',
        `the RPC answered chain ID ${chain.chainId} but BASE_CHAIN_ID is ${deps.chainId}`,
      );
    } else if (!chain.hasCode) {
      fail(
        'safe exists',
        `no contract at ${config.safeAddress} on chain ${deps.chainId}: BASE_SAFE_ADDRESS is wrong, or the Safe lives on another chain`,
      );
    } else {
      if (!SUPPORTED_SAFE_VERSIONS.includes(chain.version)) {
        fail(
          'safe version',
          `the Safe reports VERSION() "${chain.version}"; only ${SUPPORTED_SAFE_VERSIONS.join(' and ')} (L1 or L2) are supported`,
        );
      }
      if (chain.owners.some((owner) => sameAddress(owner, config.executorAddress))) {
        fail(
          'executor is not an owner',
          `BASE_SAFE_EXECUTOR_ADDRESS ${config.executorAddress} is an owner of the Safe. The engine's key must never be able to approve: use a separate key, and remove this one from the owners.`,
        );
      }
      if (chain.threshold === 1) {
        warnings.push(
          'the Safe has a threshold of 1: a single owner approves every payment, so the multisig adds no second approver',
        );
      }
      if (!isZero(chain.guard)) {
        warnings.push(
          `the Safe has a guard (${chain.guard}): a guard can revert execTransaction, and the engine cannot see why`,
        );
      }
      if (chain.modules.length > 0) {
        warnings.push(
          `the Safe has ${chain.modules.length} module(s) enabled (${chain.modules.join(', ')}): a module can move funds without owner approvals`,
        );
      }

      if (serviceUp) {
        await crossCheckService(deps, chain, fail);
      }
    }
  }

  if (serviceUp && (!chain || chain.hasCode)) {
    await checkDelegate(deps, fail);
  }

  const signer = await deps
    .probeSigner(config.executorAddress)
    .catch((): SignerProbe => 'unreachable');
  if (signer === 'no-key') {
    fail(
      'signer can sign for the executor',
      `the Signer has no key for ${config.executorAddress}: add it to the Signer's config (docs/signer.md), pinned to the Safe by policy`,
    );
  } else if (signer === 'unreachable') {
    fail(
      'signer can sign for the executor',
      `could not ask the Signer about ${config.executorAddress}: it is unreachable or refused our token (SIGNER_URL, SIGNER_AUTH_TOKEN)`,
    );
  }

  if (config.apiKey === undefined) {
    warnings.push(
      'BASE_SAFE_API_KEY is not set: the Safe Transaction Service allows only 2 requests/second and 5,000/month without one, which watching a proposal will exhaust (developer.safe.global)',
    );
  }

  if (failures.length > 0) throw new SafeStartupError(failures);
  return { warnings };
}

async function crossCheckService(
  deps: SafeStartupDeps,
  chain: SafeOnChainState,
  fail: (check: string, message: string) => void,
): Promise<void> {
  const { config, service } = deps;
  try {
    const known = await service.getSafe(config.safeAddress);
    const sameOwners =
      known.owners.length === chain.owners.length &&
      known.owners.every((o) => chain.owners.some((c) => sameAddress(c, o)));
    if (!sameOwners || known.threshold !== chain.threshold) {
      fail(
        'service matches chain',
        `the Safe Transaction Service's owners/threshold for ${config.safeAddress} differ from the chain's: BASE_SAFE_TX_SERVICE_URL probably serves a different chain (or has not indexed a recent owner change)`,
      );
    }
  } catch (cause) {
    if (cause instanceof SafeTxServiceError && cause.kind === 'not-found') {
      fail(
        'service matches chain',
        `the Safe Transaction Service has no Safe ${config.safeAddress}, though it exists on chain ${deps.chainId}: BASE_SAFE_TX_SERVICE_URL probably serves a different chain, or the Safe is not indexed yet`,
      );
    } else {
      fail('service reachable', describeServiceError(cause));
    }
  }
}

async function checkDelegate(
  deps: SafeStartupDeps,
  fail: (check: string, message: string) => void,
): Promise<void> {
  const { config, service } = deps;
  try {
    const now = (deps.now ?? Date.now)();
    const registrations = await service.getDelegates(config.safeAddress, config.executorAddress);
    const live = registrations.filter(
      (r) => r.expiryDate === null || Date.parse(r.expiryDate) > now,
    );
    if (live.length === 0) {
      fail(
        'executor is a registered delegate',
        `${config.executorAddress} is not a delegate of the Safe${registrations.length > 0 ? ' (its registration has expired)' : ''}, so the service would reject every proposal with 422. An owner must register it: sign the EIP-712 typed data Delegate(address delegateAddress, uint256 totp) (domain {name: "Safe Transaction Service", version: "1.0", chainId: ${deps.chainId}}, totp = floor(unix seconds / 3600)) and POST /api/v2/delegates/ with {safe, delegate, delegator, label, signature}, or use the Safe SDK's addSafeDelegate`,
      );
    }
  } catch (cause) {
    fail('executor is a registered delegate', describeServiceError(cause));
  }
}

/** Never includes a request header or the API key: the client's messages carry only URL, status and body. */
function describeServiceError(cause: unknown): string {
  if (cause instanceof SafeTxServiceError) return cause.message;
  return `Safe Transaction Service check failed: ${errorText(cause)}`;
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}

function sameAddress(a: string, b: string): boolean {
  return a.toLowerCase() === b.toLowerCase();
}

function isZero(address: Address): boolean {
  return sameAddress(address, zeroAddress);
}

/**
 * Asks the Signer whether it holds the executor's key by requesting a
 * signature over a harmless 0-value transaction to the executor itself.
 * The signature is discarded and never broadcast; the Signer's audit log
 * records the request. A 403 policy refusal still proves the key exists
 * (ADR-0046); a 404 means it does not. (The Safe typed-data request kind
 * is #80's and is not probed here.)
 */
export async function probeSignerForAddress(
  signerClient: SignerClient,
  chainId: number,
  address: Address,
): Promise<SignerProbe> {
  const unsigned = serializeTransaction({
    type: 'eip1559',
    chainId,
    nonce: 0,
    to: address,
    value: 0n,
    gas: 21_000n,
    maxFeePerGas: 1n,
    maxPriorityFeePerGas: 1n,
  });
  const result = await signerClient.requestSignature({
    chain: 'base',
    curve: 'secp256k1',
    address,
    unsignedTransaction: Buffer.from(unsigned.slice(2), 'hex').toString('base64'),
  });
  if (result.ok) return 'can-sign';
  if (result.error.code === 'SIGNER_REFUSED') return 'refused-by-policy';
  return result.error.message.endsWith('404') ? 'no-key' : 'unreachable';
}
