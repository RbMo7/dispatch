import { describe, expect, it } from 'vitest';

import type { PolicyRead } from '../../../signer/client.js';
import type { BaseSafeConfig } from './safe-config.js';
import type { SafeOnChainState } from './safe-reads.js';
import { runSafeStartupChecks, SafeStartupError, type SafeStartupDeps } from './startup-checks.js';
import {
  SafeTxServiceError,
  type ServiceDelegate,
  type ServiceSafeInfo,
} from './tx-service-client.js';

const SAFE = '0x84Ac281B68de095f6227050F56C74d93d294e609';
const EXECUTOR = '0x2d0b8242f5675eb51965488AC3C2f4038Ad8658E';
const OWNERS = [
  '0xE3372Dbf65B13291094F0A3520cb03dB155d8586',
  '0xA849e67B662129912513E2A8017B437f4251c0a5',
  '0x461BAfEb8A9cbe40f399aF907180A75b2c7cCb7C',
] as const;
const ZERO = '0x0000000000000000000000000000000000000000';
const API_KEY = 'sk_live_super_secret_key';
const NOW = Date.parse('2026-10-21T12:00:00Z');

const config: BaseSafeConfig = {
  safeAddress: SAFE,
  executorAddress: EXECUTOR,
  txServiceUrl: 'https://api.safe.global/tx-service/basesep',
  apiKey: API_KEY,
  approvalDeadlineMs: 1,
  approvalRewatchWindowMs: 1,
  bundleLimit: 50,
};

const goodChain: SafeOnChainState = {
  blockNumber: 100n,
  chainId: 84532,
  hasCode: true,
  version: '1.4.1',
  owners: [...OWNERS],
  threshold: 2,
  nonce: 11n,
  guard: ZERO,
  modules: [],
};
const goodInfo: ServiceSafeInfo = {
  address: SAFE,
  nonce: '11',
  threshold: 2,
  owners: [...OWNERS],
  modules: [],
  guard: ZERO,
  version: '1.4.1+L2',
};
const goodDelegate: ServiceDelegate = {
  safe: SAFE,
  delegate: EXECUTOR,
  delegator: OWNERS[0],
  label: 'dispatch-engine',
  expiryDate: null,
};

/** What a correctly configured Signer reports for the executor (ADR-0055); EVM pins come back lowercase. */
const goodPins = {
  address: EXECUTOR,
  curve: 'secp256k1' as const,
  allowedSafe: SAFE.toLowerCase(),
  chainIds: [84532],
};
const pinned: PolicyRead = { kind: 'pins', pins: goodPins };
const NO_KEY: PolicyRead = { kind: 'no-key' };

type Overrides = {
  config?: Partial<BaseSafeConfig>;
  chain?: Partial<SafeOnChainState> | Error;
  about?: Error;
  info?: Partial<ServiceSafeInfo> | Error;
  delegates?: ServiceDelegate[] | Error;
  signer?: PolicyRead | Error;
};

function deps(o: Overrides = {}): SafeStartupDeps {
  const settle = <T>(value: T | Error): Promise<T> =>
    value instanceof Error ? Promise.reject(value) : Promise.resolve(value);
  return {
    config: { ...config, ...o.config },
    chainId: 84532,
    now: () => NOW,
    service: {
      about: () =>
        o.about
          ? Promise.reject(o.about)
          : Promise.resolve({ name: 'Safe Transaction Service', version: '6.12.0' }),
      getSafe: () => settle(o.info instanceof Error ? o.info : { ...goodInfo, ...o.info }),
      getDelegates: () => settle(o.delegates ?? [goodDelegate]),
    },
    readSafe: () => settle(o.chain instanceof Error ? o.chain : { ...goodChain, ...o.chain }),
    readSignerPins: () => settle(o.signer ?? pinned),
  };
}

async function failureOf(o: Overrides): Promise<SafeStartupError> {
  const error = await runSafeStartupChecks(deps(o)).catch((e: unknown) => e);
  expect(error).toBeInstanceOf(SafeStartupError);
  return error as SafeStartupError;
}

describe('runSafeStartupChecks', () => {
  it('starts on a valid setup and returns no warnings', async () => {
    expect(await runSafeStartupChecks(deps())).toEqual({ warnings: [] });
  });

  it('leaves the pin check to the worker in the API, which has no Signer (ADR-0059)', async () => {
    const withoutSigner = deps({ signer: NO_KEY });
    delete withoutSigner.readSignerPins;

    expect(await runSafeStartupChecks(withoutSigner)).toEqual({ warnings: [] });
  });

  it('accepts both supported versions and a registered delegate with a future expiry', async () => {
    await expect(
      runSafeStartupChecks(deps({ chain: { version: '1.3.0' } })),
    ).resolves.toBeDefined();
    await expect(
      runSafeStartupChecks(
        deps({ delegates: [{ ...goodDelegate, expiryDate: '2027-01-01T00:00:00Z' }] }),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a Safe with no code on this chain', async () => {
    const error = await failureOf({ chain: { hasCode: false } });
    expect(error.failures).toEqual([expect.objectContaining({ check: 'safe exists' })]);
    expect(error.message).toMatch(/no contract at .* on chain 84532/);
  });

  it('refuses an RPC on the wrong chain', async () => {
    const error = await failureOf({ chain: { chainId: 8453 } });
    expect(error.message).toMatch(/\[chain id\].*8453.*BASE_CHAIN_ID is 84532/);
  });

  it.each(['1.5.0', '1.2.0', ''])('refuses an unsupported version %j', async (version) => {
    const error = await failureOf({ chain: { version } });
    expect(error.message).toMatch(/\[safe version\].*only 1\.3\.0 and 1\.4\.1/);
  });

  it('refuses an executor that is an owner, whatever the address case', async () => {
    const error = await failureOf({
      chain: { owners: [OWNERS[0], EXECUTOR.toLowerCase() as `0x${string}`] },
    });
    expect(error.message).toMatch(/\[executor is not an owner\].*must never be able to approve/);
  });

  it('refuses an executor that is not a registered delegate and says how to register it', async () => {
    const error = await failureOf({ delegates: [] });
    expect(error.message).toMatch(/\[executor is a registered delegate\]/);
    expect(error.message).toMatch(/Delegate\(address delegateAddress, uint256 totp\)/);
    expect(error.message).toMatch(/chainId: 84532/);
    expect(error.message).toMatch(/422/);
  });

  it('refuses an expired delegate registration', async () => {
    const error = await failureOf({
      delegates: [{ ...goodDelegate, expiryDate: '2026-01-01T00:00:00Z' }],
    });
    expect(error.message).toMatch(/registration has expired/);
  });

  it('refuses when the Signer has no key for the executor', async () => {
    const error = await failureOf({ signer: NO_KEY });
    expect(error.message).toMatch(/\[signer can sign for the executor\].*no key for/);
  });

  it('refuses when the Signer is unreachable, including a read that throws', async () => {
    const unreachable: PolicyRead = { kind: 'unreachable', message: 'signer responded with 401' };
    expect((await failureOf({ signer: unreachable })).message).toMatch(
      /could not ask the Signer.*401.*SIGNER_AUTH_TOKEN/,
    );
    expect((await failureOf({ signer: new Error('boom') })).message).toMatch(
      /could not ask the Signer.*boom/,
    );
  });

  it('accepts the Safe pin whatever its case, since the Signer reports EVM pins lowercase', async () => {
    const pins = goodPins;
    await expect(
      runSafeStartupChecks(
        deps({
          signer: {
            kind: 'pins',
            pins: { ...pins, allowedSafe: SAFE.toUpperCase().replace('0X', '0x') },
          },
        }),
      ),
    ).resolves.toBeDefined();
  });

  it('refuses a key pinned to another Safe, to none, or not to this chain', async () => {
    const pins = goodPins;
    const other = '0x1111111111111111111111111111111111111111';
    const wrong = await failureOf({
      signer: { kind: 'pins', pins: { ...pins, allowedSafe: other } },
    });
    expect(wrong.failures).toEqual([expect.objectContaining({ check: 'signer pins the Safe' })]);
    expect(wrong.message).toContain(`pins ${other}`);
    expect(wrong.message).toContain(`BASE_SAFE_ADDRESS is ${SAFE}`);

    const noSafe = { address: EXECUTOR, curve: 'secp256k1' as const, chainIds: [84532] };
    expect((await failureOf({ signer: { kind: 'pins', pins: noSafe } })).message).toMatch(
      /pins no Safe/,
    );

    const otherChain = await failureOf({
      signer: { kind: 'pins', pins: { ...pins, chainIds: [8453] } },
    });
    expect(otherChain.message).toMatch(/allows chain 8453.*BASE_CHAIN_ID 84532/);
    const noChains = { address: EXECUTOR, curve: 'secp256k1' as const, allowedSafe: SAFE };
    expect((await failureOf({ signer: { kind: 'pins', pins: noChains } })).message).toMatch(
      /allows chain any/,
    );
  });

  it('refuses a Signer without the policy route, and tells the operator to upgrade it', async () => {
    const error = await failureOf({ signer: { kind: 'old-signer' } });
    expect(error.failures).toEqual([expect.objectContaining({ check: 'signer pins the Safe' })]);
    expect(error.message).toMatch(/older Signer.*upgrade the Signer/);
  });

  it('refuses when the service is down and still reports the chain-side checks it can make', async () => {
    const error = await failureOf({
      about: new SafeTxServiceError(
        'unreachable',
        'Safe Transaction Service at x is unreachable: connect ECONNREFUSED',
      ),
      chain: { owners: [EXECUTOR] },
    });
    expect(error.failures.map((f) => f.check)).toEqual([
      'service reachable',
      'executor is not an owner',
    ]);
  });

  it.each([
    [
      '401',
      new SafeTxServiceError(
        'unauthorized',
        'answered 401: it requires an API key, set BASE_SAFE_API_KEY',
        401,
      ),
    ],
    ['422', new SafeTxServiceError('rejected', 'refused the request with 422', 422)],
    [
      '429',
      new SafeTxServiceError(
        'rate-limited',
        'answered 429: the unauthenticated limit is exhausted',
        429,
      ),
    ],
  ])('surfaces a service %s clearly', async (status, cause) => {
    const error = await failureOf({ about: cause });
    expect(error.message).toContain(`[service reachable] ${cause.message}`);
    expect(error.message).toContain(status);
  });

  it('refuses a service that does not know the Safe: it probably serves another chain', async () => {
    const error = await failureOf({ info: new SafeTxServiceError('not-found', '404', 404) });
    expect(error.message).toMatch(/\[service matches chain\].*different chain/);
  });

  it('refuses a service whose owners or threshold disagree with the chain', async () => {
    expect((await failureOf({ info: { owners: [OWNERS[0]] } })).message).toMatch(
      /service matches chain/,
    );
    expect((await failureOf({ info: { threshold: 3 } })).message).toMatch(/service matches chain/);
  });

  it('reports every failed check at once', async () => {
    const error = await failureOf({
      chain: { version: '1.0.0', owners: [EXECUTOR] },
      delegates: [],
      signer: NO_KEY,
    });
    expect(error.failures.map((f) => f.check)).toEqual([
      'safe version',
      'executor is not an owner',
      'service matches chain', // the fake service still lists the original owners
      'executor is a registered delegate',
      'signer can sign for the executor',
    ]);
  });

  it('refuses when the chain read itself fails', async () => {
    const error = await failureOf({ chain: new Error('RPC down') });
    expect(error.message).toMatch(/\[safe readable\].*RPC down/);
  });

  describe('warnings (start anyway)', () => {
    it('warns on a threshold of 1', async () => {
      const { warnings } = await runSafeStartupChecks(
        deps({ chain: { threshold: 1 }, info: { threshold: 1 } }),
      );
      expect(warnings).toEqual([expect.stringMatching(/threshold of 1/)]);
    });

    it('warns on a guard', async () => {
      const { warnings } = await runSafeStartupChecks(deps({ chain: { guard: OWNERS[1] } }));
      expect(warnings).toEqual([expect.stringMatching(/has a guard/)]);
    });

    it('warns on modules', async () => {
      const { warnings } = await runSafeStartupChecks(deps({ chain: { modules: [OWNERS[2]] } }));
      expect(warnings).toEqual([expect.stringMatching(/1 module\(s\)/)]);
    });

    it('warns when no API key is configured, and never prints a key that is', async () => {
      const keyless = await runSafeStartupChecks(deps({ config: { apiKey: undefined } }));
      expect(keyless.warnings).toEqual([
        expect.stringMatching(/BASE_SAFE_API_KEY is not set.*2 requests\/second.*5,000\/month/),
      ]);

      const keyed = await runSafeStartupChecks(deps());
      expect(JSON.stringify(keyed)).not.toContain(API_KEY);
      const error = await failureOf({ delegates: [], signer: NO_KEY });
      expect(error.message).not.toContain(API_KEY);
    });
  });
});
