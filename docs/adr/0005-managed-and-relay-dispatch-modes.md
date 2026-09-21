# Two dispatch modes: Managed and Relay

The engine needs to serve two different kinds of caller: an operator dispatching from their own wallet (a payroll run, a DAO treasury, a contract-triggered backend), and an application whose *own end users* bring their own wallets (e.g. a DEX where each trader signs their own transaction). These are not the same feature. Managed Dispatch builds the transaction, owns its nonce, and calls a Signer (ADR-0002). Relay Dispatch accepts an already fully-signed transaction from any wallet and only broadcasts, retries delivery of the same bytes, and tracks confirmation — the engine never builds it, never assigns its nonce, and cannot fee-bump it, because it never has that wallet's key.

## Consequences

Relay Dispatch's stuck-transaction outcome must not imply the same reliability guarantee Managed Dispatch gives — it can only report "stuck, cannot auto-resolve, the original signer must resubmit," never attempt a fix. Both modes are in scope for this project's first phase; both are called server-to-server by an application's own backend — never directly from an end user's browser.
