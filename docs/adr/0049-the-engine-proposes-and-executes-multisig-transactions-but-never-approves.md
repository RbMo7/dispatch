# The engine proposes and executes multisig transactions but never approves

A Multisig Sender's address is a multisig wallet, so a transaction from it needs M-of-N Approvers before it can run. On Squads v4 that is three steps: someone proposes, Approvers vote, and a member with Execute permission runs it. Squads splits these into separate permissions (Initiate, Vote, Execute), so the engine can be given part of the job. How much of it?

## Decision

- **The engine's key holds Initiate and Execute, never Vote.** It builds one vault transaction and proposal per bundle, and executes once the proposal is approved and any time lock has passed. Approvers vote with their own wallets, outside the engine and outside every Signer backend.
- **The engine refuses to start if its member key can vote**, and the Signer's policy pins that key to the one configured multisig.
- **A human decision is final, and silence is not.** A rejection fails the Calls with `APPROVAL_REJECTED`, which is definitive and never retried. A proposal with no decision before a deadline (default 72 hours, from creation) is `ABANDONED` with reason `APPROVAL_TIMEOUT`, and the engine never executes it afterwards. It may still land if someone else executes it, so ADR-0053 watches it for a long window instead of calling it `FAILED`. A proposal made stale by a multisig config change counts as rejected.
- **The engine cannot check what it proposes.** The Signer's policy does not decode the payments nested in a proposal. The control is that Approvers compare the decoded proposal in the multisig app against their own record of the payments, by eye or with an independent verifier CLI that reads the proposal on-chain without the engine. The API's `approval` block carries expected totals, but they come from the engine, so they only catch mistakes: a compromised engine can lie consistently.

## Considered options

- **The engine also votes, through Signer backends** (fully automated approval). Rejected: every Approver key would sit behind one engine and one Signer, so one compromised host reaches the threshold alone and the multisig protects nothing.
- **The engine only proposes, and a human also executes.** Rejected: it leaves every payment waiting on someone to press execute after the vote, and a blockhash-based execute is time-sensitive. An Execute-only step is mechanical and carries no decision.
- **The engine decodes nested payments and enforces the existing policy on them.** Rejected for now: a heavy decoder for a key that cannot move money alone, and the Approvers' vote already gates the contents.

## Consequences

- A compromised engine can propose wrong payments, so Approvers who rubber-stamp are the remaining risk. The runbook says so.
- A proposal that passes its deadline stays on-chain until a human rejects it, and may be executed by someone else later; ADR-0053 covers how the engine notices.
- A time lock longer than the approval deadline makes every proposal time out; the runbook says to keep the deadline above it.
- `AWAITING_APPROVAL`, `APPROVAL_REJECTED` (a `FAILED` error) and `APPROVAL_TIMEOUT` (an `ABANDONED` reason) are wire-format additions in `docs/api.md`.
- Squads is built concretely. A cross-chain multisig interface waits for Safe on Base to be the second implementation (ADR-0012).
