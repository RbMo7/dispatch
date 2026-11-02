# What's new

This release adds a console for operators, holds for payments a person should look at, several Senders per chain, tokens you can add without a restart, and answers that say what each call did and why each request failed. Nothing has run on mainnet yet.

## For developers

- **Choose the Sender per request.** A chain can have several named Senders, and `sender` on [Create a Dispatch](./openapi.yaml#create-a-dispatch) picks the one that pays. A request without it pays from the chain's default. Every Dispatch now reads back its `sender`, and [List Dispatches](./openapi.yaml#list-dispatches) filters by it. [Send from more than one Sender](./guides/multiple-senders.md).
- **See what a call does.** Every `call` item reads back a `call` block: the function and its arguments when a built-in decoder knows the contract or program, or the selector and raw data when none does. [Call a contract or program](./guides/call-a-contract.md).
- **See what a transaction changed.** Once an item confirms, it gains `effects`: the value that moved, the fee and who paid it, and every log or instruction a decoder knows. A Relay Dispatch gets them too. [Call a contract or program](./guides/call-a-contract.md#what-call-and-effects-hold).
- **Amounts with names.** Amounts in a known coin or token carry the asset and a `formatted` value in whole units.
- **Revert reasons.** A Base call that reverts fails with `message: "reverted: <reason>"`, and `chainDetail` has the reason, the gas used and the raw revert data. [Errors](./errors.md#what-chaindetail-holds).
- **Who cancelled, and why.** A cancel takes an optional `reason`, and a cancelled Dispatch reads back `cancellation` with the time, the token and the reason. [Cancel a Dispatch](./guides/cancel.md).
- **Holds.** A Dispatch that matches a Flag Rule is accepted as `held`, and waits until an operator releases it or anyone cancels it. Its `hold` names every rule and item that matched. [Hold payments with Flag Rules](./guides/flag-rules.md).
- **Who approved, who has not.** A Multisig Sender's `approval` block now has `remaining`, the approvals still needed, and `approvers`, each member's decision, with a label from the senders file. [Pay from a multisig](./guides/multisig.md#4-read-the-approval-while-you-wait).
- **A timeline in the right order.** `claimed` is the first time the worker claimed the Dispatch, `sent` is the first time a node accepted each transaction, and entries with the same time follow the order the steps happen in. [Track a Dispatch](./guides/track.md#every-kind-of-entry).
- **Two new error codes for callers.** `UNKNOWN_SENDER` and `SENDER_REQUIRED` say a request named a Sender the chain does not have, or named none on a chain without a default. [Errors](./errors.md#error-codes).

## For operators

- **The console.** The API process serves a console at `/console`: Overview, Dispatches with a Flow, Items and Details view of each one, Senders & Keys, Assets and Setup for any token, and Held, Flag Rules, Activity and Rejected for the operator token. [The web console](./self-hosting/console.md).
- **The operator token.** `OPERATOR_TOKEN` is a second token for releasing holds, writing Flag Rules, changing Known Assets and reading the activity and refused-request records. The API token cannot do these. [Authentication](./authentication.md#the-operator-token).
- **Flag Rules.** Six kinds of rule, each optionally scoped to one Sender, previewed against the last 30 days before you turn it on. [Hold payments with Flag Rules](./guides/flag-rules.md).
- **Known Assets.** Add an SPL, Token-2022 or ERC-20 token from the console or the API, with no restart. The engine reads its decimals, name and symbol from the chain. Disable it again when you stop paying in it. [Add a token with Known Assets](./guides/assets.md).
- **Refused requests.** The engine records every request it refused, with the body as sent, for 30 days by default (`REJECTED_RETENTION_DAYS`). Read them on the console's Rejected page or with [List refused requests](./openapi.yaml#list-refused-requests). [Errors](./errors.md#refused-requests).
- **Named Senders.** A senders file names each chain's Senders, plain or multisig, and labels a multisig's Approvers. [Configuration](./self-hosting/configuration.md#the-senders-file).
- **Setup in one command.** `pnpm dispatch init` writes the Signer config and the `.env` and can start the services. `pnpm dispatch doctor`, the worker every five minutes, the console's Setup page and `GET /v1/setup` all run the same checks, each with its fix. [Install and run](./self-hosting/install.md) and [Setup checks](./self-hosting/doctor.md).
- **One engine per Sender.** This is the rule, now stated plainly: never share a Sender's key between engines, and use named Senders to split work. [Install and run](./self-hosting/install.md#where-things-run-in-production).

## These docs

The docs site now has a REST API reference built from the OpenAPI file, with a cURL, JavaScript and Python sample for every route, and guides for every task above. Every request in the guides ran against a real engine on Solana devnet and Base Sepolia, and the responses shown are the ones it returned.
