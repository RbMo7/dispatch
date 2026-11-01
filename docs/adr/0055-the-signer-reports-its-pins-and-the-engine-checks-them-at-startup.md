# The Signer reports its pins, and the engine checks them at startup

Accepted 2026-10-22. Amends ADR-0046's wire contract.

Amended by ADR-0059 (the worker reads every Sender's pins and records them for the API, which never calls the Signer).

ADR-0051 and ADR-0049 say a Multisig Sender's key is pinned in the Signer's policy to its one multisig (`allowedMultisig`) or Safe (`allowedSafe`). Both specs promise the engine checks that pin at startup. It doesn't: the Signer cannot say what a key's policy is, so the engine only probes whether the Signer holds a key for the address. A key with no pin, or pinned to the wrong multisig, starts fine and fails later with `SIGNER_REFUSED`, or runs unpinned and lets a compromised engine have the key sign for any account the key can reach. Issue #95.

## Decision

- **A read-only Signer route.** `GET /keys/{address}/policy`, behind the same bearer token as `/sign` (ADR-0046), audited like every other request. It answers `200 { address, curve, chainIds?, allowedSafe?, allowedMultisig? }`: only the pins, and only when set. It never returns a key, a seed, a backend reference or any other part of the policy. An address with no key is `404`.
- **The engine checks the pin at startup, for a Multisig Sender only.** Solana: `allowedMultisig` must equal the configured multisig. Base: `allowedSafe` must equal the configured Safe and `chainIds` must contain the configured chain. A missing or different pin refuses to start, with a message naming what the Signer reported and what the engine expected.
- **A Signer that has no such route refuses too.** The engine tells "an old Signer" from "no key for this address" by the response body, and asks for an upgrade. It does not fall back to a key probe: that would turn the check back off for exactly the deployments that never updated the Signer.
- **The key probe is removed.** It ran only in the two Multisig Sender startup checks, so the pin read replaces it (a `404 no key for address` still says the key is missing). A plain Sender has no Signer startup check, as before.
- **This is a guard against misconfiguration, not a security control.** A compromised Signer can report anything. The control is still the Signer enforcing its policy at `/sign` (ADR-0046); this check makes sure the operator wrote that policy.

## Considered options

- **Leave it to the operator checklist** (`docs/multisig.md` already lists it). Rejected: it is the one startup check both specs promised that fails silently, and a forgotten pin is exactly the case the Signer policy exists for. Cheap to forget, expensive when it matters.
- **Probe by sending a request the pin must refuse** (a vote instruction on Solana, a Safe typed-data request for another Safe) and expect a `403` with the pin's reason. Rejected: it needs no contract change but writes a refusal to the audit log on every start, so real refusals stop standing out. It also proves nothing when the refusal comes from some other rule, and it asks the Signer to sign-check a transaction the engine built only to be rejected.
- **A new response field on `/sign`.** Rejected: nothing to attach it to before the first signature, and the check belongs at startup.
- **Return the whole policy.** Rejected: the engine needs two fields. Everything else is operator-private and would widen what a leaked engine token can read.

## Consequences

- Breaking for a Multisig Sender: the engine and its Signer must be upgraded together, the same as ADR-0046. A plain Sender is unaffected. Nothing is on mainnet yet, so there is no compatibility shim.
- The route is a second authenticated read. With the bearer token, a caller learns which multisig or Safe an address is pinned to and which chains it may sign for. They could already learn that a key exists (the old probe), and the pinned address is public on-chain.
- `docs/signer.md` documents the route and its audit record; the mainnet checklist item becomes "the engine verified it at startup".
