Status: drafted 2026-11-01; ADR-0060 proposed; not ticketed; open questions at the end

# Named Senders: several Senders per chain, chosen per Dispatch

ADRs: 0016 (Sender Pool, deferred), 0019, 0022, 0024, 0046, 0049, 0051, 0054, 0055, 0059; proposed 0060.

## Problem Statement

An application built on Dispatch often sends two kinds of payment from the same chain:
- **Routine payouts** that should go out straight away from a hot wallet.
- **Large or sensitive transfers** that must wait for on-chain approval from a multisig.

Today the engine has exactly one Sender per chain, and that Sender is either plain or a Multisig Sender. So either every Solana payment waits for Approvers, or none does. The only partial answer is Flag Rules, which hold a payment inside the engine but give no on-chain approval.

## Solution

An operator configures several **named Senders** per chain, each with its own key, signing mode (plain, Squads or Safe), balances and nonce. A Managed Dispatch names the Sender it pays from:

```json
{ "chain": "solana", "sender": "treasury", "items": [ … ] }
```

A Dispatch without `sender` pays from the chain's default Sender, so every existing caller keeps working unchanged. Each Sender behaves exactly as a lone Sender behaves today: its own Funding Check, nonce sequence, Proposals and startup checks.

## User stories

1. As an application developer, I want to send routine payouts from a hot Sender and treasury transfers from a multisig Sender on the same chain, choosing per request.
2. As an existing caller, I want my requests without a `sender` field to behave exactly as before.
3. As an operator, I want to name Senders for what they are for ("payouts", "treasury"), not by address.
4. As an operator, I want each Sender's balance, committed amounts and key pins in the console, and to filter Dispatches by Sender.
5. As an operator, I want a stuck transaction or a pending Proposal on one Sender to never delay another Sender's Dispatches.
6. As an Approver, I want Proposals that come only from the multisig Sender, exactly as today.

## Design

### Configuration

- **A senders file** (`SENDERS_FILE`, default `senders.json`) lists the Senders per chain:

  ```json
  {
    "solana": {
      "default": "payouts",
      "senders": {
        "payouts": { "address": "9wFd…mT3a" },
        "treasury": { "mode": "squads", "multisig": "Gx7k…Q2rv", "memberKey": "3fJt…WoZe" }
      }
    },
    "base": {
      "default": "payouts",
      "senders": { "payouts": { "address": "0x8b21…44fe" } }
    }
  }
  ```

  A Sender's fields mirror today's per-chain variables: address; mode `single`, `squads` or `safe`; the multisig or Safe; the member key or executor; and the Safe Transaction Service settings.
- **Backward compatible.** With no senders file, today's variables (`SOLANA_SENDER_ADDRESS`, `SOLANA_SENDER_MODE`, `BASE_SAFE_ADDRESS`, …) describe one Sender per chain named `default`, and nothing changes.
- **Rules checked at startup:**
  - names are unique per chain and match `[a-z0-9-]{1,40}`;
  - every enabled chain has at least one Sender;
  - `default` names an existing Sender;
  - no two Senders share an address.

### Identity

- A Dispatch records the Sender's **address** at submission. The address is the identity. The name is how callers and the console refer to it.
- Renaming a Sender in the config keeps its history. Removing one leaves its Dispatches readable, shown by address, and its unfinished work still tracked to the end. New Dispatches can't name it.

### Wire format

- **`POST /v1/dispatch`:** optional `sender` (a name) on a Managed Dispatch. It's refused in a Relay Dispatch, because the engine holds no key there.
  - Unknown name: `400 UNKNOWN_SENDER`.
  - Omitted on a chain with no default: `400 SENDER_REQUIRED`.
  - The Idempotency-Key rules are unchanged.
- **`GET /v1/dispatch/:id` and `GET /v1/dispatches`:** each Dispatch gains `sender: { name, address }`. `name` is null when the Sender is no longer configured. The list gains a `sender` filter.
- **`GET /v1/senders`:** each entry gains `name` and `default: true|false`, with one entry per Sender rather than per chain.
- **Errors:** an `INSUFFICIENT_FUNDS` `chainDetail` already names the address, so it is unchanged.

### Engine

- **The unit of execution becomes the Sender, not the chain.** Today a Chain Handler is built with its chain's one Sender baked in. The Chain Registry instead holds one handler instance per (chain, Sender), sharing the chain's RPC client, and Multisig Sender handlers carry their approval capability as today. This is the redesign that makes everything else fall out; it is not a per-request parameter threaded through the handler.
- **Claiming:** the worker claims Dispatches per Sender. A Dispatch is planned, funded, signed and bundled only with Dispatches of the same Sender. Bundles and Proposals never mix Senders, just as a Proposal never mixes Dispatches today (ADR-0054).
- **Per-Sender state:**
  - Funding Check: runs on that Sender's balances (and its multisig and fee payer).
  - Nonces (Base): sequenced per Sender, as `nonce_history` already keys them.
  - The Safe's one-open-Proposal rule: applies per Safe Sender.
  - Concurrency limits: per Sender.
  - So a stuck transaction or an open Proposal on one Sender never blocks another.
- **Startup and Signer:** the startup checks, the Signer pin reads (ADR-0055, ADR-0059) and the setup checks (`setup-tooling`) run per Sender.
- **Persistence:** one migration adds `sender_address` to `dispatches`, with existing rows backfilled from the current single Sender of their chain, and an index on `(chain, sender_address, status)` for the claim.

### Console

- **Sidebar:** one card per Sender, titled with its name, plus the chain and mode ("Solana, Squads 2 of 3").
- **Dispatches:** a Sender filter beside the chain filter, shown only when a chain has more than one Sender. The row's secondary text shows the Sender's name, and the Details tab shows the name and address.
- **Senders & Keys:** grouped by chain, one card per Sender, with the default marked.

### Docs and setup

- **API reference and guides:** the `sender` field in the reference, a guide "Send from more than one Sender" (hot payouts plus a multisig treasury), and the senders file in Configuration.
- **`init` and `doctor`:** `init` can add a named Sender to a chain, and `doctor` checks every Sender.

## Out of scope

- Spreading one Dispatch across several Senders automatically (Sender Pool, ADR-0016, still deferred).
- Restricting which API tokens may use which Sender. There is still one API token (ADR-0022); see the open questions.
- Choosing a Sender automatically by amount or recipient. Callers choose; Flag Rules can still hold.
- Moving funds between Senders.

## Testing

- **Config parsing:** env-only, a file, and each invalid file case.
- **Wire:** `sender` resolution; `UNKNOWN_SENDER`, `SENDER_REQUIRED`, and the Relay refusal.
- **Isolation:** two Senders on one chain in the Coordinator tests. A stuck transaction on one Sender doesn't delay the other, and a Proposal on the multisig Sender doesn't hold up the hot Sender. Bundles never mix Senders.
- **Postgres tier:** the claim per Sender, and the backfill migration on a database with existing Dispatches.
- **Live:** Solana devnet with a plain Sender and a Squads Sender (`RUN_SQUADS=1`), and Base Sepolia with a plain Sender and a Safe Sender (`RUN_SAFE=1`), sending through both in one run.

## Proposed issues

1. The senders file, its parser and validation, with today's variables as the single-Sender fallback.
2. The Chain Registry per (chain, Sender) and Coordinator claiming per Sender.
3. `sender` on `POST /v1/dispatch`, `sender` on Dispatch reads and the list filter, and `/v1/senders` per Sender. Migration and backfill.
4. Funding Check, nonces, Proposals, concurrency and startup checks per Sender, with the isolation tests.
5. Console: Sender cards, the Sender filter, the Sender in rows and Details.
6. `init` and `doctor` per Sender.
7. Docs: the reference, the multi-Sender guide, and the senders file.

## Open questions

1. **Per-token Sender access.** With one API token, any client that can call the API can choose the multisig Sender or the hot Sender. Is that acceptable for now? Note that it only adds approvals; the hot Sender's Signer policy still caps what it can do. Or do you want tokens that can use only certain Senders, which would amend ADR-0022?
2. **Config format.** A JSON senders file, as above, or YAML?
3. **Flag Rules scope.** Should a Flag Rule be able to target one Sender (for example, hold only payouts from "payouts" over 5,000 USDC)? It's a small addition once both features exist; I'd add it as a follow-up.
