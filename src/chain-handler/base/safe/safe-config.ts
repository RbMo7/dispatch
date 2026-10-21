import { getAddress, isAddress, type Address } from 'viem';

/** ADR-0051: the engine's Safe-mode config for Base, validated once at startup. */
export type BaseSafeConfig = {
  /** The Safe the payments come from. */
  safeAddress: Address;
  /** The ordinary key that submits `execTransaction`, owns the nonce and is a registered delegate. Never an owner. */
  executorAddress: Address;
  /** Base URL of the Safe Transaction Service, no trailing slash. */
  txServiceUrl: string;
  /** Sent as `Authorization: Bearer`. Never logged, never in an error. */
  apiKey: string | undefined;
  /** ADR-0053: how long a proposal waits for approval before its Calls are `ABANDONED`. */
  approvalDeadlineMs: number;
  /** ADR-0053: how long an abandoned proposal is still watched for a late execution. */
  approvalRewatchWindowMs: number;
  /** #83: the most Calls in one Safe proposal (one MultiSend). A Dispatch bigger than this becomes several proposals, one at a time. */
  bundleLimit: number;
};

/** The unparsed `BASE_*` settings, exactly as config.ts reads them. */
export type RawBaseSafeSettings = {
  senderMode: string;
  senderAddress: string;
  safeAddress: string;
  safeExecutorAddress: string;
  txServiceUrl: string;
  apiKey: string;
  approvalDeadlineMs: string;
  approvalRewatchWindowMs: string;
  /** Optional: unset or empty means the default. */
  bundleLimit?: string;
};

export const DEFAULT_APPROVAL_DEADLINE_MS = 72 * 60 * 60 * 1000;
export const DEFAULT_APPROVAL_REWATCH_WINDOW_MS = 30 * 24 * 60 * 60 * 1000;

/** Spike #79: 50 items is ~1.7M gas and ~6 KB, comfortable on-chain and still reviewable by owners. */
export const DEFAULT_SAFE_BUNDLE_LIMIT = 50;
/** Spike #79: the per-transaction gas cap bites near 500 items; do not go beyond ~300. */
export const MAX_SAFE_BUNDLE_LIMIT = 300;

const DEFAULT_TX_SERVICE_URLS: Record<number, string> = {
  8453: 'https://api.safe.global/tx-service/base',
  84532: 'https://api.safe.global/tx-service/basesep',
};

/**
 * `single` (the default) is today's behavior and returns `undefined`.
 * `safe` returns the validated Safe config, or throws one error naming
 * every problem — a misconfiguration stops startup, never a payment.
 */
export function resolveBaseSafeConfig(
  raw: RawBaseSafeSettings,
  chainId: number,
): BaseSafeConfig | undefined {
  const mode = raw.senderMode.trim() === '' ? 'single' : raw.senderMode.trim();
  if (mode !== 'single' && mode !== 'safe') {
    throw new Error(`BASE_SENDER_MODE must be "single" or "safe", got "${raw.senderMode}"`);
  }

  if (mode === 'single') {
    const stray = (
      [
        ['BASE_SAFE_ADDRESS', raw.safeAddress],
        ['BASE_SAFE_EXECUTOR_ADDRESS', raw.safeExecutorAddress],
        ['BASE_SAFE_API_KEY', raw.apiKey],
        ['BASE_SAFE_BUNDLE_LIMIT', raw.bundleLimit ?? ''],
      ] as const
    )
      .filter(([, value]) => value.trim() !== '')
      .map(([name]) => name);
    if (stray.length > 0) {
      throw new Error(
        `${stray.join(', ')} set while BASE_SENDER_MODE is "single" — set BASE_SENDER_MODE=safe, or unset them`,
      );
    }
    return undefined;
  }

  const problems: string[] = [];
  const address = (name: string, value: string): Address | undefined => {
    if (value.trim() === '') {
      problems.push(`${name} is required when BASE_SENDER_MODE=safe`);
      return undefined;
    }
    if (!isAddress(value.trim(), { strict: true })) {
      problems.push(
        `${name} is not a valid address (a mixed-case address must have a correct checksum): ${value}`,
      );
      return undefined;
    }
    return getAddress(value.trim());
  };

  const safeAddress = address('BASE_SAFE_ADDRESS', raw.safeAddress);
  const executorAddress = address('BASE_SAFE_EXECUTOR_ADDRESS', raw.safeExecutorAddress);

  if (raw.senderAddress.trim() !== '') {
    const sender = address('BASE_SENDER_ADDRESS', raw.senderAddress);
    if (sender && executorAddress && sender !== executorAddress) {
      problems.push(
        `BASE_SENDER_ADDRESS (${sender}) must equal BASE_SAFE_EXECUTOR_ADDRESS (${executorAddress}): in safe mode the executor is the Sender whose nonce and signing the engine owns. Unset BASE_SENDER_ADDRESS to use the executor.`,
      );
    }
  }
  if (safeAddress && executorAddress && safeAddress === executorAddress) {
    problems.push(
      'BASE_SAFE_ADDRESS and BASE_SAFE_EXECUTOR_ADDRESS must be different addresses: the Safe cannot execute for itself',
    );
  }

  const txServiceUrl = (raw.txServiceUrl.trim() || DEFAULT_TX_SERVICE_URLS[chainId] || '').replace(
    /\/+$/,
    '',
  );
  if (txServiceUrl === '') {
    problems.push(
      `BASE_SAFE_TX_SERVICE_URL is required for chain ID ${chainId} (the hosted service is only a default for 8453 and 84532)`,
    );
  } else {
    try {
      const { protocol } = new URL(txServiceUrl);
      if (protocol !== 'https:' && protocol !== 'http:') throw new Error('not http(s)');
    } catch {
      problems.push(`BASE_SAFE_TX_SERVICE_URL is not a valid http(s) URL: ${txServiceUrl}`);
    }
  }

  const duration = (name: string, value: string, fallback: number): number => {
    if (value.trim() === '') return fallback;
    const parsed = Number(value);
    if (!Number.isSafeInteger(parsed) || parsed <= 0) {
      problems.push(`${name} must be a positive whole number of milliseconds, got "${value}"`);
      return fallback;
    }
    return parsed;
  };
  const approvalDeadlineMs = duration(
    'BASE_APPROVAL_DEADLINE_MS',
    raw.approvalDeadlineMs,
    DEFAULT_APPROVAL_DEADLINE_MS,
  );
  const approvalRewatchWindowMs = duration(
    'BASE_APPROVAL_REWATCH_WINDOW_MS',
    raw.approvalRewatchWindowMs,
    DEFAULT_APPROVAL_REWATCH_WINDOW_MS,
  );

  let bundleLimit = DEFAULT_SAFE_BUNDLE_LIMIT;
  if ((raw.bundleLimit ?? '').trim() !== '') {
    const parsed = Number(raw.bundleLimit);
    if (!Number.isSafeInteger(parsed) || parsed < 1 || parsed > MAX_SAFE_BUNDLE_LIMIT) {
      problems.push(
        `BASE_SAFE_BUNDLE_LIMIT must be a whole number from 1 to ${MAX_SAFE_BUNDLE_LIMIT}, got "${raw.bundleLimit}"`,
      );
    } else {
      bundleLimit = parsed;
    }
  }

  if (problems.length > 0 || !safeAddress || !executorAddress) {
    throw new Error(`invalid Safe sender config:\n${problems.map((p) => `  - ${p}`).join('\n')}`);
  }

  return {
    safeAddress,
    executorAddress,
    txServiceUrl,
    apiKey: raw.apiKey.trim() === '' ? undefined : raw.apiKey.trim(),
    approvalDeadlineMs,
    approvalRewatchWindowMs,
    bundleLimit,
  };
}
