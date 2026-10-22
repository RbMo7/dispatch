Status: proposed, waiting on ADR-0055 being accepted. Tickets not yet filed.

# Startup check: the Signer pins the right multisig or Safe

Parent: issue #95. Specs: `.scratch/multisig-and-local-signer/spec.md`, `.scratch/safe-multisig-base/spec.md` ("Startup checks"). ADRs: 0046, 0049, 0051, proposed 0055.

## Problem Statement

An operator running a Multisig Sender is told the Signer's policy pins the engine's key to the one multisig or Safe. Nothing checks it. The engine only asks the Signer whether it holds a key for the address (404 vs 403/400, without signing). So a key with no pin, or pinned to the wrong account, starts fine. It fails later with `SIGNER_REFUSED` on the first Proposal, or it runs unpinned and the Signer's main protection against a compromised engine is off without anyone knowing.

## Solution

The Signer answers a read-only `GET /keys/{address}/policy` with the pins and nothing else. At startup the engine reads it for a Multisig Sender and refuses to start unless the pin matches its own configuration. The decision, alternatives and consequences are in ADR-0055.

## User stories

1. As an operator, I want the engine to refuse to start when the Signer's key for the Sender is not pinned to my multisig, so I find out before the first Proposal.
2. As an operator, I want the error to say what the Signer reported and what the engine expected, so I can fix the right file.
3. As an operator with an older Signer, I want a clear "upgrade the Signer" message, not a silent pass.
4. As a security reviewer, I want the route to return only pins, behind the bearer token, and to be audited.
5. As an operator of a plain Sender, I want no change at all.

## The contract

`GET /keys/{address}/policy`, `Authorization: Bearer <SIGNER_AUTH_TOKEN>`.

| Response | Meaning |
|---|---|
| `200 { "address", "curve", "chainIds"?: number[], "allowedSafe"?: string, "allowedMultisig"?: string }` | The key exists. Each pin is present only when set. Addresses are in the form `normalizeAddress` stores. |
| `401` | Wrong or missing token, as for `/sign`. |
| `404 { "error": "no key for address <address> on curve <curve>" }` | No key held for this address, in the wording `/sign` already uses (`server.ts`). |
| `404 { "error": "not found" }` | An old Signer: the route does not exist. |

Never in the response: key material, seed, backend reference, allowed recipients, limits, MultiSend lists. The audit line carries `kind: "policy-read"`, the address, and `decision`; no signature is made.

## Engine checks (Multisig Sender only)

- **Squads:** `allowedMultisig` equals the configured multisig. Missing is an error, not a warning.
- **Safe:** `allowedSafe` equals the configured Safe, and `chainIds` contains the configured chain ID (the loader already requires `chainIds` with `allowedSafe`).
- Mismatch, missing pin, 404 for the address or a Signer without the route: refuse to start. Each message names the address, what was reported and what was expected; the "old Signer" message says to upgrade it.
- Unreachable Signer: the existing startup behavior (fail with `SIGNER_UNREACHABLE`).
- The key probe is still used for a Sender that is not a Multisig Sender.

## Out of scope

- Checking the rest of the policy (recipients, limits, known tokens). Signer-side enforcement stays the control.
- Mutual proof that the Signer is honest; a compromised Signer can lie, and ADR-0055 says so.
- Reading policy for a Relay Dispatch or anything non-Sender.

## Testing

- Signer: route returns only pins; 401 without the token; 404 for an unknown address; audit line written; a key with no pins returns no pin fields; the response never contains a key (assert on a known seed).
- Engine, against a fake Signer client: a matching pin starts; a missing pin, a wrong multisig, a wrong Safe, a Safe on the wrong chain and an old-Signer 404 each refuse with the right message; the key probe still runs for a plain Sender.
- Live tier: extend the existing multisig e2e fixtures so the real Signer is read once (`RUN_SQUADS=1`, `RUN_SAFE=1`); not part of CI (ADR-0013).

## Proposed issues

1. Signer: `GET /keys/{address}/policy`, audited, pins only, with tests. Needs ADR-0055 accepted.
2. Engine: client method and the Squads and Safe startup checks, with clear messages and tests. Needs 1.
3. Docs: `docs/signer.md` (route, audit record, checklist item), `docs/multisig.md` (startup checks list, drop the "not built" note), `docs/agents` untouched. Needs 2.

## Settled

- A missing pin on a Multisig Sender refuses to start (decided 2026-10-22), not a warning.
- The two 404 bodies already differ (`no key for address ...` from the keyring lookup, `not found` for an unknown route), so the engine can tell a missing key from an old Signer with no new body. Issue 1 keeps the existing wording and the engine matches on it; a test pins it.
