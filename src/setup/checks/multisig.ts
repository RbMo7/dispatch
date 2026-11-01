import type { Config } from '../../config.js';
import { fail, pass, warn, type Check, type Fix, type MultisigStartup } from '../check.js';
import type { MultisigSetup } from '../settings.js';
import { notCheckedFinding, redactUrls } from '../wording.js';

/** Which setup check reports a startup check's failure. `signer` failures belong to Signer: Key held. */
type Home = 'account' | 'member' | 'pinned' | 'signer';

type Entry = { home: Home; fix: (multisig: MultisigSetup, config: Config) => Fix };

const squadsAccount: Entry = {
  home: 'account',
  fix: () => ({
    setting: 'SOLANA_MULTISIG_ADDRESS',
    value: 'the Squads v4 multisig account (not its vault) on the cluster SOLANA_RPC_URL serves',
  }),
};
const squadsPermissions: Entry = {
  home: 'member',
  fix: (m) => ({
    step: `In the Squads app, give ${engineKey(m)} exactly the Initiate and Execute permissions (mask 5), never Vote`,
  }),
};
const safeAccount: Entry = {
  home: 'account',
  fix: () => ({
    setting: 'BASE_SAFE_ADDRESS',
    value: 'a Safe 1.3.0 or 1.4.1 on the chain BASE_RPC_URL serves',
  }),
};
const keyMissing: Entry = {
  home: 'signer',
  fix: (m) => ({
    step: `Add ${engineKey(m)} to the Signer's config, pinned to ${multisigAddress(m)} (docs/signer.md)`,
  }),
};

/**
 * The startup checks' own names (ADR-0049, ADR-0051, ADR-0055), each mapped
 * to the setup check that reports it. A name missing here still reports,
 * under Account exists, so a renamed startup check is never dropped.
 */
const STARTUP_CHECKS: Record<string, Entry> = {
  'sender is the vault': {
    home: 'account',
    fix: () => ({
      setting: 'SOLANA_SENDER_ADDRESS',
      value: 'empty, so the engine pays from the vault',
    }),
  },
  'multisig readable': squadsAccount,
  'multisig exists': squadsAccount,
  'multisig owned by Squads v4': squadsAccount,
  'member is in the multisig': {
    home: 'member',
    fix: (m) => ({
      step: `In the Squads app, add ${engineKey(m)} as a member with Initiate and Execute only`,
    }),
  },
  'member cannot vote': squadsPermissions,
  'member can initiate and execute': squadsPermissions,
  'member permission mask is exactly 5': squadsPermissions,
  'signer can sign for the member': keyMissing,
  'signer pins the multisig': {
    home: 'pinned',
    fix: (m) => ({
      step: `In the Signer's config, set policy.allowedMultisig to ${multisigAddress(m)} for ${engineKey(m)}, then restart the Signer (docs/signer.md)`,
    }),
  },
  'service reachable': {
    home: 'account',
    fix: () => ({
      setting: 'BASE_SAFE_TX_SERVICE_URL',
      value: 'a Safe Transaction Service for this chain that answers',
    }),
  },
  'safe readable': safeAccount,
  'chain id': safeAccount,
  'safe exists': safeAccount,
  'safe version': safeAccount,
  'service matches chain': safeAccount,
  'executor is not an owner': {
    home: 'member',
    fix: (m) => ({
      step: `In the Safe app, remove ${engineKey(m)} from the owners: the engine's key must never approve`,
    }),
  },
  'executor is a registered delegate': {
    home: 'member',
    fix: (m) => ({
      step: `Have a Safe owner register ${engineKey(m)} as a delegate of ${multisigAddress(m)} (docs/multisig.md)`,
    }),
  },
  'signer can sign for the executor': keyMissing,
  'signer pins the Safe': {
    home: 'pinned',
    fix: (m, config) => ({
      step: `In the Signer's config, set policy.allowedSafe to ${multisigAddress(m)} and policy.chainIds to include ${config.base.chainId} for ${engineKey(m)}, then restart the Signer (docs/signer.md)`,
    }),
  },
};

const UNKNOWN: Entry = { home: 'account', fix: () => ({ step: 'See docs/multisig.md' }) };

function entryFor(check: string): Entry {
  return STARTUP_CHECKS[check] ?? UNKNOWN;
}

function engineKey(multisig: MultisigSetup): string {
  return multisig.kind === 'squads'
    ? multisig.config.memberAddress
    : multisig.config.executorAddress;
}

function multisigAddress(multisig: MultisigSetup): string {
  return multisig.kind === 'squads' ? multisig.config.multisigAddress : multisig.config.safeAddress;
}

export function multisigFailures(
  startup: MultisigStartup,
  home: Home,
): MultisigStartup['failures'] {
  return startup.failures.filter((failure) => entryFor(failure.check).home === home);
}

export function multisigFix(check: string, multisig: MultisigSetup, config: Config): Fix {
  return entryFor(check).fix(multisig, config);
}

export const multisigAccount: Check = {
  id: 'multisig.account',
  area: 'multisig',
  title: 'Account exists',
  runsIn: ['cli', 'worker'],
  scope: 'chain',
  appliesTo: (setup) => setup.multisig !== undefined,
  run: async (context, setup) => {
    const multisig = setup.multisig!;
    const startup = await context.multisigStartup(setup);
    const failures = multisigFailures(startup, 'account');
    const [first] = failures;
    if (first) {
      return fail(
        redactUrls(failures.map((f) => f.message).join('; ')),
        multisigFix(first.check, multisig, context.config),
      );
    }
    if (startup.warnings.length > 0) {
      return warn(redactUrls(startup.warnings.join('; ')), {
        step: 'Review the multisig settings named above (docs/multisig.md)',
      });
    }
    return pass(
      multisig.kind === 'squads'
        ? `the Squads multisig ${multisig.config.multisigAddress} exists, and its vault ${setup.sender!.address} is the Sender`
        : `the Safe ${multisig.config.safeAddress} exists on chain ${context.config.base.chainId}`,
    );
  },
};

export const multisigMember: Check = {
  id: 'multisig.member',
  area: 'multisig',
  title: 'Engine key is member or delegate',
  runsIn: ['cli', 'worker'],
  scope: 'chain',
  appliesTo: (setup) => setup.multisig !== undefined,
  run: async (context, setup) => {
    const multisig = setup.multisig!;
    const startup = await context.multisigStartup(setup);
    const failures = multisigFailures(startup, 'member');
    const [first] = failures;
    if (first) {
      return fail(
        redactUrls(failures.map((f) => f.message).join('; ')),
        multisigFix(first.check, multisig, context.config),
      );
    }
    const [unread] = multisigFailures(startup, 'account');
    if (unread) {
      return warn(
        notCheckedFinding('the multisig could not be read (see Multisig: Account exists)'),
        multisigFix(unread.check, multisig, context.config),
      );
    }
    return pass(
      multisig.kind === 'squads'
        ? `${engineKey(multisig)} is a member with Initiate and Execute only`
        : `${engineKey(multisig)} is a registered delegate and not an owner`,
    );
  },
};
