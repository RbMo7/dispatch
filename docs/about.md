# About Dispatch

Dispatch is an engine you run yourself that gets transactions onto Solana and Base and tells you what happened to each one. You send it payments, contract calls, or a transaction your user already signed. It sends them, watches them, and reports a status for every item until each one lands or definitely does not.

## What it does for you

Building a transaction is the short part of the job. After that, nonces have to go out in order. An RPC call times out and you cannot tell whether the transaction reached the chain. A Base transaction sits unconfirmed because its fee was too low. A Solana blockhash expires before the transaction lands. Hundreds of payments have to be grouped so they fit, and each still needs a status of its own. Dispatch handles each of these cases the same way every time, so your application only submits work and reads results.

- **Bulk payouts.** Send hundreds or thousands of payments in one request, and get a status for each. On Solana the engine packs several payments into one transaction. On Base it sends one transaction per payment in nonce order, or bundles them through an aggregator contract you name.
- **Reliable sends from one wallet.** A backend that sends many transactions from one wallet gets nonce ordering, rebroadcasts and confirmation tracking without writing its own.
- **Delivery for transactions your users signed.** A DEX or a wallet app hands over a signed transaction. The engine broadcasts it, resends it if it stalls, and reports when it lands. It never sees the user's key.
- **People who approve the money.** A Squads multisig on Solana or a Safe on Base can be the wallet that pays. The engine proposes each run of payments, your Approvers vote in the Squads or Safe app, and the engine executes once enough of them approve.
- **A person looks before money moves.** [Flag Rules](./guides/flag-rules.md) hold a Dispatch that matches a condition you set, such as a payment over a limit or to a new recipient, until someone with the operator token releases it.
- **Answers you can read.** Every call is decoded where a built-in decoder knows it, every confirmed transaction records what it moved and what it cost, and every error comes with a code and the chain's own reason.
- **A console and these docs.** The API process serves an operator console at `/console` and this site at `/docs`.

## How one request flows

1. You call [Create a Dispatch](./openapi.yaml#create-a-dispatch) with a list of items. The API checks the request, stores it, and answers `202 Accepted` with an id. Nothing has touched the chain yet.
2. Within a few seconds the worker claims the Dispatch. It checks that the wallet can pay, builds the transactions, gets each one signed by the Signer, writes it down, and sends it.
3. You call [Get a Dispatch](./openapi.yaml#get-a-dispatch) until every item is final: `confirmed`, `failed`, `abandoned` or `cancelled`.

The [Quickstart](./quickstart.md) runs those three steps against a test network in about 20 minutes.

## The words these docs use

- **Dispatch.** One request to send something on one chain. It has an id, a status, and one or more items.
- **Managed Dispatch.** You describe what to send as `items`, and the engine builds and signs each transaction with your wallet's key. This is the default.
- **Relay Dispatch.** You hand over one transaction someone else already signed. The engine only delivers it. [Send a transaction your user already signed](./guides/relay.md) compares the two.
- **Payment and Call.** An item is a `payment` (an asset, an amount and a recipient) or a `call` (a contract or program call you encoded yourself). Every payment becomes a call before it reaches the chain.
- **Sender.** The wallet a Managed Dispatch pays from. A chain can have several, each with a name, and a request picks one with `sender`. [Send from more than one Sender](./guides/multiple-senders.md) sets them up.
- **Known Asset.** A coin or token a payment may name by symbol: the chain's native coin, or a token the operator listed. [Add a token with Known Assets](./guides/assets.md) adds one.
- **Signer.** A separate service that holds the Sender's key and signs on request. The engine never holds a private key.
- **Funding Check.** Before the engine signs anything, it checks that the Sender can afford the payments and, on Solana, the fees. A shortfall fails the affected items at once with `INSUFFICIENT_FUNDS`.
- **Retry Policy.** Whether the engine may pay a higher fee to get a stuck Base transaction through. Off unless you turn it on.
- **Multisig Sender.** A Sender that is a Squads multisig or a Safe. Its payments wait for Approvers to vote on a **Proposal** before the engine executes them.

## What you run

Dispatch is three processes and a Postgres database:

- The **API** takes requests on port 8420. It checks and stores each Dispatch and answers status queries. It never signs anything and never calls the Signer.
- The **worker** picks up stored Dispatches, builds the transactions, gets them signed, sends them, and tracks them to an outcome.
- The **Signer** holds the keys, on port 8421. Only the worker calls it. It can hold keys in AWS KMS, in Privy server wallets, in encrypted files, or, for development only, in a plain key file.

The worker checks every signature it gets back against the Sender's address before it sends anything. [Install and run](./self-hosting/install.md) sets all of this up.

## What it is not

- **Not a wallet.** It has no user accounts and no key for any end user. A Relay Dispatch is delivery only.
- **Not a hosted service.** You run it, you configure its RPC endpoints, and you fund its Senders.
- **Not a place for business rules.** The Signer's policy can cap the amount one transaction moves and limit which contracts a key may call, and Flag Rules can hold a Dispatch for a person to look at. Rules about whom you may pay belong in your application.
- **Not synchronous.** `POST /v1/dispatch` answers `202 Accepted` with an id, and you [poll for the result](./polling.md). There are no webhooks yet.
- **Not every chain.** It supports Solana and Base. Ethereum L1 would be a chain of its own and is not built. Adding a chain means adding a chain handler, never changing the engine's core.

## Where things stand

Both chains are proven end to end against their test networks: Solana devnet, including a run of 500 payments, and Base Sepolia, including a run of more than 100 transactions with a real fee bump and an on-chain nonce audit. Multisig Senders are proven against devnet and Base Sepolia. Nothing has run on mainnet yet, and the AWS KMS backend is proven only against mocks ([issue #61](https://github.com/RbMo7/dispatch/issues/61)). Clear the [mainnet checklist](./self-hosting/mainnet.md) before you send real money.

Not built yet: webhooks, Ethereum L1, a pool of Senders that shares one stream of work, a registry for your own contract ABIs and program IDLs, and Solana durable nonces. [What's new](./changelog.md) lists what this release adds.

## Next steps

- [Quickstart](./quickstart.md): from a clone to a confirmed payment on Base Sepolia or Solana devnet.
- [Making requests](./making-requests.md): the base URL, JSON, amounts and idempotency keys.
- [The Dispatch lifecycle](./lifecycle.md): what each status means for your code.
