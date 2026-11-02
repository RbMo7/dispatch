Status: decided 2026-11-01; ADR-0061, ADR-0062, ADR-0063 accepted; tickets below

# Flow coverage: every kind of Dispatch, seen and explained in the console

Builds on `.scratch/web-console/spec.md`, `.scratch/flag-rules/spec.md`, `.scratch/named-senders/spec.md`. ADRs: 0018, 0027, 0029, 0049, 0054, 0057, 0059, 0060; new 0061, 0062, 0063.

## Problem Statement

Only plain SOL payments have been seen live in the console. Several other flows have weak spots:

- **Custom assets.** A token must already be in an environment variable. Adding one means a restart. The console shows only the symbol the operator typed, never the token's real name.
- **Contract calls.** A call shows its target address and nothing else: not which function ran, what value it carried, or what it changed on chain.
- **Multisig.** A multisig Proposal shows "1 of 2" but not who approved and who still needs to.
- **Rejected requests.** A Dispatch refused at submission (for example `UNKNOWN_ASSET`) leaves no trace an operator can see. Item errors show a code, but not always a reason a person can act on.
- **Unseen flows.** Relay, Bulk Call, fee bump, Solana expiry, partial, abandoned and multisig flows are covered by unit tests only.

## Solution

Six parts:

1. **Live flow coverage.** Run every flow on Solana devnet and Base Sepolia and record it in the console.
2. **Known assets managed from the console**, per chain. The token's name, symbol and decimals are read from the chain, never typed in (ADR-0061).
3. **The asset's real name** shown wherever an asset appears.
4. **Calls explained.** The function and its arguments come from a contract registry (ABIs and IDLs added from the console) plus built-in standard decoders. What the call changed comes from the confirmed transaction's effects, recorded by the worker (ADR-0063).
5. **Approvers.** Who approved, who has not, and how many approvals are still needed.
6. **Errors where they happen.** Every item and Dispatch error is shown with a plain explanation and what to do. Requests refused at submission are recorded and listed in the console (ADR-0062).

## User stories

1. As an operator, I want to add a token to a chain from the console by pasting its mint or contract address, and see its real name, symbol and decimals before I confirm.
2. As an operator, I want every amount to show the asset's real name ("USD Coin, USDC"), not just a symbol I typed.
3. As an operator, I want a contract call to say which function ran with which arguments ("transfer(to: 0x8b21…44fe, amount: 1,250.00 USDC)"), and what it changed on chain ("USDC moved from the Sender to 0x8b21…44fe").
4. As an operator of a Multisig Sender, I want to see who approved a Proposal, who has not, and how many more approvals are needed.
5. As an operator, I want any error shown where it happened, with what it means and what to do. That includes a request the engine refused before it was stored, such as a payment in an asset that is not configured.
6. As a reviewer, I want screenshots of every flow from a real run, so I can trust the console shows each one correctly.

## Design

### Known assets (ADR-0061)

- **Storage.** A `known_assets` table, one row per (chain, address): symbol, name, decimals, kind (`native`, `spl`, `token-2022`, `erc20`), source (`config` or `console`), who added it (token kind), when, and an `enabled` flag.
- **Startup seeding.** At startup, the `*_KNOWN_TOKENS` variables seed rows with source `config`. Those rows are read-only in the console, and the variables keep working as before.
- **API.**
  - `GET /v1/assets?chain=` takes either token.
  - `POST /v1/assets/preview` and `POST /v1/assets` take the operator token. They receive `{ chain, address, symbol? }`. The engine reads the mint or contract from the chain: decimals, name and symbol (ERC-20 `name()` and `symbol()`; on Solana, the Token-2022 metadata extension or the Metaplex metadata account).
  - It refuses an address that is not a token, and a symbol that is already used on that chain. An optional symbol overrides an empty or clashing on-chain symbol.
  - `PATCH /v1/assets/:id` disables or enables an asset; config rows can't be changed. Nothing is ever deleted, so history keeps resolving.
- **Effect on the engine.** Payment translation, the Funding Check, decimals in responses, Flag Rule limits and `doctor` all read the registry instead of the parsed variables. The registry is cached in the API and the worker and refreshed on change (the API notifies through Postgres `LISTEN/NOTIFY`, or a short poll as fallback).
- **Console.** A page called "Assets": chains as tabs (enabled chains only), one row per asset (name, symbol, address, decimals, source, enabled), and "Add asset" for operators. "Add asset" is a form: paste an address, see a preview read from the chain (name, symbol, decimals, supply), then confirm. Every change goes to the Activity log.

### Asset names

Every Amount gets the asset's name from the registry, held at the console's API boundary: the payment rows, totals, Items, export columns and Sender balances. Rows show the symbol and the name appears on hover. Details, Items and the asset page show both. Exports gain an `asset_name` column.

### Calls explained (ADR-0063)

- **Contract registry.** A `known_contracts` table, one row per (chain, address): a label, and an ABI (Base) or Anchor IDL (Solana). It is added from the console by operators (paste the JSON), validated at the boundary, with source and activity recorded.
- **Built-in decoders, no registration needed.**
  - On Base: ERC-20, ERC-721, ERC-1155, WETH and Multicall3.
  - On Solana: System, SPL Token, Token-2022, Associated Token Account, Memo and Compute Budget.
- **Decoding the call.** At read time, the engine decodes each `call` item's data against the registry and the built-ins: the function name and named, typed arguments, with amounts formatted by the asset registry. When nothing matches, it shows the 4-byte selector (Base) or the program and instruction discriminator (Solana), plus the raw data. The engine never calls third-party signature services.
- **Recording effects.** When a transaction confirms, the worker reads it once and stores its raw effects:
  - On Base: the receipt logs, the value moved and the gas paid.
  - On Solana: the token and lamport balances before and after, the instruction list and the log messages.

  These are stored in `transaction_effects`. Stored raw, they are decoded at read time, so an ABI added later also explains past calls.
- **What the console shows.**
  - "Effects": token transfers (from, to, amount with the asset name), native value moved, fee paid, and decoded events for known contracts.
  - Undecodable logs are shown as "N events from 0x… (no ABI)", with a link to add one.
- **API.** Item reads gain `call: { function, args, decoded }` and an `effects` block. Both are documented in OpenAPI and covered by the contract test.
- **Console.** Items and Details mark a call ("Call") and show the target's label, function and arguments, value and effects. The flow's "Signed and sent" stage names the function for a single call.

### Approvers

- **Engine.** When the Approval watch reads a Proposal, it also records the members and who approved, rejected or abstained. On Squads, that comes from the multisig account and the proposal account. On Safe, it comes from the owners and the Safe Transaction Service confirmations.
- **API.** The `approval` block gains `approvers: [{ address, label?, decision: approved | rejected | pending }]` and `remaining`. Labels come from an optional `approvers` map per Sender in the senders file.
- **Console.** The approval stage reads "1 of 2 approved, 1 more needed", lists the approvers with their decisions, and keeps the deadline and the "Open in Squads/Safe" link. The engine still never approves (ADR-0049).

### Errors (ADR-0062)

- **Error catalogue.** One table in the console maps every error code to a title, a plain explanation and a next step, using the error's `chainDetail` (the asset, the shortfall, the deadline):
  - `UNKNOWN_ASSET`: "USDT is not a known asset on Base. Add it under Assets, then send again."
  - `INSUFFICIENT_FUNDS`: "payouts is short 40.00 USDC. Fund 0x8b21…44fe." with a link to the Sender.
  - `SIGNER_REFUSED`: "The Signer's policy refused this transaction: <reason>."
  - The same for every code in the docs' error list.

  Item errors, Dispatch errors and the flow's failure stages all use the catalogue.
- **Rejected requests.** A refused `POST /v1/dispatch` (any 4xx except 401) is recorded in `rejected_requests`: time, chain, the Idempotency-Key, which token was used, the error code and message, and the request body with every item kept. These rows are kept for 30 days and capped at 10,000 rows.
- **API.** `GET /v1/rejected` (operator token).
- **Console.** A "Rejected" page lists them newest first, with the catalogue's explanation and a "fix" link where one exists (for example `UNKNOWN_ASSET` links to Assets with the address prefilled). Overview's Needs attention counts the last 24 hours.

### Live flow coverage

A scripted run (kept in the repo under `scripts/flows/` so it can be repeated) drives each flow on a real engine and saves console screenshots of the Flow, Items and Details views, plus the Rejected and Assets pages.

| # | Flow | Where | How it is triggered |
|---|---|---|---|
| 1 | Payments in a configured SPL token and a Token-2022 token | devnet | Test mints created by the run |
| 2 | Payments in an ERC-20 | Sepolia | A test token deployed by the run |
| 3 | A payment in an unconfigured asset | Sepolia | Refused with `UNKNOWN_ASSET`; then added from Assets and sent again |
| 4 | A Base call with `value` | Sepolia | A test contract deployed by the run, its ABI added in the console |
| 5 | A Solana program call | devnet | Memo plus an SPL transfer as raw calls |
| 6 | Relay | Both chains | Transactions signed outside the engine |
| 7 | Bulk Call, `allowFailure: false` | Sepolia | Through an aggregator the run deploys |
| 8 | Partial | Either chain | One item to an invalid recipient or underfunded |
| 9 | Fee bump | Sepolia | Retry Policy on, a deliberately low starting fee |
| 10 | Solana expiry and resend | devnet | A deliberately stale blockhash |
| 11 | Squads multisig | devnet | A fresh 2-of-3 created by the run with test keys; one approval, then the second; one Proposal left to time out (short deadline) |
| 12 | Safe multisig | Sepolia | A fresh Safe created by the run, if the Safe Transaction Service on Sepolia allows it with a test API key; otherwise stated |
| 13 | Held, released and cancelled | Either chain | As in the Flag Rules runs |
| 14 | Named Senders | Either chain | As in the named-Senders runs |

## Out of scope

- Decoding through third-party signature services, and automatic ABI fetching from explorers. Operators paste ABIs and IDLs.
- Simulating calls before sending. The engine sends calls as given (ADR-0018).
- Editing a config-sourced asset from the console. Change the variable instead.
- Listing approvers for Proposals the engine did not create.

## Testing

- **Unit:** the asset registry; on-chain metadata reads against recorded RPC responses; the decoders (each built-in standard, plus a registered ABI and IDL); effect capture from recorded receipts and transactions; the error catalogue (every documented code has an entry, enforced by a test against the OpenAPI error enum); approver mapping for Squads and Safe.
- **Contract test:** extended to the new routes and fields.
- **Postgres tier:** the registry and refresh, the rejected-request retention, effects storage.
- **Live:** the flow-coverage run above, against the final head.

## Proposed issues

1. Live flow coverage, before changes: run what already exists and record what is missing (rows 1, 5 to 10, 13 and 14 of the table, as far as today's engine allows). It produces the baseline screenshots and a list of console gaps.
2. Known-asset registry in the engine: table, config seeding, chain metadata reads, routes, the engine reading the registry everywhere, refresh (ADR-0061).
3. Console: the Assets page and the add-asset flow, and asset names everywhere, including exports.
4. Effects recorded by the worker, and call decoding with built-in decoders (ADR-0063).
5. Contract registry routes, and the console's call view (function, arguments, value, effects, the add-ABI flow).
6. Approvers in the approval block (Squads and Safe), and the console's approval stage.
7. The error catalogue in the console, and the rejected-requests record, route and page (ADR-0062).
8. Live flow coverage, after changes: every row of the table, including Squads and Safe multisig, with screenshots, plus the docs for Assets, contracts, approvers and errors.
