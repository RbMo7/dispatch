import { CHAINS } from '../../domain/chain.js';
import { fail, pass, warn, type Check, type CheckResult, type Fix } from '../check.js';
import { senderVariable, type Settings } from '../settings.js';

export const DEV_AUTH_TOKEN = 'dev-secret';
export const MIN_TOKEN_LENGTH = 32;
const TOKEN_VALUE = `a random value of at least ${MIN_TOKEN_LENGTH} characters, such as the output of \`openssl rand -hex 32\``;

export const environmentParses: Check = {
  id: 'configuration.environment',
  area: 'configuration',
  title: 'Environment parses',
  runsIn: ['cli', 'worker'],
  scope: 'engine',
  run: ({ settings }) => {
    const { problems } = settings;
    if (problems.length === 0) return pass('every setting parsed');
    const variables = [
      ...new Set(problems.flatMap((problem) => problem.match(/\b[A-Z][A-Z0-9_]{2,}\b/)?.[0] ?? [])),
    ];
    return fail(`${plural(problems.length, 'problem')}: ${problems.join('; ')}`, {
      setting: variables.join(', ') || 'the settings named above',
      value: 'a valid value; .env.example describes each one',
    });
  },
};

export const tokens: Check = {
  id: 'configuration.tokens',
  area: 'configuration',
  title: 'Tokens',
  runsIn: ['cli', 'worker'],
  scope: 'engine',
  run: ({ env }) => judgeTokens(env.AUTH_TOKEN, env.OPERATOR_TOKEN),
};

/** Every token rule at once, worst first. A finding names a token and never shows it. */
function judgeTokens(auth: string | undefined, operator: string | undefined): CheckResult {
  const authFix: Fix = { setting: 'AUTH_TOKEN', value: TOKEN_VALUE };
  const operatorFix: Fix = { setting: 'OPERATOR_TOKEN', value: `${TOKEN_VALUE}, not AUTH_TOKEN` };
  const failures: { finding: string; fix: Fix }[] = [];

  if (auth === undefined || auth === '' || auth === DEV_AUTH_TOKEN) {
    failures.push({ finding: 'AUTH_TOKEN is the development default', fix: authFix });
  } else if (auth.length < MIN_TOKEN_LENGTH) {
    failures.push({
      finding: `AUTH_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters`,
      fix: authFix,
    });
  }
  if (operator !== undefined && operator !== '') {
    if (operator === auth) {
      failures.push({ finding: 'OPERATOR_TOKEN is the same as AUTH_TOKEN', fix: operatorFix });
    } else if (operator.length < MIN_TOKEN_LENGTH) {
      failures.push({
        finding: `OPERATOR_TOKEN is shorter than ${MIN_TOKEN_LENGTH} characters`,
        fix: operatorFix,
      });
    }
  }

  const [first] = failures;
  if (first) return fail(failures.map((f) => f.finding).join('; '), first.fix);
  if (operator === undefined || operator === '') {
    return warn(
      'OPERATOR_TOKEN is not set, so the console is read-only and no Flag Rule can hold a Dispatch (ADR-0057)',
      operatorFix,
    );
  }
  return pass(
    `AUTH_TOKEN and OPERATOR_TOKEN are distinct and at least ${MIN_TOKEN_LENGTH} characters`,
  );
}

export const enabledChains: Check = {
  id: 'configuration.chains',
  area: 'configuration',
  title: 'Enabled chains',
  runsIn: ['cli', 'worker'],
  scope: 'engine',
  run: ({ env, config, settings }) => {
    const enabled = settings.enabledChains;
    const senders = { solana: config.solana.senderAddress, base: config.base.senderAddress };
    if (enabled.length === 0) {
      return warn('ENABLED_CHAINS names no chain, so the engine sends nothing', {
        setting: 'ENABLED_CHAINS',
        value: 'solana, base, or solana,base',
      });
    }
    if (settings.sendersFile !== undefined) return judgeSendersFile(settings);
    const missing = enabled.filter((chain) => senders[chain].trim() === '');
    const [firstMissing] = missing;
    if (firstMissing) {
      return fail(
        missing
          .map((chain) => `${chain} is enabled but ${senderVariable(chain)} is empty`)
          .join('; '),
        {
          setting: senderVariable(firstMissing),
          value: "the Sender's address, which the Signer holds a key for",
        },
      );
    }
    // The raw variable, not config's: a multisig Sender's address is derived even when its chain is off.
    const stray = CHAINS.filter(
      (chain) => !enabled.includes(chain) && (env[senderVariable(chain)] ?? '').trim() !== '',
    );
    if (stray.length > 0) {
      return warn(
        stray
          .map((chain) => `${senderVariable(chain)} is set but ${chain} is not in ENABLED_CHAINS`)
          .join('; '),
        { setting: 'ENABLED_CHAINS', value: [...enabled, ...stray].join(',') },
      );
    }
    return pass(enabled.map((chain) => `${chain} sends from ${senders[chain]}`).join('; '));
  },
};

/** ADR-0060: with a senders file, each enabled chain needs a Sender in it, and the per-chain Sender variables are ignored. */
function judgeSendersFile(settings: Settings): CheckResult {
  const file = settings.sendersFile!;
  const missing = settings.enabledChains.filter(
    (chain) => !settings.senders.some((sender) => sender.chain === chain),
  );
  if (missing.length > 0) {
    return fail(
      `the senders file ${file} gives ${missing.join(' and ')} no Sender (see Environment parses)`,
      { step: `Fix ${file}; senders.example.json shows the shape` },
    );
  }
  if (settings.warnings.length > 0) {
    const ignored = [
      ...new Set(settings.warnings.flatMap((w) => w.match(/\b[A-Z][A-Z0-9_]{2,}\b/g) ?? [])),
    ];
    return warn(settings.warnings.join('; '), {
      setting: ignored.join(', '),
      value: `empty: the senders file ${file} describes the Senders`,
    });
  }
  return pass(
    settings.enabledChains
      .map((chain) => {
        const senders = settings.senders.filter((sender) => sender.chain === chain);
        const listed = senders.map(
          (s) =>
            `${s.name} (${s.accounts?.address ?? 'not parsed'}${s.isDefault ? ', the default' : ''})`,
        );
        const noDefault = senders.some((s) => s.isDefault)
          ? ''
          : '; no default, so each Dispatch names its Sender';
        return `${chain} sends from ${listed.join(', ')}${noDefault}`;
      })
      .join('; '),
  );
}

export function plural(count: number, noun: string): string {
  return `${count} ${noun}${count === 1 ? '' : 's'}`;
}
