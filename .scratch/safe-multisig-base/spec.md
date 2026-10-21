Status: tickets #79–#87, #88, #89 filed; decisions settled in the 2026-10-21 grilling (ADR-0053)

# Safe multisig on Base: Treasury and Multisig Sender

## Problem Statement

`multisig-and-local-signer` (`.scratch/multisig-and-local-signer/spec.md`) gives Solana a Treasury and a Multisig Sender on Squads, with the engine proposing and executing and humans approving. Base, the chain nearest mainnet, has the same gap: one key can move the whole Sender balance. Safe is the standard multisig on Base, but it differs from Squads in ways that change the design, so the Squads tickets cannot simply be repeated.

## Solution

The same two independent options, on Base with Safe, reusing the roles from ADR-0049 and the shared engine pieces from the Solana feature (`AWAITING_APPROVAL`, the `approval` block, `APPROVAL_*` errors, the deadline watch, the `local` backend):

- **Treasury**: a Safe that funds the Sender. A documented pattern, no engine code.
- **Multisig Sender**: the Sender is a Safe. The engine proposes each bundle of Calls to the Safe Transaction Service, owners confirm in the Safe app, and the engine submits `execTransaction`.

## How Safe differs from Squads

| | Squads (Solana) | Safe (Base) |
|---|---|---|
| Engine's role | A member with Initiate and Execute (never Vote) | **Not an owner at all.** A delegate that may post proposals, plus an ordinary EOA that submits `execTransaction`. Nothing on the engine's key can approve. |
| Proposing | On-chain accounts | Off-chain, to the **Safe Transaction Service**, signed (EIP-712) by an owner or delegate. |
| Approving | An on-chain vote | An **off-chain signature** by each owner (gasless). Owners can also approve on-chain with `approveHash`. |
| Executing | A member with Execute permission | **Anyone**, with the owners' signatures sorted by owner address. The executor pays gas. |
| Ordering | Proposals are independent | The Safe nonce is **sequential**: one queue, one transaction per nonce. |
| Batching | The engine's size-aware bundling | `MultiSendCallOnly`, a delegatecall from the Safe, so ERC-20 items work (unlike Bulk Call, ADR-0038). |
| Time lock | Built in | None by default (a Zodiac Delay module is separate and unsupported in v1). |

## How it works

### Treasury (no engine involvement)

The Treasury is a Safe holding most of the funds. The Sender is an ordinary hot EOA holding a working balance (`BASE_SENDER_ADDRESS`, as today).

1. A Dispatch finds the Sender short; the Funding Check fails the Call with `INSUFFICIENT_FUNDS`, naming the amount.
2. An owner creates a transfer from the Safe to the Sender in the Safe app; other owners confirm; one executes.
3. The caller re-sends the Dispatch with a new Idempotency Key.

### Multisig Sender

The payments come from the Safe. The engine acts through its own EOA, the **executor**, which owns the nonce, pays gas, and is registered as a **delegate** of the Safe. It is not an owner.

1. A Dispatch arrives. The Funding Check checks the Safe for the payments and the executor for gas (including Base's L1 data fee).
2. The engine bundles the Calls into one `MultiSendCallOnly` transaction (one delegatecall, bundle size bounded like `BASE_BULK_CALL_MAX_BATCH_SIZE`), builds the Safe transaction at the Safe's next nonce, and asks the Signer to sign its EIP-712 hash as the delegate (ADR-0052). It writes the proposal down (ADR-0041), then posts it to the Safe Transaction Service. The Calls become `AWAITING_APPROVAL`.
3. Owners see it queued in the Safe app, check it, and confirm (off-chain, no gas).
4. The engine polls the service, counts confirmations against the threshold (and on-chain `approveHash` approvals), and filters them against the Safe's real owner set. At the threshold it simulates, then submits `execTransaction` from the executor as an ordinary Managed transaction (nonce authority, fee estimation and fee-bump all apply, ADR-0037/0039).
5. Reject or replace: if the Safe's nonce moves past the proposal without the engine's transaction, the Calls fail with `APPROVAL_REJECTED`. A proposal with no decision by the deadline (default 72h) becomes `ABANDONED` with reason `APPROVAL_TIMEOUT`, is never executed by the engine, and is watched for 30 days (ADR-0053).
6. **One open proposal per Safe at a time**, because of the shared nonce. Dispatches that arrive meanwhile accumulate, and when the proposal resolves everything waiting becomes one new proposal (up to the bundle limit), so owners approve once per round. Only Calls routed through the Safe wait: Relay Dispatch and other chains are never blocked. After a timeout the next proposal reuses the Safe's current nonce, so the Safe app shows both as alternatives and only one can ever execute.

## How an operator sets it up

### A. A Treasury

1. Create a Safe on Base in the Safe app: owners = your Approvers, threshold e.g. 2 of 3.
2. Keep your Sender as a normal EOA on any Signer backend (`BASE_SENDER_ADDRESS`).
3. To fund it, owners send from the Safe to the Sender address in the Safe app.

### B. A Multisig Sender

1. Create the Safe on Base with the Approvers as owners.
2. Create a key for the engine on any Signer backend (`local`, `privy`, `aws-kms`) and fund it with ETH for gas. **Do not add it as an owner**; the engine refuses to start if it is one.
3. An owner registers the engine key as a **delegate** of the Safe through the Safe Transaction Service (one-time; the runbook gives the exact steps).
4. In `SIGNER_CONFIG`, map the executor address and pin the Safe:
   ```json
   {
     "<executor address>": {
       "curve": "secp256k1",
       "backend": "aws-kms",
       "keyRef": "arn:aws:kms:...",
       "policy": { "chainIds": [8453], "allowedSafe": "0x<safe address>" }
     }
   }
   ```
5. Configure the engine (names proposed; the tickets fix them):
   ```
   BASE_SENDER_MODE=safe
   BASE_SAFE_ADDRESS=0x<safe address>
   BASE_SAFE_EXECUTOR_ADDRESS=0x<executor address>
   BASE_SAFE_TX_SERVICE_URL=https://...
   BASE_SAFE_API_KEY=...
   BASE_APPROVAL_DEADLINE_MS=259200000     # default 72h
   BASE_APPROVAL_REWATCH_WINDOW_MS=2592000000   # default 30 days: how long a timed-out proposal is still watched
   ```
6. Fund the Safe with the money to pay out, and the executor with ETH for gas.
7. Startup checks: the Safe exists and is a supported version; the executor is not an owner and is a registered delegate; the Signer can sign for the executor and its policy pins this Safe; the service is reachable; the chain ID matches.

## How a user works with it

**Treasury:** nothing in the application changes. A top-up is a Safe app task.

**Multisig Sender:** the caller uses `POST /v1/dispatch` as before. `GET /v1/dispatch/:id` reports `AWAITING_APPROVAL` with the same `approval` block as Solana (common fields `approvals`, `threshold`, `deadline`, `expected`), plus Safe identifiers: `safe`, `safeTxHash`, `nonce`. Owners open the transaction in the Safe app (queued under the Safe's pending list) and confirm or reject. **The real control is comparing the decoded transaction against their own record** of the payments, by eye or with the verifier CLI (#89), which recomputes the `safeTxHash` from the owners' own payment file without the engine. `expected` only catches mistakes: a compromised engine can lie consistently. The engine executes at the threshold, and the status moves to `PENDING`, then `CONFIRMED`. A rejection ends `FAILED` (`APPROVAL_REJECTED`); a missed deadline ends `ABANDONED` (`APPROVAL_TIMEOUT`), which may still land, so the caller must not blindly re-send.

## User Stories

1. As an operator, I want a Treasury Safe to fund a hot Sender, so that a stolen Sender key loses only the working balance.
2. As an operator, I want every Base transfer to need M-of-N owner confirmation, so that no single key or compromised host can move the funds.
3. As an owner, I want to confirm in the Safe app with my own wallet, gaslessly, so that my key never touches the engine or the Signer.
4. As an owner, I want the expected recipient count and per-asset totals beside the proposal, so that I can check what I confirm.
5. As an operator, I want the engine's key to be a delegate and an executor only, never an owner, so that nothing it holds can approve.
6. As an operator, I want the Signer to refuse anything but this Safe's own bundle, so that a compromised engine cannot get other signatures.
7. As an operator, I want bundled payments, including ERC-20, to land together or not at all, so that a disbursement is never half-paid.
8. As an integrator, I want the same `AWAITING_APPROVAL` and `approval` block on both chains, so that my client handles one shape.
9. As an operator, I want the engine to refuse to start on a wrong Safe, a missing delegate registration, or an owner key, so that a misconfiguration fails loudly.
10. As an operator, I want the Funding Check to say whether the Safe or the executor is short, so that I fund the right one.
11. As an owner, I want to verify a proposal against my own payment file without trusting the engine, so that a compromised engine cannot get a wrong payment confirmed.

## Implementation Decisions

- **Roles (ADR-0051).** The engine's key is a delegate (posts proposals) and an executor (submits `execTransaction`). It is never an owner. The engine refuses to start if it is one.
- **Executing is an ordinary Managed transaction.** `execTransaction` sent from the executor reuses the Base nonce authority, fee estimation, fee-bump and stuck handling unchanged. No new send path.
- **The Signer signs the Safe transaction as typed data (ADR-0052).** A new request kind carries the full Safe transaction; the Signer computes the EIP-712 digest itself, so it never signs a hash it cannot read. The executor's ordinary EIP-1559 requests are unchanged.
- **Signer policy.** A new per-address field `allowedSafe` pins the one Safe the key may act on. For such an address the Signer allows, and checks the decoded arguments of:
  - EIP-1559 transactions `to` that Safe with the `execTransaction` selector only;
  - the Safe transaction typed data for that Safe and the policy's chain ID: `to` is the canonical `MultiSendCallOnly`, `operation` is delegatecall, and `safeTxGas`, `baseGas`, `gasPrice` and `refundReceiver` are zero, so a proposal can never make the Safe pay the executor a refund.
  Nested payments are not decoded; the owners' confirmation is the control, as in ADR-0049.
- **Bundling.** One `MultiSendCallOnly` transaction per bundle, default limit 50 items (about 1.67M gas), configurable up to 100. The address is the canonical deployment for the Safe's version (see Spike findings).
- **One open proposal per Safe**, because of the sequential Safe nonce. Calls that arrive while one is open accumulate and become one next proposal when it resolves, in order within the bundle. Only Calls routed through the Safe wait.
- **Counting confirmations.** From the Safe Transaction Service plus on-chain `approveHash` approvals, filtered against the Safe's real owners (read on-chain, not from the service) and its real threshold. The service is a convenience for collecting signatures, never the authority on who may approve.
- **A thin REST client**, not the Safe SDK, talks to the Transaction Service (the SDK refuses the hosted service without an API key, and the engine keeps third-party chain SDKs out of its tree). Reads of Safe state pin the block to the receipt's, or retry, because public RPCs lag.
- **Reject or replace.** A proposal at nonce N is rejected or replaced only if the Safe's nonce is past N and the transaction executed at N has a different `safeTxHash` (the engine's own execution moves the nonce too). Then the Calls fail with `APPROVAL_REJECTED`.
- **Statuses and errors.** The same `AWAITING_APPROVAL`, `APPROVAL_REJECTED` (`FAILED`) and `APPROVAL_TIMEOUT` (an `ABANDONED` reason, ADR-0053) as the Solana feature. The `approval` block keeps common, chain-neutral fields (including `state`) and adds chain-specific identifiers.
- **Funding Check.** The Safe for the payments (native and ERC-20); the executor for gas, including the L1 data fee. A shortfall names which.
- **Engine config (names proposed).** `BASE_SENDER_MODE` (`single` default, or `safe`), `BASE_SAFE_ADDRESS`, `BASE_SAFE_EXECUTOR_ADDRESS`, `BASE_SAFE_TX_SERVICE_URL`, `BASE_SAFE_API_KEY`, `BASE_APPROVAL_DEADLINE_MS`. One Sender per chain stays (ADR-0016).
- **Unsupported in v1.** A Safe with a transaction guard or modules that gate execution (for example a Zodiac Delay) is warned about at startup, and not supported; executions through it may revert.
- **Safe versions.** The startup check accepts 1.3.0 and 1.4.1 (L1 and L2 variants), reading `VERSION()`, and refuses the rest.
- **Glossary.** Approver, Treasury and Multisig Sender (in `CONTEXT.md`) cover this; Safe owners are Approvers.

## Testing Decisions

- **Offline:**
  - Policy: `allowedSafe` allows its own `execTransaction` and the matching typed data, and refuses another Safe, another selector, another `operation`, a non-zero refund field, and anything undecodable.
  - Signer: typed-data digest matches Safe's reference hash on known vectors, on every backend (digest signing is the same primitive as today).
  - Engine, against a fake Safe and Transaction Service: propose, confirmations reaching the threshold, signature ordering by owner address, execute, an owner-set change, a nonce that moved (rejection or replacement), timeout then a late execution and a superseded proposal, one-open-proposal accumulation, a restart mid-approval, and the startup checks (including refusing an owner key).
  - Funding Check names the right balance.
- **Live, local and opt-in (`RUN_SAFE=1`):** a real 2-of-3 Safe on Base Sepolia, test owner keys confirm through the service, and the engine proposes and executes a small ETH and ERC-20 bundle that lands; a rejection; a short deadline.
- **Existing live tests** keep passing unchanged.

## Decisions from review (2026-10-21 grilling)

1. **A missed deadline is `ABANDONED`, not `FAILED` (ADR-0053).** Anyone can execute a fully confirmed Safe proposal after the engine's deadline, so the engine reports a timeout as `ABANDONED` (`APPROVAL_TIMEOUT`), never executes it itself, and watches the proposal for 30 days (#88). A late execution moves the Calls to `CONFIRMED`; a late rejection (the nonce consumed by a different transaction) moves them to `FAILED`.
2. **The hosted Safe Transaction Service is an accepted dependency.** No service-less mode in v1. The spike (#79) confirms Base support, the API key and the delegate flow before anything else is built on it.
3. **The shared queue accumulates.** One open proposal per Safe; Dispatches arriving meanwhile accumulate and become one next proposal. Only Calls routed through the Safe wait.
4. **One key on Base** acts as delegate and executor, pinned to the one Safe by policy.
5. **A threshold of 1 only warns** loudly at startup.
6. **The deadline is global config only** (default 72h), with no per-request override.
7. **Webhooks and approver notifications are deferred** (ADR-0023). Until then late outcomes reach a caller only through `GET` and the logs.
8. **`expected` is not a security control.** The independent check is the verifier CLI (#89) or the owners comparing the decoded transaction in the Safe app with their own record.

## Spike findings (#79, measured on Base Sepolia 2026-10-21)

Full evidence and the throwaway Safe addresses: `spike-findings.md`; the EIP-712 test vectors and the hashing helper: `spike-vectors/`. What changed in the design:

- **The Transaction Service supports both chains and works without a key**, at 2 requests per second and 5,000 per month. Base Sepolia is `https://api.safe.global/tx-service/basesep`, Base mainnet `https://api.safe.global/tx-service/base`. A key goes in `Authorization: Bearer <key>`. Polling one open proposal every 60 seconds is about 43,000 requests a month, so a key is needed in production; the monthly quotas of the paid plans are not public and must be read from the Safe developer dashboard before choosing one.
- **The engine uses its own thin REST client**, not the Safe SDK: `api-kit` throws without an API key against the hosted service, and the engine keeps third-party chain SDKs out of its tree.
- **The delegate signs the raw 32-byte `safeTxHash`** (v 27/28), with no prefix. That is exactly the digest primitive the Signer already uses (ADR-0052). The proposal body also needs `contractTransactionHash` and `origin`. Re-posting the same proposal is idempotent.
- **A delegate is registered by an owner** with an EIP-712 `Delegate(address delegateAddress, uint256 totp)` signature, where `totp` is the unix time divided by 3600. The delegate's signature is **not** counted as a confirmation, and a delegate cannot confirm.
- **A non-delegate's proposal is rejected with HTTP 422**, not hidden. The startup check therefore reads the delegate list (`GET /v2/delegates/?safe=&delegate=`) instead of discovering the gap at the first POST.
- **In the Safe app a delegate's proposal appears as proposed by the owner who registered the delegate**, with `proposedByDelegate` set to the engine. The runbook says so, and the engine sets `origin` so owners can recognize it.
- **The EIP-712 domain is `{ chainId, verifyingContract }` only**, the same for 1.3.0 and 1.4.1 and their L2 variants. Hashes were verified three ways (viem, the Safe SDK, on-chain); the vectors are the Signer's test fixtures.
- **Non-owner execution works**, with ECDSA and `approveHash` signatures mixed in one call, sorted by owner address. A failing inner call reverts with `GS013` and leaves the Safe nonce unchanged, so the engine always simulates first, and a simulation that fails with `GS013` means the proposal can never succeed as built.
- **The nonce moving does not mean rejection.** The engine's own execution moves it too. A proposal at nonce N is rejected or replaced only if the nonce is past N **and** the transaction executed at N has a different `safeTxHash`. Losing proposals stay `isExecuted: false` in the service forever. Several proposals can sit at one nonce, listed newest first.
- **Public RPC reads lag after a receipt.** The watcher and the startup checks pin the block number to the receipt's block, or retry.
- **Bundles:** 50 items cost about 1.67M gas and 6 KB of calldata. The default limit is 50, configurable up to 100 (3.3M gas); nothing above about 300.
- **Versions and addresses:** accept Safe 1.3.0 and 1.4.1 (L1 and L2 variants) by reading `VERSION()`. `MultiSendCallOnly` is `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` for 1.4.1 and `0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B` for 1.3.0 (code verified on Base Sepolia; the mainnet addresses come from `@safe-global/safe-deployments` and get a read-only code check at the mainnet smoke test, which is on hold).
- **Guards and modules** are detected on-chain: the guard storage slot `0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8`, and `getModulesPaginated`.
- **Not tested:** the authenticated quotas, the effect of removing or expiring a delegate on posted proposals, and contract-signature owners.

## Tickets

GitHub Issues on `RbMo7/dispatch`, worked in dependency order, in one pass per `AGENTS.md`'s chain-specific cadence. The engine tickets reuse the status, the `approval` block, the errors and the deadline watch built by #74 and #75, and are blocked by them.

1. #79: **Spike:** Safe on Base Sepolia. Transaction Service and API key first, then delegate flow, EIP-712 vectors, `MultiSendCallOnly`, non-owner execution, rejection, gas, guards, supported versions.
2. #80: Signer: sign a Safe transaction as typed data (ADR-0052). Needs #79.
3. #81: Signer policy: `allowedSafe`. Needs #79, #80.
4. #82: Engine: Safe Sender config and startup checks. Needs #79.
5. #83: Engine: propose a Safe bundle (MultiSend, delegate signature, `AWAITING_APPROVAL`). Needs #80, #81, #82, #74.
6. #84: Engine: watch confirmations and execute. Needs #83, #75.
7. #85: Funding Check across the Safe and the executor. Needs #82.
8. #86: Docs: Safe runbook, delegate registration, mainnet checklist. Needs #84, #85, #77, #88, #89.
9. #87: Live Base Sepolia test (`RUN_SAFE=1`). Needs #84, #88.
10. #88 (shared with Solana): re-watch timed-out proposals (ADR-0053). Needs #75, #84.
11. #89 (shared with Solana): the independent verifier CLI. Needs #74, #83.

#79 has no blockers, and can run in parallel with the Solana spike (#70) and the local backend (#71). Comments on #74 and #75 flag the shared `approval` block shape and the timeout decision.

## Out of Scope

- **A dashboard or other UI**, as in the Solana feature.
- **Managing the Safe from the engine** (owners, threshold, modules, guards).
- **Automated approvers**: no owner key behind a Signer.
- **Safe modules and guards** that gate execution.
- **Canceling or rejecting a Safe proposal from the engine.** An owner does that in the Safe app.
- **Ethereum L1 and other chains** (ADR-0035).
- **Per-payment proposals** and **multiple Senders** (ADR-0016).
