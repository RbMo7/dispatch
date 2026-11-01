import { describe, expect, it } from 'vitest';

import type { PolicyRead } from '../../signer/client.js';
import type { CheckContext } from '../check.js';
import { planChecks } from '../run.js';
import { CHECKS } from '../checks.js';
import {
  fakeContext,
  goodEnv,
  result,
  SOLANA_SENDER,
  token,
} from '../test-support/fake-context.js';

function answering(read: PolicyRead, env = goodEnv()): CheckContext {
  return fakeContext(env, { signer: { readPins: () => Promise.resolve(read) } });
}

describe('Signer: Reachable', () => {
  it('passes when the Signer answers a policy read', async () => {
    expect(await result(fakeContext(), 'signer.reachable')).toEqual({
      status: 'pass',
      finding: 'the Signer at SIGNER_URL (localhost:8421) answered and accepted SIGNER_AUTH_TOKEN',
    });
  });

  it('passes for a Signer that has no key for the address: it answered', async () => {
    expect((await result(answering({ kind: 'no-key' }), 'signer.reachable')).status).toBe('pass');
  });

  it('fails a refused token, pointing at SIGNER_AUTH_TOKEN', async () => {
    const read: PolicyRead = {
      kind: 'unreachable',
      message: 'signer responded with 401',
      status: 401,
    };

    expect(await result(answering(read), 'signer.reachable')).toEqual({
      status: 'fail',
      finding: 'the Signer at SIGNER_URL (localhost:8421) refused SIGNER_AUTH_TOKEN',
      fix: {
        setting: 'SIGNER_AUTH_TOKEN',
        value: "the same value as the Signer's own SIGNER_AUTH_TOKEN",
      },
    });
  });

  it('fails a Signer that does not answer, with the command that starts it', async () => {
    const secret = token();
    const signerUrl = `http://ops:${secret}@signer.internal:8421`;
    const read: PolicyRead = {
      kind: 'unreachable',
      message: `failed to reach signer at ${signerUrl}: connect ECONNREFUSED`,
    };

    const checked = await result(
      answering(read, goodEnv({ SIGNER_URL: signerUrl })),
      'signer.reachable',
    );

    expect(checked).toEqual({
      status: 'fail',
      finding: 'no Signer answered at SIGNER_URL (signer.internal:8421)',
      fix: { command: 'docker compose up -d signer' },
    });
  });

  it('fails without SIGNER_AUTH_TOKEN, before asking', async () => {
    expect(
      await result(fakeContext(goodEnv({ SIGNER_AUTH_TOKEN: undefined })), 'signer.reachable'),
    ).toMatchObject({ status: 'fail', fix: { setting: 'SIGNER_AUTH_TOKEN' } });
  });

  it('warns when no chain has a Sender to ask about', async () => {
    expect(
      await result(fakeContext(goodEnv({ ENABLED_CHAINS: '' })), 'signer.reachable'),
    ).toMatchObject({ status: 'warn', fix: { setting: 'ENABLED_CHAINS' } });
  });
});

describe('Signer: Key held', () => {
  it('passes when the Signer holds the Sender key', async () => {
    expect(await result(fakeContext(), 'signer.key:solana')).toEqual({
      status: 'pass',
      finding: `the Signer holds the ed25519 key for ${SOLANA_SENDER}`,
    });
  });

  it('fails when the Signer has no key, naming the address to add', async () => {
    const checked = await result(answering({ kind: 'no-key' }), 'signer.key:solana');

    expect(checked).toMatchObject({ status: 'fail' });
    expect(checked.status !== 'pass' && 'step' in checked.fix && checked.fix.step).toContain(
      `Add ${SOLANA_SENDER} to the Signer's config`,
    );
  });

  it('warns about a Signer too old to say', async () => {
    expect(await result(answering({ kind: 'old-signer' }), 'signer.key:solana')).toMatchObject({
      status: 'warn',
      finding: 'the Signer is too old to say which keys it holds (ADR-0055)',
    });
  });

  it('warns that it could not check when the Signer is down', async () => {
    const read: PolicyRead = { kind: 'unreachable', message: 'failed to reach signer at x' };

    expect(await result(answering(read), 'signer.key:solana')).toMatchObject({
      status: 'warn',
      fix: { command: 'docker compose up -d signer' },
    });
  });
});

describe('Signer: Pinned', () => {
  it('runs only for a Multisig Sender', () => {
    expect(planChecks(CHECKS, fakeContext(), { place: 'cli' }).map((p) => p.id)).not.toContain(
      'signer.pinned:solana',
    );
  });
});

describe('Signer: Not reachable from the API', () => {
  it("passes when Compose blanks the API's Signer settings", async () => {
    expect(await result(fakeContext(), 'signer.api')).toEqual({
      status: 'pass',
      finding: "neither SIGNER_URL nor SIGNER_AUTH_TOKEN is set in Compose's api service",
    });
  });

  it('fails when Compose gives the API a Signer token, never showing it', async () => {
    const secret = token();
    const checked = await result(
      fakeContext(goodEnv(), {
        apiEnvironment: () =>
          Promise.resolve({
            source: 'compose',
            env: { SIGNER_URL: '', SIGNER_AUTH_TOKEN: secret },
          }),
      }),
      'signer.api',
    );

    expect(checked).toEqual({
      status: 'fail',
      finding:
        "SIGNER_AUTH_TOKEN is set in Compose's api service, so the API could reach the Signer (ADR-0059)",
      fix: { setting: "SIGNER_AUTH_TOKEN in docker-compose.yml's api service", value: "''" },
    });
  });

  it('fails when the environment the API starts with here has both', async () => {
    expect(
      await result(
        fakeContext(goodEnv(), {
          apiEnvironment: () =>
            Promise.resolve({
              source: 'process',
              env: { SIGNER_URL: 'http://localhost:8421', SIGNER_AUTH_TOKEN: token() },
            }),
        }),
        'signer.api',
      ),
    ).toMatchObject({ status: 'fail', fix: { setting: 'SIGNER_URL, SIGNER_AUTH_TOKEN' } });
  });
});
