import type { PolicyRead } from '../../../signer/client.js';
import {
  PERMISSION_EXECUTE,
  PERMISSION_INITIATE,
  PERMISSION_VOTE,
  type MultisigOnChainState,
} from './multisig-account.js';
import {
  deriveVaultAddress,
  parsePublicKey,
  SQUADS_PROGRAM_ID,
  type SolanaMultisigConfig,
} from './multisig-config.js';

/** What the engine's member key must hold: Initiate + Execute, and never Vote. */
export const REQUIRED_MEMBER_PERMISSIONS = PERMISSION_INITIATE | PERMISSION_EXECUTE;

/** ADR-0055: a Signer without the policy route cannot be checked, and is refused rather than trusted. */
const OLD_SIGNER_MESSAGE =
  'the Signer has no policy route, so it is an older Signer that cannot say what its keys are pinned to: upgrade the Signer (ADR-0055)';

export type MultisigStartupDeps = {
  config: SolanaMultisigConfig;
  /** The Sender address the Chain Handler will pay from (SOLANA_SENDER_ADDRESS or the derived vault). */
  senderAddress: string;
  /** Reads the multisig account, at one slot (multisig-account.ts). */
  readMultisig: (address: string) => Promise<MultisigOnChainState>;
  /** ADR-0055: what the Signer says the member's key is pinned to. Absent in the API, which never calls the Signer (ADR-0059); the worker checks it. */
  readSignerPins?: (member: string) => Promise<PolicyRead>;
};

/** One thing wrong that stops startup: `check` names it, so an operator can tell which. */
export type MultisigStartupFailure = { check: string; message: string };

export class MultisigStartupError extends Error {
  constructor(readonly failures: MultisigStartupFailure[]) {
    super(
      `Solana multisig sender startup checks failed (nothing was sent):\n${failures.map((f) => `  - [${f.check}] ${f.message}`).join('\n')}`,
    );
    this.name = 'MultisigStartupError';
  }
}

/**
 * ADR-0049: fails loudly, before anything is sent, on a multisig the engine
 * cannot safely act for. Throws `MultisigStartupError` listing every failed
 * check; on success returns the warnings (data, so the caller logs them).
 */
export async function runMultisigStartupChecks(
  deps: MultisigStartupDeps,
): Promise<{ warnings: string[] }> {
  const { config } = deps;
  const failures: MultisigStartupFailure[] = [];
  const warnings: string[] = [];
  const fail = (check: string, message: string) => failures.push({ check, message });

  const vault = deriveVaultAddress(parsePublicKey(config.multisigAddress)!).toBase58();
  if (vault !== config.vaultAddress || deps.senderAddress !== vault) {
    fail(
      'sender is the vault',
      `the Sender address is ${deps.senderAddress} but the multisig's vault is ${vault}: in multisig mode the vault is the Sender`,
    );
  }

  let state: MultisigOnChainState | undefined;
  try {
    state = await deps.readMultisig(config.multisigAddress);
  } catch (cause) {
    fail(
      'multisig readable',
      `could not read the multisig ${config.multisigAddress} from the Solana RPC: ${errorText(cause)}`,
    );
  }

  if (state) {
    const account = state.account;
    if (account === undefined) {
      fail(
        'multisig exists',
        `no account at ${config.multisigAddress}: SOLANA_MULTISIG_ADDRESS is wrong, or the multisig lives on another cluster than SOLANA_RPC_URL`,
      );
    } else if (account.owner !== SQUADS_PROGRAM_ID.toBase58()) {
      fail(
        'multisig owned by Squads v4',
        `${config.multisigAddress} is owned by ${account.owner}, not the Squads v4 program ${SQUADS_PROGRAM_ID.toBase58()}: SOLANA_MULTISIG_ADDRESS must be the multisig account (not its vault, and not a v3 multisig)`,
      );
    } else if ('undecodable' in account.multisig) {
      fail(
        'multisig readable',
        `${config.multisigAddress} is owned by Squads v4 but is not a Multisig account: ${account.multisig.undecodable}`,
      );
    } else {
      const multisig = account.multisig;
      const member = multisig.members.find((m) => m.key === config.memberAddress);
      if (!member) {
        fail(
          'member is in the multisig',
          `SOLANA_MULTISIG_MEMBER_ADDRESS ${config.memberAddress} is not a member of ${config.multisigAddress}: add it as a member with the Initiate and Execute permissions (and nothing else)`,
        );
      } else {
        if ((member.permissions & PERMISSION_VOTE) !== 0) {
          fail(
            'member cannot vote',
            `the engine's member ${config.memberAddress} holds the Vote permission (mask ${member.permissions}). The engine's key must never be able to approve: give it exactly Initiate + Execute (mask ${REQUIRED_MEMBER_PERMISSIONS}).`,
          );
        }
        const missing = [
          (member.permissions & PERMISSION_INITIATE) === 0 ? 'Initiate' : undefined,
          (member.permissions & PERMISSION_EXECUTE) === 0 ? 'Execute' : undefined,
        ].filter((name) => name !== undefined);
        if (missing.length > 0) {
          fail(
            'member can initiate and execute',
            `the engine's member ${config.memberAddress} lacks the ${missing.join(' and ')} permission (mask ${member.permissions}): it needs exactly Initiate + Execute (mask ${REQUIRED_MEMBER_PERMISSIONS}) to propose and execute payments`,
          );
        }
        // Bits beyond Initiate/Vote/Execute do not exist in v4; a mask that still differs is wrong.
        if (
          (member.permissions & PERMISSION_VOTE) === 0 &&
          missing.length === 0 &&
          member.permissions !== REQUIRED_MEMBER_PERMISSIONS
        ) {
          fail(
            'member permission mask is exactly 5',
            `the engine's member ${config.memberAddress} has permission mask ${member.permissions}, expected exactly ${REQUIRED_MEMBER_PERMISSIONS} (Initiate + Execute)`,
          );
        }
      }

      if (multisig.threshold === 1) {
        warnings.push(
          'the multisig has a threshold of 1: a single Approver approves every payment, so the multisig adds no second approver',
        );
      }
      const voters = multisig.members.filter((m) => (m.permissions & PERMISSION_VOTE) !== 0).length;
      if (multisig.threshold > voters) {
        warnings.push(
          `the multisig's threshold (${multisig.threshold}) is higher than its number of voting members (${voters}): no proposal can ever be approved`,
        );
      }
      if (multisig.rentCollector === undefined) {
        warnings.push(
          'the multisig has no rent collector: the rent the engine pays to propose each payment (about 0.005 SOL for one transfer) can never be reclaimed, since closing a finished proposal fails with RentReclamationDisabled (6032). Set the rent collector to the engine member key.',
        );
      } else if (multisig.rentCollector !== config.memberAddress) {
        warnings.push(
          `the multisig's rent collector is ${multisig.rentCollector}, not the engine's member key ${config.memberAddress}: proposal rent will be refunded there, not to the engine`,
        );
      }
      if (multisig.timeLockSeconds * 1000 > config.approvalDeadlineMs) {
        warnings.push(
          `the multisig's time lock (${multisig.timeLockSeconds}s) is longer than SOLANA_APPROVAL_DEADLINE_MS (${config.approvalDeadlineMs}ms): an approved proposal may not be executable before its Calls are abandoned`,
        );
      }
    }
  }

  const signer = await deps
    .readSignerPins?.(config.memberAddress)
    .catch((cause: unknown): PolicyRead => ({ kind: 'unreachable', message: errorText(cause) }));
  if (signer === undefined) {
    // The API: the worker reads the pins and refuses to start on them.
  } else if (signer.kind === 'no-key') {
    fail(
      'signer can sign for the member',
      `the Signer has no key for ${config.memberAddress}: add it to the Signer's config (docs/signer.md), pinned to the multisig by policy`,
    );
  } else if (signer.kind === 'unreachable') {
    fail(
      'signer can sign for the member',
      `could not ask the Signer about ${config.memberAddress}: ${signer.message} (SIGNER_URL, SIGNER_AUTH_TOKEN)`,
    );
  } else if (signer.kind === 'old-signer') {
    fail('signer pins the multisig', OLD_SIGNER_MESSAGE);
  } else if (signer.pins.allowedMultisig !== config.multisigAddress) {
    fail(
      'signer pins the multisig',
      `the Signer's policy for ${config.memberAddress} pins ${signer.pins.allowedMultisig ?? 'no multisig'}, but SOLANA_MULTISIG_ADDRESS is ${config.multisigAddress}: set policy.allowedMultisig for this key in the Signer's config (docs/signer.md)`,
    );
  }

  if (failures.length > 0) throw new MultisigStartupError(failures);
  return { warnings };
}

function errorText(cause: unknown): string {
  return cause instanceof Error ? cause.message : String(cause);
}
