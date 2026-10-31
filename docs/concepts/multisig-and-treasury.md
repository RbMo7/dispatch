# Multisig Sender and Treasury

Two patterns put people in the loop before money moves. They use the same multisig wallets, Squads v4 on Solana and Safe on Base, in different places. They are independent: a deployment can use either, both, or neither.

## Treasury: a multisig that tops up a hot Sender

A Treasury is a multisig that holds most of the funds and is never itself a Sender. The engine pays from an ordinary Sender with a working balance, and the Approvers move money from the Treasury to that Sender when it runs low.

The engine does not know the Treasury exists. Nothing in its settings changes. When the Sender runs short, the [Funding Check](./funding-check.md) fails the payments it cannot cover with `INSUFFICIENT_FUNDS`, and `chainDetail.short` is the exact top-up.

What a Treasury buys you: payments go out as fast as from any Sender, and a stolen Sender key loses only the working balance. Size that balance to what you accept losing, and set the Sender's Signer policy caps to match.

## Multisig Sender: the multisig pays, Approvers vote on every run

A Multisig Sender is a Sender whose address is a multisig: the Squads vault, or the Safe. The engine cannot sign for a multisig, so it acts through a key of its own:

- On Solana, the **member key**, a member of the Squads multisig with exactly the Initiate and Execute permissions. It can never vote.
- On Base, the **executor**, which is not an owner of the Safe. An owner registers it as a delegate so it can post proposals.

For each Dispatch, the engine groups its payments into one or more [Proposals](./proposals.md), posts them, and waits. The **Approvers**, people holding their own keys in their own wallets, vote in the Squads app or the Safe app. Once enough of them approve, the engine executes the Proposal and the items go to `broadcasting`, then `confirmed`.

The engine proposes and executes, and never approves ([ADR-0049](../adr/0049-the-engine-proposes-and-executes-multisig-transactions-but-never-approves.md)). No host the engine runs on, and no key the Signer holds for it, can reach the threshold. The engine refuses to start if its key could vote or is an owner, and the Signer's policy pins that key to the one multisig, so it can sign nothing else ([ADR-0055](../adr/0055-the-signer-reports-its-pins-and-the-engine-checks-them-at-startup.md)).

A Multisig Sender only proposes transfers: native SOL, SPL and Token-2022 tokens on Solana, and ETH and ERC-20 tokens in `BASE_KNOWN_TOKENS` on Base. A `call` item it cannot describe, or a `bulkCall`, is refused at `POST /v1/dispatch` with `400 CHAIN_REJECTED` naming the item.

## Choosing

| | Treasury | Multisig Sender |
| --- | --- | --- |
| Where the funds sit | Most in the multisig, a working balance in a hot Sender | All in the multisig |
| Who approves | M of N approve each top-up | M of N approve every payment run |
| Engine settings | None. The Sender is configured as usual. | `SOLANA_SENDER_MODE=multisig` or `BASE_SENDER_MODE=safe`, and more |
| A stolen Sender key loses | The working balance | Nothing, if the Signer's policy holds. The engine's key can only propose and execute. |
| Throughput | As fast as a plain Sender | One approval round per Proposal. On Base, one Proposal in flight per Safe at a time. |
| Failure when short | `INSUFFICIENT_FUNDS`, naming the top-up | `INSUFFICIENT_FUNDS`, naming which balance is short |

Choose a Treasury when you accept a hot wallet with a bounded balance and you want speed. Choose a Multisig Sender when no single key or host may move a payment run on its own.

If your callers send many small Dispatches, a Multisig Sender produces many small Proposals, because a Proposal never mixes Dispatches, and every one needs its own votes. Use a Treasury and a hot Sender for that traffic.

## What an Approver has to do

Approvers are the control, so they have to actually check. A Proposal lists the payments it makes. An Approver compares those with their **own record** of the payments, such as the payment file the run came from, before voting. The `expected` totals the engine reports are written by the same engine that wrote the Proposal, so matching them proves nothing. The independent verifier in `verifier/` reads the Proposal from the chain and compares it with a payment file. [Multisig](../multisig.md#for-approvers) has the Approvers' page to hand them.

## Next

- [Proposals and approvals](./proposals.md): the life of a Proposal, deadlines and timeouts
- [Multisig](../multisig.md), then [Squads on Solana](../guides/squads.md) or [Safe on Base](../guides/safe.md), to set one up
