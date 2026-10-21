# Design: the shared approval flow (tickets A, B, #74, #75, #76 and the Safe tickets)

Status: accepted 2026-10-21 (ADR-0054). Written from an architect pass over the engine code; it names files and shapes so the tickets can be worked independently. One decision was added after it: **a proposal never mixes Dispatches**, so `proposals` carries a `dispatch_id`, `expected` describes one caller's payments, and the Dispatch's own Retry Policy applies to the execute transaction.

## 1. Domain and wire format

- Every multisig Call gets a `Transaction` row at claim time, so existing per-Call machinery keeps working (`reclaimStaleDispatches` counts distinct `callIndex` rows in `transactions`, `deriveDispatchStatus`, `listTransactions`).
- Two additive `TransactionStatus` values in `src/domain/transaction.ts`: `UNPROPOSED` (claimed, validated, funded, in no proposal yet; wire `queued`) and `AWAITING_APPROVAL` (inside a proposal; wire `awaiting_approval`). Outcomes reuse existing statuses: execute sent is `PENDING`, then `CONFIRMED` or `FAILED`; a missed deadline is `ABANDONED` with `error.code = APPROVAL_TIMEOUT`; a rejection is `FAILED` with `APPROVAL_REJECTED`. Add both codes to `DispatchErrorCode` in `errors.ts`.
- `Transaction` gains `proposalId: string | null` and `proposalPosition: number | null`.
- New `src/domain/proposal.ts`: `Proposal`, `ProposalPhase`, `ApprovalState`, `ChainProposalRef`, `ExpectedTotals`. `ChainProposalRef` is a discriminated union: `{kind:'squads', multisig, proposal, transactionIndex}` or `{kind:'safe', safe, safeTxHash, nonce}`.
- Mapping in `src/api/dispatch-routes.ts`: `toWireItemStatus` gains two cases; `deriveDispatchStatus` treats `UNPROPOSED` and `AWAITING_APPROVAL` as still pending (the Dispatch-level status stays as it is; no new value). `GET` loads proposals through `store.listProposalsForDispatch(id)`; the API never calls a chain.
- `docs/api.md`: per-item status list gains `awaiting_approval`; each item gets an optional `approval` block present whenever the Call belongs to a proposal, including after `abandoned`, `confirmed` or `failed`: `{ state: "awaiting|approved|approved_after_deadline", approvals, threshold, deadline (ISO), expected: {recipients, totals:[{asset, amount}]}, chainRef: {kind:"squads", multisig, proposal, transactionIndex} | {kind:"safe", safe, safeTxHash, nonce} }`. Document `APPROVAL_REJECTED` and `APPROVAL_TIMEOUT`; say `expected` is a mistake-catcher, not a control, and point to the verifier (#89); say `transactionHash` is null until execution, and a late `CONFIRMED` links the executed hash.

## 2. Persistence

- Migration `drizzle/0012_*.sql`, generated from `src/db/schema.ts` (status columns are `text`, so no enum migration).
- New table `proposals`: `id` uuid pk, `dispatch_id`, `chain`, `sender_address` (vault or Safe), `chain_ref jsonb`, `payload text` (opaque, handler-owned: enough to re-sign, re-post or execute), `proposal_ref text` (the proposal PDA or `safeTxHash`, unique, so a re-post is idempotent), `sequence bigint` (Squads transactionIndex, Safe nonce; a partial unique index on `(chain, sender_address, sequence)` where `chain='solana'`, because a Safe nonce is reused after a timeout), `phase` (`noted`, `open`, `executing`, `timed_out`, `resolved`), `approval_state`, `approvals`, `threshold`, `deadline_at`, `execute_after` (time lock), `timed_out_at`, `resolved_at`, `created_at`, `next_check_at`, `check_failures`, `propose_signed_bytes`, `propose_hash`, `expected jsonb`, `committed jsonb` (`{sender:[{asset,amount}], proposer:[...]}`, including rent).
- `transactions` gains `proposal_id uuid references proposals` and `proposal_position int`.
- Write order (ADR-0041): build, sign (a crash here loses only an unsent signature; rows stay `UNPROPOSED`), `store.createProposal` writes the proposal at `phase='noted'` and moves its Transactions from `UNPROPOSED` to `AWAITING_APPROVAL` in one DB transaction, then send. A crash after the write is recovered by the watch loop, which finds `noted` proposals and re-sends the same bytes. Execution follows the same rule: `store.markProposalExecuting(proposalId, signedBytes, hash)` moves the rows to `PENDING`, sharing one hash like a bundle, before the broadcast.
- `DispatchStore` additions (interface, Postgres and in-memory stores): `noteUnproposed`, `listUnproposed(chain, limit)`, `createProposal`, `getProposal`, `listProposalsDue(chains, now, limit)`, `listProposalCalls`, `updateProposal(patch)`, `markProposalExecuting`, `reopenProposalForExecution`, `settleProposal(id, outcome)` (atomic), `listCommitted(chain, holder)`, `listProposalsForDispatch(id)`; `markAbandoned` gains an optional `error`; `listAbandonedTransactions` adds `hash IS NOT NULL` (timed-out proposal rows have no hash, and the re-watch's `requireBroadcast` would throw).
- A shared `src/repository/proposal-store-conformance.ts`, modelled on `chain-scope-conformance.ts`, runs against both stores.

## 3. The Chain Handler seam (ADR-0054)

`ChainHandler.approval?: ApprovalCapability<C>`, following `prepareReplacement` (ADR-0037) and `validateBulkCall` (ADR-0038). The existing `prepare` and `sign` cannot be reused for proposing (Solana `sign` requires `feePayer === senderAddress`, but a vault never signs), so `sign` is called with the **proposer address** (member key or executor).

```ts
interface ApprovalCapability<C> {
  readonly proposerAddress: string;            // member key / executor
  readonly openProposalLimit: number;          // Squads: Infinity (creation serialized); Safe: 1
  readonly reexecuteOnFailure: boolean;        // Squads true, Safe false
  planBundles(calls: CallForChain<C>[]): Result<number[][], DispatchError>; // pure, size-aware, one Dispatch only
  buildProposal(i: {calls; sender; sequenceHint?}): Promise<Result<BuiltProposal>>; // {ref, payload, expected, sequence}
  signProposal(b: BuiltProposal): Promise<Result<{signedBytes; hash}>>;
  submitProposal(s: SignedProposal): Promise<Result<void>>;   // idempotent: Squads broadcast, Safe POST
  readProposal(ref): Promise<Result<ProposalSnapshot>>;
  prepareExecution(p: Proposal): Promise<Result<PreparedTransaction>>;
  estimateApprovalCost(calls): Promise<Result<{asset; amount; rentLocked}>>;
  closeProposal?(p: Proposal): Promise<Result<void>>;
}
ProposalSnapshot = { status: 'unknown'|'active'|'approved'|'rejected'|'executed'|'cancelled'|'stale';
  approvals; threshold; executeAfter?; executedHash?; executable }
```

Execution reuses `sign`, `transactionHash`, `broadcast`, `getStatus`, `prepareReplacement`, `restoreInFlight` and the expiry logic unchanged. On Base `prepareExecution` calls the existing `prepare([execTransaction call], executor)`, so nonce authority and fee estimation are untouched. On Solana it builds the Squads execute instruction with the heap-frame and compute-budget instructions and the member key as fee payer.

Files: `src/chain-handler/chain-handler.ts` (interface), `src/domain/proposal.ts` (types), `src/chain-handler/solana/multisig/squads-approval.ts` and `vault-transaction.ts`, wired in `src/chain-loaders.ts` when `resolveSolanaMultisigConfig` returns a config.

## 4. Coordinator and worker flow

- The chain-neutral state machine lives in a new `src/coordinator/approval-flow.ts`, a class `ApprovalFlow` the Coordinator delegates to (the Coordinator is already about 1,400 lines).
- Claim and propose: in `processClaimedDispatches`, a chain whose handler has `.approval` runs the Funding Check and `validateCall`, then `store.noteUnproposed` for the valid Calls, then `approvalFlow.proposeUnproposed(chain)`. It reads `listUnproposed` in FIFO order **per Dispatch**, and stops when open proposals reach `openProposalLimit`. That one rule gives both modes: Squads builds one proposal per bundle, one creation at a time per multisig; Safe holds one open proposal and later Dispatches wait. `SIGNER_REFUSED` on propose fails those rows (terminal); `SIGNER_UNREACHABLE` leaves them `UNPROPOSED` with a per-chain backoff.
- Watch loop: `Coordinator.watchProposals(limit)` and an `approvalLoop` in `src/worker.ts`, ticking every 10 seconds, picking proposals by `next_check_at` (about 15 to 30 seconds on Squads and 60 seconds on Safe, because of the service quota), with exponential backoff through `check_failures` on `RPC_UNAVAILABLE` or 429. Per proposal: `noted`: re-submit or confirm the propose transaction (on Solana an expired blockhash means re-sign the same payload). `open`: read the snapshot and apply, in order: (1) executed by someone else: settle; (2) rejected, cancelled, or stale and not approved: `FAILED` with `APPROVAL_REJECTED`; (3) `now >= deadline_at`: `ABANDONED` with `APPROVAL_TIMEOUT`, `phase=timed_out` (a pure elapsed-time check that does not depend on a successful read, and runs before any execute, so a late approval is never executed); (4) approved and `now >= execute_after`: execute. An execute `SIGNER_REFUSED` fails the Calls and stops; an unreachable Signer retries next tick.
- Changes to existing code: `resubmitExpired` (coordinator.ts, around line 1008) rebuilds from `dispatch.items[callIndex].call`, so for rows with a `proposalId` it must call `approval.prepareExecution` instead. In the FAILED branch of `tryResolveByStatus`, for a row with `proposalId` where `reexecuteOnFailure` is true: if the snapshot is still approved and before the deadline, call `reopenProposalForExecution`; otherwise the rows go `FAILED`. `restoreReservations` must also pass `propose_signed_bytes` of unsettled proposals to `restoreInFlight`.
- Retry Policy: because a proposal never mixes Dispatches, the Dispatch's own `retryPolicyFor` applies to its execute transaction.

## 5. Funding Check

The change is in `runFundingCheck` (coordinator.ts, around line 420) only. Payments still check the Sender address (the vault or Safe). The network-cost requirement already carries `fundedBy` and the requirement key already includes it: in multisig mode, take the cost from `approval.estimateApprovalCost` and set `fundedBy = proposerAddress`. `available = balance - store.listCommitted(chain, holder)`, where committed amounts come from proposals in `noted`, `open`, `executing`, or `timed_out` still inside the window, plus `UNPROPOSED` rows' payments. The error is `INSUFFICIENT_FUNDS` with `chainDetail: {asset, short, holder: 'vault'|'memberKey'|'safe'|'executor', address, committed}`; a plain Sender keeps `{asset, short}` exactly. Safe needs committed amounts too: the open proposal's funds are not yet spent, and without counting them the next proposal simulates `GS013`.

## 6. Ticket plan

A (domain, schema, migration, stores, conformance, API mapping, `docs/api.md`, the `listAbandonedTransactions` filter) blocks everything. B (the capability interface, a scriptable `FakeApproval`, the `ApprovalFlow` propose half, ADR-0054) is blocked by A. #74 (Squads propose) is blocked by A, B and #73. #76 (Funding Check) is blocked by A and B, not #75. #75 (watch and execute) is split: the chain-neutral watch with `FakeApproval` and `worker.ts` first, then Squads `readProposal`, `prepareExecution` and `closeProposal`; blocked by #74. #88 adds the `timed_out` branch, the window and the late-execution search (`getSignaturesForAddress` on Squads, a `safeTxHash` match on Safe). #83, #84 and #85 each shrink to a `SafeApproval` implementation under `base/safe/`; #85 is only `estimateApprovalCost` plus the L1 data fee and the committed amounts.

## 7. Open points the design flagged

- Execute-transaction expiry and fee-bump go through new branches in `resubmitExpired` and need explicit tests (`blockhash-retry`-style on Solana, `fee-bump-e2e`-style on Base).
- Rent is committed on the member key until the proposal is closed: compute it from `getMinimumBalanceForRentExemption` and store it in `committed`.
- A failed Squads execute is retried through `reopenProposalForExecution` until the deadline; failed attempts are recorded in `attempts`, and the failed hash is kept on the proposal.
