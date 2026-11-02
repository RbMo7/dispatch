# The Funding Check admits each Dispatch in claim order, and fails a Dispatch whole

Accepted 2026-11-02. Amends ADR-0024 and ADR-0043. Issue #132.

The Funding Check (ADR-0024) summed each asset's requirement across the whole claimed batch, and ADR-0043 added one network cost estimate shared by every Call of the batch. A shortfall failed every item behind that requirement. On Solana devnet the worker claimed several Dispatches at once. One of them carried 1,000 payments totalling 21.3 SOL, more than the Sender held, and every Dispatch in the batch failed with `INSUFFICIENT_FUNDS`. Two small ones failed with it, although the balance covered each of them alone. Whether a payment failed depended on which other Dispatches the worker happened to claim with it.

## Decision

- **Per Dispatch, in claim order.** The check takes the claimed Dispatches oldest first and keeps a running total per payer and asset. A Dispatch fits when, for each of its requirements, the running total plus what it needs is within the balance (less what open Proposals hold back, ADR-0053). One that fits is admitted and its amounts join the totals.
- **Keep going.** A Dispatch that does not fit fails, and the check goes on to the next one, so a smaller Dispatch claimed after it can still be admitted. The failed one is final. It is not requeued; the "wait and resume once funded" mode ADR-0024 left for later stays out of scope.
- **Whole Dispatch.** A Dispatch that does not fit fails every one of its items with the same `INSUFFICIENT_FUNDS`, whose `chainDetail` names the first short requirement. Nothing of it has been signed, so no half-funded Dispatch goes out. This replaces the per-asset failure that let a Dispatch end `partial` at the Funding Check.
- **`short`** is how much more the payer needs for this Dispatch on top of those admitted before it in the batch.
- **Network cost per Dispatch.** `networkCost`, or `estimateApprovalCost` for a Multisig Sender, is asked for each Dispatch's own Calls. Bundling across Dispatches can make the sum over-ask, which ADR-0043 already allows: it can over-ask, never under-ask. An estimate that fails fails only that Dispatch.
- **Each balance is read once per batch**, and committed amounts once per holder. A balance read that fails fails every Dispatch that needs that asset from that payer.
- **The store returns a claimed batch oldest first.** Postgres `RETURNING` promises no order, so the claim sorts the rows it returns into the order it selected them in.

## Consequences

- One oversized Dispatch no longer fails unrelated payments claimed with it.
- A Dispatch that carries several assets either goes out whole or fails whole at the Funding Check. It can still end `partial` later, when the chain refuses some of its transactions.
- One cost estimate per Dispatch instead of one per batch. On Solana that is one batched account lookup per Dispatch, so a claim of many small Dispatches makes more RPC calls than before.
