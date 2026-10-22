# Multisig approval is a Chain Handler capability, and a proposal never mixes Dispatches

ADR-0049 and ADR-0051 settled who does what for a Multisig Sender on Solana and Base. They did not settle where the shared machinery lives: the `AWAITING_APPROVAL` state, the persisted proposal, the watch loop, the deadline and the Funding Check. The Solana tickets would build it first. If they built it inside the Solana handler or the Coordinator with chain checks, the Safe tickets would rewrite it. ADR-0049 said a cross-chain interface should wait for Safe to be the second implementation (ADR-0012). This ADR revises that, and settles one question ADR-0051's accumulation rule left open.

## Decision

- **Approval is an optional capability of the Chain Handler**, `ChainHandler.approval`, in the way `prepareReplacement` (ADR-0037) and `validateBulkCall` (ADR-0038) already are. It carries the chain-specific work only: planning bundles, building and signing a proposal, submitting it (idempotently), reading its status, preparing the execution, estimating what it costs, and closing it. Squads is the first implementation and Safe the second, both measured in the spikes (#70, #79), and the interface is designed against both.
- **The chain-neutral state machine is the Coordinator's**: the claim, the funding check, `UNPROPOSED` to `AWAITING_APPROVAL`, the watch loop, the deadline, the late-execution re-watch (ADR-0053) and the settling of Calls. It lives in a new `ApprovalFlow` the Coordinator delegates to, so the Coordinator holds no Solana or Base knowledge.
- **Every multisig Call gets a Transaction row at claim time.** Two additive Transaction statuses: `UNPROPOSED` (claimed, validated and funded, in no proposal yet; wire status `queued`) and `AWAITING_APPROVAL` (inside a proposal). Outcomes reuse the existing statuses: `PENDING`, then `CONFIRMED` or `FAILED` after execution; `FAILED` with `APPROVAL_REJECTED`; `ABANDONED` with `APPROVAL_TIMEOUT` (ADR-0053). A Transaction may therefore exist without a hash, which the domain already allows for one that was never broadcast.
- **A proposal is persisted before anything is sent** (ADR-0041), in its own `proposals` table that the Transactions reference. A crash is recovered by the watch loop from what was written down.
- **A proposal never mixes Dispatches.** It holds Calls from exactly one Dispatch, and a large Dispatch splits into several proposals. A Safe's one-open-proposal rule (ADR-0051) therefore queues whole Dispatches, not accumulated Calls: a later Dispatch waits its turn and becomes its own proposal. This supersedes the accumulation wording in ADR-0051.
- **No new Dispatch-level status.** While Calls await approval the Dispatch stays in its existing aggregate status; each item shows `awaiting_approval`.
- **The `approval` block is additive** (`docs/api.md`): common fields `state`, `approvals`, `threshold`, `deadline`, `expected`, plus a chain-specific reference (`kind: squads` with multisig, proposal and transaction index, or `kind: safe` with Safe, `safeTxHash` and nonce).

## Considered options

- **Build Squads concretely and extract the interface when Safe lands** (ADR-0012 and ADR-0049's wording). Rejected: the Coordinator would need chain checks meanwhile, or the Safe tickets would rewrite the Squads state machine. Safe is specified, measured and funded, so the second adapter is committed, which is the situation ADR-0012's rule exists to wait for.
- **Let a proposal mix Calls from several Dispatches** (fewer approvals, more throughput). Rejected: no single caller's payment file matches such a proposal, so the independent verifier (#89) cannot check it and ADR-0049's control weakens; `expected` would include other callers' payments; and one Dispatch's Retry Policy and outcome would depend on another's.

## Consequences

- ADR-0012's one-adapter rule is bent for the first implementation, on purpose. If Safe is dropped, this interface has one adapter, and should be revisited.
- `CONTEXT.md` gains **Proposal**, and Transaction gains the two statuses.
- Many small Dispatches mean many small proposals, and so many approvals. An operator whose callers send many small Dispatches should batch them into fewer, larger ones, or use a Treasury with a hot Sender.
- Safe needs committed amounts in the Funding Check too, not only Squads: the open proposal's funds are not yet spent, and without counting them the next proposal's simulation would fail with `GS013`.
- Execution reuses the existing send path unchanged (nonce authority, fee estimation, fee-bump and stuck handling on Base; blockhash expiry and resubmission on Solana). Only the pre-send steps are new.
- ADR-0049's last consequence (the interface waits for Safe) is superseded by this ADR.
