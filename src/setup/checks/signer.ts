import type { Config } from '../../config.js';
import type { PolicyRead } from '../../signer/client.js';
import { fail, pass, warn, type Check, type CheckResult, type Fix } from '../check.js';
import { hostOf, notCheckedFinding, redactUrls } from '../wording.js';
import { multisigFailures, multisigFix } from './multisig.js';

const TOKEN_FIX: Fix = {
  setting: 'SIGNER_AUTH_TOKEN',
  value: "the same value as the Signer's own SIGNER_AUTH_TOKEN",
};
const START_SIGNER: Fix = { command: 'docker compose up -d signer' };
const NO_SIGNER = notCheckedFinding('this place has no Signer');

function signerAt(config: Config): string {
  return `SIGNER_URL (${hostOf(config.signerUrl)})`;
}

/** What a failed policy read says about the Signer itself, apart from any one key. */
function judgeAnswer(read: PolicyRead, config: Config): CheckResult {
  const where = signerAt(config);
  if (read.kind !== 'unreachable') {
    return pass(`the Signer at ${where} answered and accepted SIGNER_AUTH_TOKEN`);
  }
  if (read.status === 401)
    return fail(`the Signer at ${where} refused SIGNER_AUTH_TOKEN`, TOKEN_FIX);
  if (read.status !== undefined) {
    return fail(`the Signer at ${where} answered with HTTP ${read.status}`, START_SIGNER);
  }
  if (read.message.startsWith('failed to reach')) {
    return fail(`no Signer answered at ${where}`, START_SIGNER);
  }
  return fail(
    `the Signer at ${where} gave an answer it could not read: ${redactUrls(read.message)}`,
    {
      step: 'Point SIGNER_URL at the Signer, not at another service',
    },
  );
}

export const signerReachable: Check = {
  id: 'signer.reachable',
  area: 'signer',
  title: 'Reachable',
  runsIn: ['cli', 'worker'],
  scope: 'engine',
  run: async ({ config, settings, signer }) => {
    if (!signer) return warn(NO_SIGNER, START_SIGNER);
    if (config.signerAuthToken === undefined) {
      return fail('SIGNER_AUTH_TOKEN is not set, so the Signer refuses every request', TOKEN_FIX);
    }
    // The policy read is the one Signer route that never signs, so it is the probe.
    const key = settings.senders.find((setup) => setup.accounts)?.accounts?.feePayer;
    if (key === undefined) {
      return warn(notCheckedFinding('no enabled chain has a Sender to ask the Signer about'), {
        setting: 'ENABLED_CHAINS',
        value: 'solana, base, or solana,base, each with its Sender address',
      });
    }
    return judgeAnswer(await signer.readPins(key), config);
  },
};

export const signerKeyHeld: Check = {
  id: 'signer.key',
  area: 'signer',
  title: 'Key held',
  runsIn: ['cli', 'worker'],
  scope: 'sender',
  appliesTo: (setup) => setup.accounts !== undefined,
  run: async ({ config, signer }, { accounts }) => {
    if (!signer) return warn(NO_SIGNER, START_SIGNER);
    const key = accounts!.feePayer;
    const read = await signer.readPins(key);
    switch (read.kind) {
      case 'pins':
        return pass(`the Signer holds the ${read.pins.curve} key for ${key}`);
      case 'no-key':
        return fail(`the Signer has no key for ${key}`, {
          step: `Add ${key} to the Signer's config (SIGNER_CONFIG) with its key backend, then restart the Signer (docs/self-hosting/signer.md)`,
        });
      case 'old-signer':
        return warn('the Signer is too old to say which keys it holds (ADR-0055)', {
          step: 'Upgrade the Signer to the release this engine came with',
        });
      case 'unreachable': {
        const answer = judgeAnswer(read, config);
        return warn(
          notCheckedFinding('the Signer could not be asked (see Signer: Reachable)'),
          answer.status === 'pass' ? START_SIGNER : answer.fix,
        );
      }
    }
  },
};

export const signerPinned: Check = {
  id: 'signer.pinned',
  area: 'signer',
  title: 'Pinned',
  runsIn: ['cli', 'worker'],
  scope: 'sender',
  appliesTo: (setup) => setup.multisig !== undefined,
  run: async (context, setup) => {
    if (!context.signer) return warn(NO_SIGNER, START_SIGNER);
    const startup = await context.multisigStartup(setup);
    const multisig = setup.multisig!;
    const key = setup.accounts!.feePayer;
    const pinned = multisigFailures(startup, 'pinned');
    const [first] = pinned;
    if (first) {
      return fail(
        redactUrls(pinned.map((f) => f.message).join('; ')),
        multisigFix(first.check, setup, context),
      );
    }
    const [unanswered] = multisigFailures(startup, 'signer');
    if (unanswered) {
      return warn(
        notCheckedFinding(`the Signer did not answer for ${key} (see Signer: Key held)`),
        multisigFix(unanswered.check, setup, context),
      );
    }
    const to =
      multisig.kind === 'squads' ? multisig.config.multisigAddress : multisig.config.safeAddress;
    return pass(`the Signer pins ${key} to ${to}`);
  },
};

const SIGNER_SETTINGS = ['SIGNER_URL', 'SIGNER_AUTH_TOKEN'];

export const signerNotInApi: Check = {
  id: 'signer.api',
  area: 'signer',
  title: 'Not reachable from the API',
  // Only the CLI can see how the API is started; the worker's own environment rightly has both.
  runsIn: ['cli'],
  scope: 'engine',
  run: async ({ apiEnvironment }) => {
    const api = await apiEnvironment();
    const where =
      api.source === 'compose'
        ? "Compose's api service"
        : 'the environment the API starts with here (.env and the shell)';
    const set = SIGNER_SETTINGS.filter((name) => (api.env[name] ?? '') !== '');
    if (set.length === 0)
      return pass(`neither SIGNER_URL nor SIGNER_AUTH_TOKEN is set in ${where}`);
    return fail(
      `${set.join(' and ')} ${set.length === 1 ? 'is' : 'are'} set in ${where}, so the API could reach the Signer (ADR-0059)`,
      api.source === 'compose'
        ? { setting: `${set.join(', ')} in docker-compose.yml's api service`, value: "''" }
        : {
            setting: set.join(', '),
            value: 'unset where the API runs; only the worker needs them',
          },
    );
  },
};
