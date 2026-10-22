# Solana chain handler

This is the part of the engine that knows how to talk to Solana. This file explains what Solana asks of anyone sending transactions on it, what this handler actually does about that, and roughly how.

## What Solana expects

- A Solana transaction is built against a recent "blockhash," and that blockhash goes stale after a short while. Once it expires, the transaction can never land, no matter how many times you resend it.
- Sending tokens to someone who has never received that token before usually means creating a token account for them first, and that costs a small amount of SOL (called rent).
- Solana does not care about strict ordering the way some other chains do, so multiple transactions can be sent at the same time without waiting for each other.
- When the network is busy, you can pay an extra "priority fee" to get picked up faster.
- Tokens come in two versions: the older SPL Token program, and the newer Token-2022, which works a little differently under the hood.

## What we built

- Both ways of sending are supported: the engine can build and sign a payment itself (Managed Dispatch), or just broadcast something you already signed yourself (Relay Dispatch).
- Native SOL, SPL tokens, and Token-2022 are all handled.
- If a transaction's blockhash expires, we do not just give up or leave it unclear. We can prove for certain that it is dead, and once we know that, we quietly rebuild the same payment as a new transaction and resend it, up to three times, at no extra cost to whoever is paying.
- Before sending a batch, we check the sender actually has enough SOL to cover the payments themselves, the network fee, and the rent for any new token accounts that need to be opened. That way a batch does not fail partway through because of something we could have caught up front.
- Up to four transactions can be sent at once by default, since Solana does not need them to land in a strict order. In our own tests this roughly cut the time for a 40 payment batch in half.
- To make sure we never accidentally pay someone twice, we wait about a minute past the technical expiry point before deciding a transaction is really gone for good.
- All of this has been run and checked against real Solana devnet, not just simulated: real payments, real token transfers, real expired transactions, real transactions sent in parallel.

## How it works

The main entry point is `solana-chain-handler.ts`. It does not try to do everything itself. It pulls in a handful of small, focused files instead:

- `account-resolution.ts` works out a recipient's token account address and creates it if it does not exist yet.
- `instruction-codec.ts` turns our internal call shape into the actual bytes Solana expects, and back again.
- `native-transfer.ts` and `spl-transfer.ts` build the specific instructions for sending SOL and tokens.
- `known-tokens.ts` is just a plain list the operator fills in by hand, token symbol mapped to its mint address and decimal count. Nothing is guessed or looked up automatically.
- `error-mapping.ts` turns whatever the Solana node complains about into a clear, consistent error the rest of the engine understands.
- `contract-call.ts` handles the case where the caller wants to hit a program directly instead of using a plain payment.

Broadcasting and checking on a transaction's status work the same way whether the engine built and signed it, or it arrived already signed from somewhere else. That is what makes Relay Dispatch possible without any special-casing.

## What is not built yet

Durable nonce transactions (a mode some wallets need for offline or delayed signing) are on the roadmap but not built. Without an expiry to rely on, resending one safely would first need a way to cancel the original, which has not been designed yet.
