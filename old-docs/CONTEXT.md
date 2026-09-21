# Dispatch Engine

A multi-chain disbursement execution engine: it turns a client's declared payment outcomes into reliable, tracked blockchain execution across multiple chains, without the client needing to understand any single chain's execution model.

## Language

**Tenant**:
The customer organization integrating with Dispatch's API — owns API Keys and every Dispatch created with one. Distinct from a Payment's recipient (who is never a Dispatch user, just a destination). May optionally set an `email`/password (see Dashboard Login) for dashboard sign-in; a Tenant created through the anonymous signup path has neither until it sets one via `POST /v1/tenants/me/set-password`.
_Avoid_: Customer, User, Organization, Account

**API Key**:
A bearer credential issued to a Tenant, authenticating `POST /v1/dispatch` and attributing the resulting Dispatch to that Tenant. Shown once at creation; only its hash is ever stored. A Tenant may hold several active API Keys at once (e.g. for rotation), each independently revocable.

**Dashboard Login**:
A Tenant's `email` + password (ADR-0014) — the credential that authenticates a human into the dashboard. Independent of API Keys (which authenticate a Tenant's own backend, not a person) and of wallet custody (still the Signing Provider's job — see Tenant Wallet). Set either at signup (dashboard sign-up flow) or after the fact on an already-anonymous Tenant via `POST /v1/tenants/me/set-password`. Login never reveals whether a given email is unregistered vs. has the wrong password — both are the same generic failure.
_Avoid_: Privy identity, human identity (superseded terms — see ADR-0014)

**Dashboard-Internal API Key**:
An API Key, same mechanism and storage as any other (same `api_keys` row shape, same `requireApiKey` check), but minted for a dashboard sign-in session rather than a human to copy into their own backend (see ADR-0009, ADR-0014). Distinguished by `is_internal = true`: never shown to a human, never listed on the API Keys screen, never counted toward the "at least one active key" lockout rule, and re-minted fresh on every sign-in rather than reused. Carried only inside an encrypted, httpOnly session cookie on the Next.js server, never in browser JavaScript.

**Tenant Wallet**:
The Signing-Provider-custodied wallet Dispatch provisions for a Tenant on a given chain at signup — the address that Tenant's Payments on that chain are sent from. One per (Tenant, chain); never reused across Tenants. Today every Tenant Wallet is implicitly Sandbox — see that entry.
_Avoid_: Sender Wallet, Hot Wallet

**Sandbox** / **Live**:
The two tiers a Chain value belongs to — derived from the value itself, never stored as a separate column. A Chain is a single fully-qualified family+tier identifier (e.g. `solana-devnet`, `solana-mainnet`, `base-sepolia`, `base-mainnet`); anything ending `-mainnet` is Live, everything else is Sandbox. One API Key spans both tiers — there is no separate test/live key. A Tenant Wallet exists per (Tenant, Chain), so a Tenant may hold up to one Sandbox and one Live wallet per chain family, each a dedicated Signing-Provider keypair (never shared across tiers). Sandbox wallets provision automatically at signup; Live wallets are opt-in per chain. A single Dispatch may never mix Sandbox and Live Payments.
_Avoid_: Dev/Prod (this codebase already uses "prod" for the deployment sense — e.g. "push to prod" — reusing it for a per-Tenant mode collides with that); a stored `environment`/`network` column (rejected — see ADR-0010)

**Wallet Export**:
A Tenant pulling their Tenant Wallet's raw private key out of Signing-Provider custody, handing them full self-custody outside Dispatch's control. After export, Dispatch's own signer can no longer be assumed to be the sole controller of that wallet's funds — the Tenant could move funds through it independently, invisibly to Dispatch. Distinct from **Funding** (getting money into a wallet, which only ever needs the public address, never the private key). Available on any Tenant Wallet regardless of Sandbox/Live. See ADR-0011.
_Avoid_: conflating with Funding, or with the one-time API Key reveal (same UI discipline, different stakes — see ADR-0009's reveal-once pattern)

**Dispatch**:
One logical request submitted via `POST /v1/dispatch`, identified by a client-supplied Idempotency Key. Owns one or more Payments.
_Avoid_: Batch, Run

**Idempotency Key**:
A client-supplied string that makes creating a Dispatch a create-once operation — resubmitting the same key returns the original Dispatch rather than creating a new one. Unique per Tenant, not globally: two different Tenants may independently pick the same string.

**Payment**:
One line item within a Dispatch — the client's smallest unit of intent (e.g. "send 100 USDC to Alice on Solana"). Never subdivided. Its `id` is unique only within its own Dispatch, not globally. Its Chain may be given explicitly, or omitted so the Decision Engine resolves it — see Recipient Addresses and Routing Decision.
_Avoid_: Transfer, Instruction

**Recipient**:
The destination of a Payment — never a Dispatch user, just where funds go (see Tenant). Identified by a single address/phone-number string when the Payment's Chain is given explicitly, or by Recipient Addresses when Chain is omitted for the Decision Engine to resolve.

**Recipient Addresses**:
The per-Chain candidate address map on a Chain-less Payment — one Recipient Address per Chain the Recipient is known to hold, supplied by the Tenant up front. Dispatch never discovers these on its own; a Chain missing from this map is never a Route Candidate for that Payment, however cheap it might otherwise be.
_Avoid_: Address Book (a persisted, reusable-across-Dispatches concept — explicitly out of scope; this is inline on one Payment only)

**Execution Preference**:
A per-Payment hint the Decision Engine uses to choose among viable Route Candidates. `cheapest` (the default) and `allowed_chains` (a filter applied before ranking, not itself a ranking rule) are implemented; `fastest`, `balanced`, and `max_execution_fee` are named in the model but not yet implemented.
_Avoid_: Tenant Preference (this is a per-Payment setting, not an account-level one — see Funding Mode for the actual Tenant-level pattern)

**Execution Plan**:
A Chain Executor's decision to realize one or more Payments as a single on-chain Transaction. The bridge between the payment-level view and the transaction-level view: one-to-one on a chain that sends one Payment per Transaction, many-to-one when Payments are bundled (e.g. a Solana batch, or an EVM multisend/disperse-contract batch). Always comes after a Payment's Chain is already fixed — distinct from a Routing Decision, which is how a Chain-less Payment gets one in the first place.
_Avoid_: Execution (the concept doc's original term; superseded by this name for clarity)

**Routing Decision**:
The persisted record of one Decision Engine run for a single Chain-less Payment: every Route Candidate it considered, which one was chosen, and which Execution Preference drove the choice. Distinct from an Execution Plan, which only exists once a Chain is already fixed — a Routing Decision is how it gets fixed.

**Route Candidate**:
One Chain the Decision Engine evaluated for a single Payment: whether a Recipient Address was supplied for it, whether the Payment's asset is supported there, whether the Tenant's wallet can afford it, and its estimated cost. A rejected Route Candidate records why.

**Transaction**:
One broadcastable, chain-native unit with its own hash/signature, belonging to exactly one Execution Plan and covering one or more Payments.

**Attempt**:
One broadcast/confirmation-polling try of a Transaction's exact signed bytes. Resubmitting identical signed bytes (e.g. after an RPC timeout, no chain state change) creates a new Attempt of the same Transaction. Changing the signed bytes (an EVM gas-bump replacement, a Solana blockhash refresh) creates a new Transaction under the same Execution Plan instead — it does not create a new Attempt of the old one.

**Payment Status**:
The lifecycle stage of a Payment: `QUEUED → PROCESSING → BROADCASTING → CONFIRMING → CONFIRMED`, or `FAILED`, or `AWAITING_FUNDS`. `FAILED` is not a dead end — a manual retry resets a Payment straight to `QUEUED` with its Execution Plan link cleared, so it is freshly re-batched rather than reusing the failed plan. There is no separate "retrying" status; retry is a transition, not a state a Payment sits in. `AWAITING_FUNDS` is entered only for a Reactive-mode Tenant (see Funding Mode) whose wallet can't yet cover what's queued against it, and exits straight back to `QUEUED` once it can — see ADR-0012.

**Funding Mode** (**Prefunded** / **Reactive**):
An account-level Tenant setting deciding what happens when a wallet can't cover its currently-`QUEUED` Payments. Prefunded (the default) fails the shortfall immediately with an `insufficient_funds` reason — the Tenant is expected to keep wallets loaded ahead of time. Reactive parks the affected Payments in `AWAITING_FUNDS` and fires a webhook naming exactly which asset and how much more of it is needed, resuming automatically once funded. See ADR-0012.
_Avoid_: per-Dispatch or per-Payment funding settings — this is a Tenant-level choice only

**Chain Executor**:
The chain-specific implementation (Solana, EVM, …) responsible for turning Payments into Execution Plans, obtaining signatures, and broadcasting. The seam that keeps the Execution Coordinator ignorant of chain-specific mechanics.

**Execution Coordinator**:
Groups a Dispatch's Payments by chain and delegates each group to the matching Chain Executor. Holds no chain-specific transaction logic itself.

**Decision Engine**:
Resolves a Chain-less Payment's Chain before the Execution Coordinator ever groups it — evaluates the Payment's Recipient Addresses against each Route Candidate's asset support and the Tenant's available liquidity there, ranks the viable ones by the Payment's Execution Preference, and records the outcome as a Routing Decision. Runs once per Payment, inside the same claim as today's QUEUED→PROCESSING transition — never inside `POST /v1/dispatch` itself, and never for a Payment whose Chain was already given explicitly.
_Avoid_: Router, Decider

**Signing Provider**:
An external signer (e.g. Turnkey, Privy) that holds keys and returns signed transactions for unsigned ones the engine constructs. The engine never holds raw private keys — the "Bring Your Own Signer" (BYOS) model. Selectable per chain via config, proven by swapping providers live with no interface changes (see ADR-0006). Every Tenant Wallet is registered with a Signing Provider by address; Privy is currently the only provider used for Tenant Wallets (see ADR-0008).
_Avoid_: Wallet, Custodian

**Claim Provider**:
A recipient-provisioning layer invoked when a Payment's recipient isn't a wallet address (e.g. a phone number) — turns the Payment into a claimable payment instead of a direct on-chain transfer. Kept separate from the core execution engine. Routed per chain (see ADR-0007): Solana uses a real TipLink — a genuine, shareable claim link whose URL alone lets the recipient rehydrate the wallet's keypair, verified live to hold real transferred funds; Base falls back to a local throwaway keypair with no claim UX (ADR-0005), since TipLink has no EVM equivalent. Either way the underlying transfer is the chain's native asset (ETH on Base, SOL on Solana) — USDC/token claims are deferred. Each claim Payment gets its own fresh wallet — no reuse across repeat payments to the same phone number.
_Avoid_: Wallet provisioning
