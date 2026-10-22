# Base chain handler

This is the part of the engine that knows how to talk to Base. This file explains what Base asks of anyone sending transactions on it, what this handler actually does about that, and roughly how.

## What Base expects

- Base is an Ethereum style chain, so every transaction needs a gas fee, and each one must go out in strict order, one after another, with no gaps in the sequence number (the nonce).
- If a transaction sits in the mempool too long without confirming, it may need to be resent, sometimes with a higher fee so it actually gets picked up.
- Normally, paying many people means sending one transaction per person.
- Token transfers usually go through the ERC-20 standard.

## What we built

- Both ways of sending are supported: the engine can build and sign a payment itself (Managed Dispatch), or just broadcast something you already signed yourself (Relay Dispatch).
- Native ETH and ERC-20 tokens are both handled.
- Bulk Call: instead of one transaction per payment, many payments can go out together in a single transaction, through a shared, public contract called Multicall3 that the caller names themselves. By default the whole batch either lands together or fails together, which keeps the result simple and predictable. If you want to know exactly which individual payment in the batch failed, that is possible too, but it needs a special kind of RPC connection that can trace a transaction, which is usually a paid service.
- If a transaction sits unconfirmed for 60 seconds, we treat it as stuck. If the sender turned on Retry Policy, we rebuild it with a higher fee at the same spot in the queue, up to five times. If Retry Policy is off, we simply resend the exact same transaction again, for free.
- A transaction's spot in the queue (its nonce) is only claimed at the moment it is actually signed. If signing or sending gets refused, that spot is handed back right away, so nothing behind it ends up stuck waiting on a gap that will never fill.
- Every transaction is written down in our database, hash and all, before we ever send it. So if we crash or the network times out right after sending, we never lose track of a payment that might still land.
- Once a payment confirms, we keep re-checking it for another 10 minutes, in case the chain briefly reorganizes and un-confirms it.
- All of this has been run and checked against real Base Sepolia, not just simulated: native transfers, ERC-20 transfers, raw contract calls, bulk calls, stuck transaction handling, and a volume run of 100+ real transactions (which only happens when someone deliberately asks for it, since it spends real test ETH).

## How it works

The main entry point is `base-chain-handler.ts`. It does not try to do everything itself. It pulls in a handful of small, focused files instead:

- `fee-estimation.ts` works out what gas fee a transaction should use.
- `nonce-authority.ts` hands out and tracks each transaction's spot in the queue.
- `bulk-call.ts` builds a batched Multicall3 transaction and can read back individual results if a tracing RPC is configured.
- `known-tokens.ts` is just a plain list the operator fills in by hand, token symbol mapped to its contract address and decimal count. Nothing is guessed or looked up automatically.
- `erc20.ts` builds the actual token transfer calls.
- `error-mapping.ts` turns whatever the node complains about into a clear, consistent error the rest of the engine understands.
- `transaction-codec.ts` handles turning a transaction into bytes and back, so it can be written to the database and picked up again later.

## What is not built yet

Ethereum's own mainnet is not treated as the same chain as Base, even though they share the same transaction format. Base has its own fee model and confirmation behavior, so if Ethereum L1 support is ever added, it will be built as its own separate chain handler rather than a variant of this one.
