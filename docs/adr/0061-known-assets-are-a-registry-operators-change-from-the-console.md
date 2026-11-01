# Known assets are a registry operators change from the console

Accepted 2026-11-01. Amends ADR-0029 (an unknown asset is refused) only in where the list of known assets lives.

Paying in a token needs it listed in `SOLANA_KNOWN_TOKENS` or `BASE_KNOWN_TOKENS`, and changing those needs a restart. Operators asked to add assets per chain from the console. Spec: `.scratch/flow-coverage/spec.md`.

## Decision

- Known assets live in a `known_assets` table, one row per chain and mint or contract. The environment variables still work: they seed read-only rows at startup.
- An operator (operator token, ADR-0057) adds an asset by address. The engine reads its decimals, name and symbol from the chain and refuses an address that is not a token; decimals are never typed in, because a wrong value would scale every amount. Assets are disabled, never deleted, so history keeps resolving.
- Every engine path that needed the parsed variables (payment translation, the Funding Check, reported decimals, Flag Rule limits, setup checks) reads the registry. The API and the worker cache it and refresh on change.

## Considered options

- **Keep assets in configuration, and let the console write the config file.** Rejected: the console runs in the API process, which should not rewrite server configuration, and a restart would still be needed.
- **Accept any token address on a payment.** Rejected: ADR-0029 refuses unknown assets on purpose, so a typo in a mint never sends funds to the wrong token.

## Consequences

- Anyone holding the operator token can make a new token payable. The Signer's policy still bounds what each Sender can sign.
- One more table and a cache refresh path in both processes.
