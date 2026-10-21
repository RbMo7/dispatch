import { VersionedMessage } from '@solana/web3.js';

import { SOLANA_PROGRAMS } from './effects.js';

export type SquadsDecision = { ok: true } | { ok: false; reason: string };

/** Squads v4 on mainnet and devnet (spike #70). */
export const SQUADS_PROGRAM = 'SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf';

/** The only Squads instructions the engine's member key sends (ADR-0049), by Anchor discriminator. */
const ALLOWED_INSTRUCTIONS: ReadonlyMap<string, string> = new Map([
  ['30fa4ea8d0e2dad3', 'vaultTransactionCreate'],
  ['dc3c49e01e6c4f9f', 'proposalCreate'],
  ['c208a15799a419ab', 'vaultTransactionExecute'],
  ['c447bbb00223aaa5', 'vaultTransactionAccountsClose'],
]);

/** Named only so a refusal says what it refused; anything else not allowed is refused as unrecognized. */
const REFUSED_INSTRUCTIONS: ReadonlyMap<string, string> = new Map([
  ['9025a488bcd82af8', 'proposalApprove'],
  ['f33e869ce66af687', 'proposalReject'],
  ['cd29c23ddc8b10f7', 'proposalCancelV2'],
  ['1b2a7fed26a354cb', 'proposalCancel'],
]);

/** ComputeBudget instructions that ride along: requestHeapFrame, setComputeUnitLimit, setComputeUnitPrice. */
const COMPUTE_BUDGET_INSTRUCTIONS: ReadonlySet<number> = new Set([1, 2, 3]);

/**
 * Checks a Solana message against `allowedMultisig`: only the four Squads
 * instructions above, each on the pinned multisig (its first account), plus
 * the ComputeBudget instructions that accompany them, and the signing address
 * must pay the fee. Anything else, or anything the decoder can't read, is
 * refused. Nested payments are not decoded: the Approvers' vote is the
 * control (ADR-0049).
 */
export function checkMultisigMessage(
  multisig: string,
  signer: string | undefined,
  unsigned: Uint8Array,
): SquadsDecision {
  const refuse = (reason: string): SquadsDecision => ({ ok: false, reason });

  let message: VersionedMessage;
  try {
    message = VersionedMessage.deserialize(unsigned);
  } catch (cause) {
    const detail = cause instanceof Error ? cause.message : String(cause);
    return refuse(`undecodable transaction: not a Solana message: ${detail}`);
  }
  if (!Buffer.from(message.serialize()).equals(Buffer.from(unsigned))) {
    return refuse(
      'undecodable transaction: the Solana message has bytes its decoding does not account for',
    );
  }

  const keys = message.staticAccountKeys;
  if (signer === undefined || keys[0]?.toBase58() !== signer) {
    return refuse('the fee payer is not the signing address');
  }

  let squads = 0;
  for (const instruction of message.compiledInstructions) {
    const program = keys[instruction.programIdIndex]?.toBase58();
    if (program === undefined) {
      return refuse(
        'undecodable transaction: an instruction names its program through a lookup table',
      );
    }
    const data = Buffer.from(instruction.data);

    if (program === SOLANA_PROGRAMS.computeBudget) {
      if (!COMPUTE_BUDGET_INSTRUCTIONS.has(data[0] ?? -1)) {
        return refuse(
          `ComputeBudget instruction ${data[0] ?? '(empty)'} is not allowed with allowedMultisig`,
        );
      }
      continue;
    }
    if (program !== SQUADS_PROGRAM) {
      return refuse(`program ${program} is not allowed with allowedMultisig`);
    }

    const discriminator = data.subarray(0, 8).toString('hex');
    const name = ALLOWED_INSTRUCTIONS.get(discriminator);
    if (name === undefined) {
      const refused = REFUSED_INSTRUCTIONS.get(discriminator);
      return refuse(
        refused === undefined
          ? `Squads instruction ${discriminator || '(empty)'} is not allowed with allowedMultisig`
          : `Squads ${refused} is not allowed with allowedMultisig: this key only proposes, executes and closes`,
      );
    }
    const target = keys[instruction.accountKeyIndexes[0] ?? -1]?.toBase58();
    if (target !== multisig) {
      return refuse(
        `Squads ${name} targets ${target ?? '(a lookup-table account)'}, not the allowedMultisig`,
      );
    }
    squads += 1;
  }

  if (squads === 0) return refuse('the transaction has no Squads instruction');
  return { ok: true };
}
