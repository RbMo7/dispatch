# Durable Nonce Execution is deferred until a Sender needs it

ADR-0007 made Durable Nonce Execution an opt-in Solana submission mode for a Sender that needs offline or async signing, or that hits blockhash expiry at very high volume. #44 held it for a design decision. A durable-nonce transaction never expires, so a stuck one never becomes provably dead, and ADR-0042's safe resubmission no longer applies: signing a replacement could land both and pay twice.

Neither reason for the mode applies today. The engine always signs online, through the Signer (ADR-0002, ADR-0046). Blockhash expiry is handled by resubmission after provable expiry (ADR-0042, ADR-0045), and the 500-payment devnet volume run passed on it. Relay Dispatch already accepts durable-nonce transactions that callers sign themselves and never treats them as expiring.

## Decision

- Durable Nonce Execution for Managed Dispatch is not built. It is revisited when a Sender needs offline signing, or when Solana volume shows expiry failures that resubmission doesn't absorb.
- If it is built, a stuck transaction is cancelled before it is replaced: the engine sends an advance-nonce transaction, waits for it to confirm, which makes the original permanently invalid, and only then signs the replacement against the new nonce. Resending identical bytes until an operator steps in (the alternative) leaves a stuck payment stuck.

## Consequences

- ADR-0007's opt-in mode stays on the roadmap, not in the code. The default mode is the only Managed Dispatch mode on Solana.
- #44 is closed as not planned and points here.
