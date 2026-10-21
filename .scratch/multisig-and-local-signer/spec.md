Status: ready-for-agent (tickets #70–#78, #88, #89 filed; decisions settled in the 2026-10-21 grilling, ADR-0053)

# Multisig Senders, Treasuries and a Local Signer backend

## Problem Statement

The Signer (ADR-0046) has three key backends, and they leave two gaps before mainnet:

- **No production backend without a cloud account.** `keyfile` is dev only: plaintext keys in a committed JSON file. An operator with no AWS or Privy account has nothing safe to run.
- **One key can move all the money.** Whichever backend holds the Sender's key, that one key (and anyone who gets signatures out of it) can move the whole balance. An operator disbursing real money often wants a human decision in the loop: either on every transfer, or at least on how much money the hot wallet holds.

## Solution

Two independent additions, either, both or neither of which an operator may use:

1. **A `local` Signer backend**: keys in encrypted files, a CLI to manage them. The operator picks a backend per address, as today (`keyfile` dev, `local`, `privy`, `aws-kms`).
2. **Multisig support, Solana first (Squads v4):**
   - **Treasury**: a multisig that funds the Sender. A documented pattern, no engine code. Approvers top up the Sender; the Funding Check says by how much.
   - **Multisig Sender**: the Sender is the multisig's vault. The engine proposes each bundle of Calls, Approvers vote in the Squads app, the engine executes once approved. The engine's key can propose and execute but never vote (ADR-0049).

The Safe equivalent for Base comes later, after this has shipped and proved out.

## How it works

### Treasury (no engine involvement)

The Treasury is a multisig vault holding most of the funds. The Sender is an ordinary hot wallet holding a working balance, signed by any Signer backend.

1. A Dispatch finds the Sender short; the Funding Check fails the Call with `INSUFFICIENT_FUNDS`, naming the exact amount.
2. An Approver creates a transfer from the Treasury vault to the Sender address in the Squads app and votes; enough other Approvers vote to meet the threshold; a member with Execute permission runs it.
3. The caller re-sends the Dispatch (new Idempotency Key).

A stolen Sender key loses only the working balance.

### Multisig Sender

The Sender address is the Squads vault. The engine's own key is a member of that multisig with **Initiate and Execute permission only**.

1. A Dispatch arrives. The Funding Check runs against two balances: the vault for the payments, and the engine's member key for fees and proposal rent (same reasoning as ADR-0043).
2. The engine bundles the Calls (the existing size-aware bundling) and builds **one vault transaction and proposal per bundle**, signed by the member key through the Signer. Each is written down before it is sent (ADR-0041). The Calls become `AWAITING_APPROVAL`.
3. Approvers vote in the Squads app (or its CLI/SDK).
4. The engine watches the proposal. On **Approved** it waits out any time lock, executes the vault transaction, and from there tracks the execute Transaction like any other (`PENDING`, then `CONFIRMED` or `FAILED`; expiry resubmission per ADR-0042/0045 applies to the engine's own transactions).
5. **Rejected**: the Calls fail with `APPROVAL_REJECTED`. **No decision before the deadline (default 72h)**: the Calls become `ABANDONED` with reason `APPROVAL_TIMEOUT`, and the engine never executes that proposal itself afterwards (ADR-0053). It keeps watching for 30 days: if someone else executes it, the Calls become `CONFIRMED`; if it is rejected, they become `FAILED` with `APPROVAL_REJECTED`; if it is approved but not executed, the `approval` block says so and the log says it loudly.

## How an operator sets it up

### A. The local backend

1. Create keys with the CLI. The passphrase is read from the environment or a mounted file, never a command-line argument:
   ```
   SIGNER_KEYSTORE_DIR=/var/lib/signer/keystore
   SIGNER_KEYSTORE_PASSPHRASE_FILE=/run/secrets/keystore-passphrase
   signer keys new --curve ed25519 --name ops-sender     # prints the public address only
   signer keys import --curve secp256k1 --name base-sender   # key read from stdin
   signer keys list
   signer keys export-public --name ops-sender
   ```
2. Map the address to the backend in `SIGNER_CONFIG`, the same file as every other backend:
   ```json
   {
     "<address printed by the CLI>": {
       "curve": "ed25519",
       "backend": "local",
       "keyRef": "ops-sender",
       "policy": { "maxNativePerTransaction": "5000000000" }
     }
   }
   ```
3. Start the Signer. It decrypts every referenced key, derives its address, and refuses to start on a mismatch or a wrong passphrase (the existing startup check, ADR-0046). It logs that `local` keeps keys in process memory.

### B. A Treasury

1. Create a Squads multisig (members = your Approvers, threshold e.g. 2 of 3) through the Squads app. Its vault holds the funds.
2. Create the Sender on any backend as above, and put its address in `SOLANA_SENDER_ADDRESS` as today.
3. To fund it, Approvers transfer from the vault to the Sender address in the Squads app. Nothing else changes.

### C. A Multisig Sender

1. Create a Squads multisig in the Squads app with the Approvers as members (Vote permission). Set a threshold, and a time lock if you want one.
2. Create a key for the engine on any Signer backend, and **add it as a member with Initiate and Execute permission only**. The engine refuses to start if that key can vote.
3. In `SIGNER_CONFIG`, map the member key's address, **pinning the one multisig it may act on**:
   ```json
   {
     "<member key address>": {
       "curve": "ed25519",
       "backend": "aws-kms",
       "keyRef": "arn:aws:kms:...",
       "policy": { "allowedMultisig": "<multisig account address>" }
     }
   }
   ```
4. Configure the engine (names proposed; the tickets fix them):
   ```
   SOLANA_SENDER_MODE=multisig
   SOLANA_MULTISIG_ADDRESS=<multisig account>
   SOLANA_MULTISIG_MEMBER_ADDRESS=<member key address>
   SOLANA_APPROVAL_DEADLINE_MS=259200000     # default 72h; keep it above any time lock
   SOLANA_APPROVAL_REWATCH_WINDOW_MS=2592000000   # default 30 days: how long a timed-out proposal is still watched
   ```
   `SOLANA_SENDER_ADDRESS` is derived from the multisig (its vault) and, if also set, must match.
5. Fund two things: the vault with the money to pay out, and the member key with a little SOL for fees and proposal rent.
6. Startup checks: the multisig exists, the member key is a member, holds Initiate and Execute, and does not hold Vote; the Signer holds a key for that address and its policy pins this multisig.

## How a user works with it

**Treasury:** nothing in the application changes. A top-up is a Squads app task for the Approvers.

**Multisig Sender:** the caller uses `POST /v1/dispatch` exactly as before; only the lifecycle gains a wait.

1. The caller posts a Managed Dispatch (same body, same Idempotency Key rules).
2. `GET /v1/dispatch/:id` reports the Calls as `AWAITING_APPROVAL`, with an additive block:
   ```json
   "approval": {
     "multisig": "<multisig account>",
     "proposal": "<proposal address>",
     "transactionIndex": 42,
     "approvals": 1,
     "threshold": 2,
     "deadline": "2026-10-23T09:00:00Z",
     "expected": { "recipients": 120, "totals": [{ "asset": "USDC", "amount": "125000000" }] }
   }
   ```
3. The Approvers open the proposal in the Squads app (connect a wallet, see the decoded instructions) and approve or reject. **The real control is comparing the decoded proposal against their own record** (for example the payment file the Dispatch came from), by eye or with the verifier CLI, which reads the proposal on-chain without the engine. The `approval` block's `expected` recipient count and per-asset totals only catch mistakes: a compromised engine can lie consistently (ADR-0049).
4. The engine executes after the threshold and any time lock, and the status moves to `PENDING`, then `CONFIRMED`. A rejection ends in `FAILED` with `APPROVAL_REJECTED`. A missed deadline ends in `ABANDONED` with `APPROVAL_TIMEOUT`, which may still land later, so the caller must not blindly re-send (the same rule as any `ABANDONED` Call). `GET` shows `approval.state`: `awaiting`, `approved`, or `approved_after_deadline`.

A dashboard for this is deferred (see Out of Scope). Until then a caller can poll `GET /v1/dispatch/:id`, or an operator can read the `approval` block and open it in Squads.

## User Stories

1. As an operator without an AWS or Privy account, I want a production-grade local backend, so that I can run a Signer safely on my own host.
2. As an operator, I want keys encrypted at rest and managed through a CLI that never prints a private key, so that a leaked file or shell history doesn't leak a key.
3. As an operator, I want a treasury multisig to fund a hot Sender, so that a stolen Sender key loses only the working balance.
4. As an operator, I want every transfer to need M-of-N human approval, so that no single key or compromised host can move the funds.
5. As an Approver, I want to vote in the Squads app with my own wallet, so that my key never touches the engine or the Signer.
6. As an Approver, I want the expected recipient count and per-asset totals next to the proposal, so that I can check what I am approving.
7. As an integrator, I want `AWAITING_APPROVAL`, `APPROVAL_REJECTED` and `APPROVAL_TIMEOUT` documented in `docs/api.md`, so that my client handles a human delay and a refusal.
8. As an operator, I want a proposal nobody approves in time to stop being executed by the engine, and to be reported honestly if someone approves and executes it later, so that a late approval never runs unnoticed or lets a caller pay twice.
9. As an operator, I want the engine to refuse to start if its member key can vote, or the Signer's policy is not pinned to this multisig, so that a misconfiguration fails loudly.
10. As an operator, I want the Funding Check to tell me which balance is short (vault or member key), so that I fund the right one.
11. As an Approver, I want to verify a proposal against my own payment file without trusting the engine, so that a compromised engine cannot get a wrong payment approved.

## Implementation Decisions

- **Roles (ADR-0049).** The engine's key holds Initiate and Execute, never Vote. The engine proposes, the Approvers vote, the engine executes. No design in which the engine or its Signer holds an Approver key.
- **Local keystore (ADR-0050).** One encrypted file per key (scrypt, AES-256-GCM, Node `crypto`), covering both curves. Passphrase from env or a mounted file. A CLI manages keys. The backend implements the existing `KeyBackend` interface (ADR-0012: it is the fourth real implementation).
- **Signer policy.** A new per-address field, `allowedMultisig`, pins the one multisig account the key may act on. For a pinned address the Squads program is allowed, and the decoder accepts only its create/execute (and proposal-create) instructions on that multisig. Nested payments are not decoded; the Approvers' vote is the control on what is inside (decided in the grilling session).
- **Calls to proposals.** One vault transaction and proposal per bundle, using the existing size-aware bundling. The real maximum bundle is measured on devnet in the first ticket; the bundling limit for Multisig Senders may be tighter than for plain Senders.
- **Statuses and errors.** `AWAITING_APPROVAL` (a Call status, additive), `APPROVAL_REJECTED` (a `FAILED` error code) and `APPROVAL_TIMEOUT` (an `ABANDONED` reason, ADR-0053). All are documented in `docs/api.md`. The `approval` block carries `state` (`awaiting`, `approved`, `approved_after_deadline`) and is described above.
- **Timeout (ADR-0053).** `SOLANA_APPROVAL_DEADLINE_MS`, default 72 hours, measured from when the proposal is created. After it the Calls are `ABANDONED` (`APPROVAL_TIMEOUT`) and the engine never executes the proposal itself. `SOLANA_APPROVAL_REWATCH_WINDOW_MS` (default 30 days; the existing re-watch cadence on the first day, hourly after) is how long it still watches: someone else executing it moves the Calls to `CONFIRMED` (log `late_execution_detected`), a rejection moves them to `FAILED`, and an approved-but-unexecuted proposal is shown as `approved_after_deadline` and logged loudly. An engine restart resumes watching from the written-down proposal (ADR-0041).
- **Time lock.** If the multisig has a time lock, the engine waits for it before executing. The runbook says to set the deadline above the time lock.
- **Stale proposals.** A proposal made stale by a multisig config change is treated as rejected.
- **Funding Check.** For a Multisig Sender it checks the vault for the payments and the member key for fees and proposal rent, naming whichever is short. Proposals are independent, so several can be open at once; the check therefore subtracts the amounts already committed in open proposals, including timed-out ones still being watched, and names the committed amount when it refuses.
- **Engine config (names proposed).** `SOLANA_SENDER_MODE` (`single` default, or `multisig`), `SOLANA_MULTISIG_ADDRESS`, `SOLANA_MULTISIG_MEMBER_ADDRESS`, `SOLANA_APPROVAL_DEADLINE_MS`. One Sender per chain stays (ADR-0016).
- **Startup checks.** The member key exists with exactly Initiate and Execute (refuse to start if it holds Vote), the Signer can sign for it, and the vault derived from the multisig matches `SOLANA_SENDER_ADDRESS` if that is set.
- **Squads only.** No cross-chain multisig interface until Safe on Base is the second real implementation (ADR-0012).
- **Threshold of 1** only warns loudly at startup; it still protects against a compromised engine.
- **`expected` is not a security control.** It comes from the engine. The independent check is the verifier CLI (`verifier/`, #89): its own package with no engine or Signer code, which takes a proposal and the caller's payment file and reports MATCH or MISMATCH from on-chain data alone.
- **Not blocked.** Only the Multisig Sender's own Calls wait for approval. Relay Dispatch and other chains are never held, and a hot Sender alongside a multisig on one chain is a second engine instance (ADR-0016).
- **Glossary.** Approver, Treasury and Multisig Sender are defined in `CONTEXT.md`.

## Testing Decisions

- **Offline:**
  - `local` backend: encrypt and decrypt round trip, a wrong passphrase refused, address derivation for both curves, a tampered file refused, the CLI never printing a private key.
  - Policy: `allowedMultisig` allows its own create/execute instructions and refuses any other multisig, any other program, and anything undecodable.
  - Engine, against a fake Squads state: the full lifecycle (propose, approved, execute), rejection, timeout then a late execution, a late rejection and an approved-after-deadline proposal, a stale proposal, a restart mid-approval, time lock waiting, and the startup checks (including refusing a member key that can vote).
  - Funding Check names the right balance.
- **Live, local and opt-in (`RUN_SQUADS=1`):** a real 2-of-3 Squads multisig on devnet. Test Approver keys vote, and the engine proposes and executes a small SOL and SPL bundle that lands.
- **Existing live tests** keep passing unchanged.

## Tickets

GitHub Issues on `RbMo7/dispatch`, worked in this order, in one pass per `AGENTS.md`'s chain-specific cadence:

1. #70: **Spike:** Squads v4 on devnet. Measure the largest bundle per proposal, fees and rent, confirm the program ID, observe time lock and stale behaviour. Record findings in this spec.
2. #71: `local` keystore backend and the key CLI.
3. #72: Policy: `allowedMultisig` and the Squads instruction decoder. Needs #70.
4. #73: Engine: Multisig Sender config and startup checks. Needs #70.
5. #74: Engine: propose (vault transaction, proposal, `AWAITING_APPROVAL`, the `approval` block, `docs/api.md`). Needs #72, #73.
6. #75: Engine: watch and execute (approved, time lock, rejection, timeout, stale, restart). Needs #74.
7. #76: Funding Check across the two balances. Needs #73.
8. #77: Docs: Treasury pattern, runbook additions in `docs/signer.md`, mainnet checklist. Needs #71, #75, #76, #88, #89.
9. #78: Live devnet test (`RUN_SQUADS=1`). Needs #75, #88.
10. #88: Engine: re-watch timed-out multisig proposals, both chains (ADR-0053). Needs #75, #84.
11. #89: Independent verifier CLI for Squads and Safe proposals. Needs #74, #83.

#70 and #71 have no blockers and can start in parallel.

## Out of Scope

- **A dashboard or other UI.** A later read-mostly client of the engine API (Dispatches and pending approvals), then a fuller SDP-style dashboard. It adds logins and roles, so it needs its own ADR superseding ADR-0022 and ADR-0017. The `approval` block is shaped so it can be built on.
- **Safe on Base.** The next multisig, after this one is proven.
- **Spending limits.** Letting the vault grant the Sender a capped allowance per period. A possible Treasury follow-up.
- **Managing the multisig from the engine.** The engine never changes members, threshold or time lock; that stays in the Squads app.
- **Automated Approvers.** No Vote key behind a Signer.
- **Cancelling an expired proposal on-chain.** The engine logs it; a human cancels it.
- **Per-payment proposals** and **multiple Senders** (ADR-0016).
