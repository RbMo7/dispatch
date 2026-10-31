# What Dispatch is

Dispatch is an engine you run yourself that gets transactions onto Solana and Base and tells you what happened to each one. You send it payments, contract calls, or a transaction your own user already signed. It sends them, watches them, and reports a status per item until each one lands or definitely does not.

The hard part of sending a transaction is everything after you build it. Nonces have to go out in order. An RPC call times out and you can't tell whether the transaction reached the chain. A Base transaction sits unconfirmed because its fee was too low. A Solana blockhash expires before the transaction lands. Hundreds of payments have to be grouped so they fit and still get a status each. Dispatch handles these cases the same way every time, so the application on top of it only submits work and reads results.

## What you run

Dispatch is three processes and a Postgres database:

- The **API** takes requests on port 8420. It checks and stores each Dispatch and answers status queries. It never signs anything.
- The **worker** picks up stored Dispatches, builds the transactions, gets them signed, sends them, and tracks them to an outcome.
- The **Signer** holds the keys, on port 8421. Only the worker asks it to sign. The API only reads what each key is pinned to, for `GET /v1/senders`. It can hold keys in AWS KMS, in Privy server wallets, in encrypted files, or, for development only, in a plain key file.

The engine never holds a private key. The worker asks the Signer to sign each transaction, and checks every signature it gets back against the Sender's address before it sends anything.

## What it does for you

- **Bulk payouts.** Send hundreds or thousands of payments in one request. Each one gets its own status. On Solana the engine packs several payments into one transaction. On Base it sends one transaction per payment in nonce order, or bundles them through an aggregator contract you name.
- **Reliable sends from one wallet.** A backend that fires many transactions from one wallet gets nonce ordering, rebroadcasts, and confirmation tracking without writing its own.
- **Delivery for transactions your users signed.** A DEX or wallet app hands over a signed transaction. The engine broadcasts it, resends it if it stalls, and reports when it lands. The engine never sees the user's key.
- **People who approve the money.** A Squads multisig on Solana or a Safe on Base can be the Sender. The engine proposes each run of payments, your Approvers vote in the Squads or Safe app, and the engine executes once enough of them approve.
- **A console and these docs.** The API process serves an operator console at `/console` and this site at `/docs`.

## What it is not

- **Not a wallet.** It has no user accounts and no key for any end user. A Relay Dispatch is delivery only.
- **Not a hosted service.** You run it, you configure its RPC endpoints, and you fund its Senders.
- **Not a signer with opinions about your business.** The Signer's policy can cap amounts per transaction and limit which contracts a key may call. Rules about who you pay and how much per day belong in your application.
- **Not synchronous.** `POST /v1/dispatch` answers `202 Accepted` with an id. You poll `GET /v1/dispatch/:id` for the result. There are no webhooks yet ([ADR-0023](./adr/0023-polling-required-webhooks-later.md)).
- **Not every chain.** It ships Solana and Base. Ethereum L1 would be its own chain and is not built ([ADR-0035](./adr/0035-base-and-ethereum-are-separate-chains.md)). Adding a chain means adding a chain handler, never changing the engine's core.

## Where things stand

Both chains are proven end to end against their test networks: Solana devnet, including a run of 500 payments, and Base Sepolia, including a run of more than 100 transactions with a real fee bump and an on-chain nonce audit. Multisig Senders are proven against devnet and Base Sepolia. Nothing has run on mainnet yet, and the AWS KMS backend is proven only against mocks ([issue #61](https://github.com/RbMo7/dispatch/issues/61)). Clear the [mainnet checklist](./operations/mainnet-checklist.md) before you send real money.

Not built yet: webhooks, Ethereum L1, a pool of several Senders per chain ([ADR-0016](./adr/0016-sender-pool-deferred.md)), and Solana durable nonces ([ADR-0048](./adr/0048-durable-nonce-execution-is-deferred.md)).

## Next

- [Quickstart](./quickstart.md) takes you from a clone to a confirmed payment on Base Sepolia or Solana devnet.
- [Managed and Relay Dispatch](./concepts/managed-and-relay.md) explains the two ways to use the engine.
- The [glossary](../CONTEXT.md) defines every term these pages use.
