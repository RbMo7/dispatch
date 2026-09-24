import type { SolanaCall } from '../../domain/call.js';
import type { DispatchError } from '../../domain/errors.js';
import { err, ok, type Result } from '../../domain/result.js';
import { parsePublicKey } from './native-transfer.js';

/**
 * Any Call targeting a program that is neither the System Program (native
 * transfer, issue 02) nor the SPL Token program (issue 03) — a beneficiary's
 * own application-defined contract call (CONTEXT.md's Call entry: "the
 * engine submits without needing to understand its semantics"). Validation
 * here is deliberately shape-only, never semantic: the caller owns the
 * ABI/IDL, not the engine, so there is no correct account count or data
 * layout to enforce beyond "this parses as real Solana values."
 */
export function validateGenericCall(call: SolanaCall): Result<void, DispatchError> {
  const programId = parsePublicKey(call.programId);
  if (!programId.ok) {
    return err({ ...programId.error, message: `not a well-formed program id: ${call.programId}` });
  }

  for (const account of call.accounts) {
    const pubkey = parsePublicKey(account.pubkey);
    if (!pubkey.ok) return pubkey;
  }

  // `data` is genuinely opaque (ADR-0018) — there is no shape to check here;
  // Node's base64 decoder is lossy-permissive rather than strict, so it
  // cannot itself reject a malformed value, and this Chain Handler has no
  // IDL to validate against even if it could. A real rejection surfaces
  // only where it's actually knowable: at broadcast, from the program itself.
  return ok(undefined);
}
