# Multi-Chain Disbursement Execution Engine

## Context

I am building a 72-hour hackathon MVP for a **developer-first, API-first multi-chain disbursement execution engine**.

This is **not a CSV multisender website**.

The core product is an orchestration layer between a Web2 application and blockchain networks.

The developer using our API should be able to submit a large set of payment instructions without needing to understand:

- EVM nonce management
- Solana transaction/instruction limits
- RPC behavior
- transaction lifecycle management
- retries
- partial failures
- idempotency
- transaction tracking
- reconciliation

The engine receives the desired payment outcome and is responsible for turning it into reliable blockchain execution.

---

# 1. Core Product

The primary interface is a headless API.

Example:

```http
POST /v1/dispatch
Idempotency-Key: payroll_oct_15_run_01
```

```json
{
  "payments": [
    {
      "id": "payment_001",
      "chain": "base",
      "asset": "USDC",
      "recipient": "0x45...",
      "amount": "800"
    },
    {
      "id": "payment_002",
      "chain": "solana",
      "asset": "USDC",
      "recipient": "HN7c...",
      "amount": "1500"
    },
    {
      "id": "payment_003",
      "chain": "solana",
      "asset": "USDC",
      "recipient": "+97798XXXXXXX",
      "amount": "100"
    }
  ]
}
```

The request can contain mixed-chain payments.

The client should not need to know how those payments will be executed internally.

---

# 2. High-Level Architecture

The conceptual architecture is:

```text
                Client Application
                       |
                       | POST /v1/dispatch
                       v
                Disbursement API
                       |
                       v
              Idempotency Layer
                       |
                       v
                PostgreSQL
                       |
                       v
             Execution Coordinator
                       |
             +---------+---------+
             |                   |
             v                   v
      Solana Worker          EVM Worker
             |                   |
             v                   v
      Solana Executor       EVM Executor
             |                   |
             v                   v
       Solana RPC             Base RPC
             |                   |
             +---------+---------+
                       |
                       v
                Settlement State
                       |
                       v
                  Webhooks
                       |
                       v
                Client Application
```

The architecture should allow additional chains to be added later through chain-specific executors/adapters.

---

# 3. Complete End-to-End Flow

The following is the intended lifecycle of a dispatch.

## Step 1 — Client submits a dispatch

A client sends:

```text
POST /v1/dispatch
```

with:

```text
Idempotency-Key
```

and an array of payments.

The API should immediately validate:

- request structure
- supported chains
- supported assets
- recipient format
- amount format
- duplicate payment IDs
- required fields

Do not perform blockchain execution inside the HTTP request itself.

The API should create the dispatch and hand execution to background workers.

---

# 4. Idempotency

Idempotency is a core feature, not an optional feature.

The client may accidentally submit:

```text
POST /v1/dispatch
Idempotency-Key: payroll_001
```

twice.

The engine must not create two independent payment batches.

Conceptually:

```text
Request 1
    |
    v
idempotency_key = payroll_001
    |
    v
Create dispatch
    |
    v
Return dispatch_id


Request 2
    |
    v
idempotency_key = payroll_001
    |
    v
Existing dispatch found
    |
    v
Return existing dispatch
```

PostgreSQL should enforce uniqueness at the database level.

Do not rely only on application-level checks because concurrent requests can race.

---

# 5. Persistent State

PostgreSQL is the source of truth for the execution state.

At minimum, think in terms of:

```text
Dispatch
Payment
Execution
Transaction
Attempt
```

A payment should have an explicit lifecycle.

Example:

```text
QUEUED
  ↓
PROCESSING
  ↓
BROADCASTING
  ↓
CONFIRMING
  ↓
CONFIRMED
```

with failure paths such as:

```text
FAILED
RETRYING
```

The exact state machine should be designed before implementation.

The database must allow us to answer:

- What was requested?
- What has been executed?
- What transaction corresponds to each payment?
- What failed?
- What can be retried?
- What has been confirmed?
- What is the final settlement result?

---

# 6. Execution Coordinator

After the API persists the dispatch, the execution coordinator takes over.

It groups payments by chain:

```text
Incoming:

Base
Solana
Solana
Base
Solana
```

becomes:

```text
Base Worker
  - payment_001
  - payment_004

Solana Worker
  - payment_002
  - payment_003
  - payment_005
```

The coordinator should not contain chain-specific transaction logic.

Its responsibility is orchestration.

---

# 7. Chain Executor Interface

Design the system around a common executor abstraction.

Conceptually:

```ts
interface ChainExecutor {
  validatePayment(payment): Promise<void>;

  prepare(payments): Promise<ExecutionPlan>;

  sign(plan): Promise<SignedTransaction[]>;

  broadcast(
    transactions: SignedTransaction[]
  ): Promise<BroadcastResult[]>;

  getStatus(
    transactionId: string
  ): Promise<TransactionStatus>;

  retry(
    execution: Execution
  ): Promise<void>;
}
```

This is conceptual, not a requirement to use this exact interface.

The purpose is to make this possible:

```text
             Execution Coordinator
                       |
          +------------+------------+
          |                         |
          v                         v
    SolanaExecutor             EVMExecutor
```

without the coordinator knowing how Solana or EVM transactions work internally.

---

# 8. Solana Execution

The Solana executor is responsible for handling Solana-specific constraints.

It should:

1. Validate recipient addresses.
2. Construct transfer instructions.
3. Determine how payments can be grouped.
4. Respect transaction size/account/compute constraints.
5. Create executable batches.
6. Obtain signatures through the signing provider.
7. Broadcast transactions.
8. Track confirmation.
9. Retry appropriate failures.

The implementation should not simply assume:

```text
N payments = N transactions
```

The executor should determine an appropriate execution plan.

The exact batching algorithm should be investigated during implementation rather than hardcoded into the architecture prematurely.

---

# 9. EVM Execution

The EVM executor handles chains such as Base.

Responsibilities include:

1. Validate addresses.
2. Determine the appropriate sender/account.
3. Manage transaction nonces.
4. Construct transactions.
5. Estimate gas.
6. Obtain signatures.
7. Broadcast transactions.
8. Track confirmations.
9. Handle transaction replacement/retry where appropriate.

The MVP does NOT need a production-grade gas-bumping system.

For the hackathon, the initial implementation can use normal Base testnet transaction submission.

However, the architecture should leave room for:

```text
Transaction stuck
      ↓
Detect timeout
      ↓
Recalculate fees
      ↓
Replace transaction
      ↓
Continue execution
```

This is an architectural capability, not necessarily an MVP implementation requirement.

---

# 10. Signing / BYOS

The execution engine should not hold raw private keys.

The intended model is:

```text
Execution Engine
       |
       | unsigned transaction
       v
Signing Provider
       |
       | signed transaction
       v
Execution Engine
       |
       v
Blockchain RPC
```

Investigate using Turnkey as the initial signing provider.

The goal is to demonstrate a **Bring Your Own Signer / Wallet** model.

Potential signing providers can include:

- Turnkey
- Privy
- other MPC/custody providers

Do not hardwire the entire architecture around one provider.

Create a signer abstraction so that the execution engine can eventually support multiple providers.

---

# 11. Phone Number Payments / TipLink

The MVP should also explore recipient abstraction.

A payment recipient does not necessarily have to be a blockchain address.

For example:

```json
{
  "chain": "solana",
  "asset": "USDC",
  "recipient": "+97798XXXXXXX",
  "amount": "100"
}
```

The execution engine can recognize that the recipient is a phone number.

Instead of sending directly to an existing wallet:

```text
Phone Number
     ↓
TipLink / wallet provisioning layer
     ↓
Claimable payment
```

For the hackathon, investigate TipLink's API and determine the smallest reliable integration.

This feature is a **kicker/demo feature**, not the foundation of the architecture.

Keep wallet/claim provisioning separate from the core blockchain execution engine.

---

# 12. Broadcasting

Once a transaction has been signed:

```text
Signed Transaction
       ↓
RPC
       ↓
Transaction Hash / Signature
```

The engine stores the transaction identifier against the corresponding execution/payment.

Never treat "RPC accepted my transaction" as equivalent to "payment completed."

The lifecycle should distinguish:

```text
CREATED
BROADCASTED
CONFIRMING
CONFIRMED
FAILED
```

---

# 13. Reconciliation

The database should continuously reconcile the internal state with blockchain state.

Example:

```text
Payment
  ID: payment_001
  Status: CONFIRMED
  Tx: 0xabc123
```

The system should be able to independently query the chain and determine whether that transaction actually settled.

The goal is to avoid relying purely on the initial RPC response.

For the MVP, polling is acceptable.

A production architecture could later use:

- WebSockets
- chain indexers
- provider callbacks
- dedicated indexing services

---

# 14. Partial Failure

A dispatch should not be treated as a single all-or-nothing object.

Example:

```text
Dispatch
1000 payments

997 confirmed
3 failed
```

The system should preserve the state of every individual payment.

The user should be able to identify:

```text
CONFIRMED: 997
FAILED: 3
```

and retry only the failed payments.

This is one of the important differences between a simple transaction script and an execution engine.

---

# 15. Webhooks

The client should receive lifecycle events.

Possible events:

```text
dispatch.created
dispatch.processing
payment.broadcasted
payment.confirmed
payment.failed
dispatch.completed
dispatch.partially_failed
```

Example:

```json
{
  "event": "payment.confirmed",
  "dispatch_id": "dispatch_123",
  "payment_id": "payment_001",
  "transaction": "0xabc123",
  "chain": "base",
  "status": "CONFIRMED"
}
```

Webhook delivery should eventually have its own retry mechanism.

For the MVP, implement a basic reliable webhook mechanism rather than a complete enterprise webhook platform.

---

# 16. Command Center UI

The dashboard is not the product itself.

It exists to visualize and prove what the execution engine is doing.

The UI should feel like an infrastructure command center.

It should show:

```text
DISPATCH
────────────────────────────────────

Dispatch ID
Status
Total payments
Confirmed
Processing
Failed

────────────────────────────────────

EXECUTION

BASE
245 payments
Queue: ACTIVE

SOLANA
250 payments
Batches: 12
Workers: ACTIVE

TIPLINK
5 recipients
Claims: 5
```

And individual execution events:

```text
14:02:11  Dispatch created
14:02:12  500 payments validated
14:02:12  Base queue created
14:02:12  Solana batches generated
14:02:13  Base transactions broadcasting
14:02:13  Solana batch 01 confirmed
14:02:14  Solana batch 02 confirmed
```

The UI should make the abstraction visible.

The judge should be able to see that the application sent one logical dispatch while the engine handled very different blockchain execution models underneath.

---

# 17. Hackathon Demo

The target demo:

```text
500 payments

245 Base
250 Solana
5 phone recipients
```

Trigger:

```text
POST /v1/dispatch
```

Then show the Command Center.

The engine should visibly:

```text
Receive
  ↓
Validate
  ↓
Persist
  ↓
Split by chain
  ↓
Create execution plans
  ↓
Sign
  ↓
Broadcast
  ↓
Track
  ↓
Confirm
```

Then run the exact same request again with the same:

```text
Idempotency-Key
```

The API should return the existing dispatch rather than creating another set of payments.

This demonstrates the idempotency/double-spend protection.

---

# 18. What We Are NOT Building

The 72-hour MVP should explicitly avoid unnecessary scope.

Do NOT build:

- User authentication system
- Multi-tenant billing
- Fiat on-ramp
- Production custody system
- Full enterprise compliance
- Complete wallet management
- Every blockchain
- Production-grade gas optimization
- Complex admin permissions
- Full analytics platform
- Production-scale indexing infrastructure

The objective is to prove the execution engine.

---

# 19. Technology Decision

Current candidate backend technologies:

### Option A — Node.js / TypeScript

Existing strengths:

- I already work heavily with TypeScript.
- Faster hackathon development.
- Easy integration with Next.js.
- Strong blockchain SDK ecosystem.
- Turnkey and Solana tooling can be evaluated quickly.
- Shared types between API and frontend.

Potential downside:

- Less opportunity to demonstrate systems-level concurrency.
- Background execution architecture needs to be designed carefully.

### Option B — Go

Potential strengths:

- Strong concurrency primitives.
- Excellent fit for worker-based execution.
- Good networking/RPC performance.
- Clear separation between workers/executors.
- Potentially better long-term fit for infrastructure.

Potential downside:

- Slower implementation compared with my existing TypeScript experience.
- Blockchain SDK/tooling may require more investigation.
- Introducing Go during a 72-hour hackathon increases execution risk.

### Option C — Hybrid

Potential architecture:

```text
Next.js / Node.js
       |
       | API
       v
Execution Service
       |
   +---+---+
   |       |
  Go     Node
Worker   Worker
```

However, do NOT introduce a hybrid architecture simply because it sounds impressive.

The agent should evaluate whether there is a real technical reason for Go to exist separately.

---

# 20. Decision I Want From the Agent

Before implementation, evaluate:

1. Which components should be Node.js/TypeScript?
2. Which components would genuinely benefit from Go?
3. Is a hybrid architecture justified?
4. What is the minimum architecture that can demonstrate the execution engine within 72 hours?
5. Which components should be interfaces so that Node.js can later be replaced by Go if necessary?
6. Which blockchain SDKs/libraries are mature enough for the MVP?
7. Which parts should be mocked versus actually implemented?

Do not choose Go simply for performance claims.

Do not choose Node simply because it is familiar.

Choose based on:

```text
Hackathon delivery speed
+
Blockchain SDK maturity
+
Concurrency requirements
+
Operational simplicity
+
Future architecture
```

---

# 21. Most Important Engineering Principle

The architecture should separate:

```text
WHAT the client wants
```

from:

```text
HOW the blockchain executes it
```

The client says:

```text
Send these 500 payments.
```

The execution engine decides:

```text
How to validate them
How to partition them
How to schedule them
How to sign them
How to broadcast them
How to retry them
How to track them
How to reconcile them
```

That separation is the core of the project.

---

# 22. Final MVP Architecture

The intended MVP should roughly become:

```text
                     WEB2 APPLICATION
                            |
                            |
                     POST /v1/dispatch
                            |
                            v
                  ┌───────────────────┐
                  │   DISPATCH API    │
                  └─────────┬─────────┘
                            |
                            v
                  ┌───────────────────┐
                  │   IDEMPOTENCY     │
                  │   + VALIDATION    │
                  └─────────┬─────────┘
                            |
                            v
                  ┌───────────────────┐
                  │    POSTGRESQL     │
                  │   SOURCE OF TRUTH │
                  └─────────┬─────────┘
                            |
                            v
                  ┌───────────────────┐
                  │     EXECUTION     │
                  │    COORDINATOR    │
                  └─────────┬─────────┘
                            |
              ┌─────────────┼─────────────┐
              |             |             |
              v             v             v
        ┌──────────┐  ┌──────────┐  ┌──────────┐
        │  SOLANA  │  │    EVM   │  │  CLAIM   │
        │ EXECUTOR │  │ EXECUTOR │  │  LAYER   │
        └────┬─────┘  └────┬─────┘  └────┬─────┘
             |             |             |
             v             v             v
          Solana         Base          TipLink
             |             |             |
             └─────────────┼─────────────┘
                           |
                           v
                    SETTLEMENT STATE
                           |
                           v
                       WEBHOOKS
                           |
                           v
                    WEB2 APPLICATION


                    COMMAND CENTER
                           ↑
                           |
                    Execution Events
```

The implementation language is intentionally **not fixed yet**.

The architecture is the priority.

Evaluate the tradeoffs and recommend the simplest implementation that can convincingly demonstrate the complete execution lifecycle within the 72-hour hackathon.
