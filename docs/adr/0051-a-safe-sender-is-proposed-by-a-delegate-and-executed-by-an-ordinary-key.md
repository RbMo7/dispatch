# A Safe Sender is proposed by a delegate and executed by an ordinary key

ADR-0049 settled the roles for a Multisig Sender on Squads: the engine proposes and executes, never approves, and gets that from Squads' separate Initiate, Vote and Execute permissions. Safe has no such permissions. Its owners approve, and everyone else is outside the multisig. The same principle needs a different shape on Base.

## Decision

- **The engine's key is never an owner.** It acts in two ways, neither of which can approve a transaction:
  - As an **executor**: an ordinary EOA that submits `execTransaction` with the owners' signatures. Safe lets anyone do this, and the executor pays gas.
  - As a **delegate**: an address an owner has registered with the Safe Transaction Service, which lets it post proposals on the Safe's behalf without being able to confirm them.
- **The engine refuses to start if its key is an owner**, and the Signer's policy pins that key to the one configured Safe (`allowedSafe`).
- **Executing is an ordinary Managed transaction** from the executor, so nonce handling, fee estimation, fee-bump and stuck handling are the existing Base machinery (ADR-0037, ADR-0039), unchanged.
- **Confirmations are counted against the chain, not the service.** The engine takes signatures from the Safe Transaction Service and on-chain `approveHash` approvals, and checks them against the Safe's owner set and threshold read on-chain. The service is a convenience for collecting signatures, never the authority on who may approve.
- **One open proposal per Safe at a time**, since the Safe nonce is sequential and a rejected or stalled proposal blocks every later one. Dispatches that arrive while one is open wait their turn, and each becomes its own proposal, because a proposal never mixes Dispatches (ADR-0054). Only Calls routed through the Safe wait; Relay Dispatch and other chains are never blocked.
- **Bundles use `MultiSendCallOnly`**, a delegatecall from the Safe. Payments then come from the Safe itself, including ERC-20 transfers, which the permissionless-Multicall3 Bulk Call (ADR-0038) could not do.

## Considered options

- **The engine is an owner with a low-weight vote.** Rejected: Safe weights every owner equally, so any engine-held owner key counts toward the threshold, which is the design ADR-0049 rejects.
- **The engine holds only an executor key and proposes through a human.** Rejected: owners would have to post every proposal themselves, so the engine would add nothing over the Safe app.
- **Skip the Transaction Service and have owners sign a hash the engine shows them.** Rejected: owners would need custom tooling to sign and return signatures, instead of the Safe app they already use.
- **Run several proposals at once on consecutive nonces.** Rejected for v1: they would have to execute in order, so one rejected proposal stalls the rest in a way that is hard to explain. Serial is simpler and honest.

## Consequences

- The engine depends on the Safe Transaction Service, hosted by Safe, for proposing and for reading confirmations. The URL is configurable so an operator can run their own.
- An owner registers the engine as a delegate once, outside the engine. The startup check reads the service's delegate list and tells the operator when it is missing. In the Safe app the engine's proposals appear as proposed by that owner (the service records `proposedByDelegate` separately), which the runbook says.
- Anyone, including an owner, can execute a fully confirmed proposal after the engine's deadline; the engine reports that honestly (ADR-0053). After a timeout the next proposal reuses the Safe's current nonce, so only one of the two can ever execute, and a superseded proposal's Calls fail with `APPROVAL_REJECTED` without having been paid.
- A Safe with a guard or a gating module is unsupported in v1.
- A Safe Sender is therefore slower than a plain Sender: one proposal in approval at a time per Safe, with later Dispatches queued behind it. An operator needing throughput uses a Treasury funding a hot Sender, run as a second engine instance (one Sender per chain, ADR-0016).
