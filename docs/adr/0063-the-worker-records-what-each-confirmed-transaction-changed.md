# The worker records what each confirmed transaction changed

Accepted 2026-11-01.

A contract call is opaque to the engine (ADR-0018, ADR-0027): it sends the bytes it was given. Operators asked to see which function a call ran and what it changed. Spec: `.scratch/flow-coverage/spec.md`.

## Decision

- When a Transaction confirms, the worker reads it from the chain once and stores its raw effects: on Base the receipt logs, value moved and fee paid; on Solana the token and lamport balances before and after, the instructions and the log messages.
- Decoding happens when the effects are read, against built-in standard decoders and a contract registry of ABIs and IDLs that operators add from the console. An ABI added later therefore explains earlier calls too.
- The call's own data is decoded the same way. With no match, the raw selector or discriminator and data are shown. The engine never asks a third-party service to guess a function signature.
- **The contract registry** (`known_contracts`, built in #164) holds one row per registration: chain, address, label, the ABI or Anchor IDL exactly as pasted, who added it and when, and an enabled flag. The ABI or IDL is parsed at the route, so a malformed one is refused (`INVALID_ABI`, `INVALID_IDL`) with where it is wrong, and never stored.
- **Built-in decoders win over the registry**, so a registration can label a standard token but never change how its transfers read.
- **At most one enabled registration per address.** A registration is never edited or deleted: a wrong ABI is disabled and a new one added (`CONTRACT_EXISTS` otherwise). Old Dispatches therefore always decode against a definition the activity record can name. Every add, disable and enable is an Operator Action (ADR-0057).
- The API holds the registry in memory and refreshes it on a Postgres notification from a trigger on the table, as the Known Asset registry does (ADR-0061).

## Considered options

- **Let an operator edit a registered ABI.** Rejected: a call decoded last week would silently read differently today, with no record of why. Disabling and adding keeps both definitions and the reason.

- **Decode and store the decoded result at confirmation.** Rejected: decoding would be frozen to whatever ABIs existed then.
- **Read the transaction from the chain on every console view.** Rejected: an RPC call per view, and old transactions can age out of a node's history.
- **Look up unknown selectors in a public signature database.** Rejected: it sends what an operator is paying for to a third party, and a guessed signature can be wrong.

## Consequences

- One read per confirmed Transaction in the worker, and a `transaction_effects` table that grows with volume.
- The engine still never interprets a call before sending it; effects describe what happened, not a promise of what will.
