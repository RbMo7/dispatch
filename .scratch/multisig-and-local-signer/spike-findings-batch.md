# Squads v4 Batches on devnet (follow-up to #70)

Tags: [M] measured on devnet, [S] SDK/IDL source, [D] docs. Same multisigs/keys as findings.md (A: 2-of-3, engine mask 5, rent collector = engine).

## Contradictions
1. **Batch transactions execute strictly in sequence, not in any order** [M]. Executing #2 before #1 fails (`ConstraintSeeds` 2006: the program derives the only allowed next transaction PDA from `batch.executedTransactionIndex + 1`). The spec says proposals are independent: that holds between proposals, not inside a batch.
2. **A failing batch transaction blocks every later one until it is retried** [M]. #2 failed inside (vault short): the batch stayed at executed=1, #3 was refused (ConstraintSeeds), and after funding the vault #2 retried fine and then #3 ran. The failed attempt costs 5000 lamports and does not change the proposal.
3. **Partial execution is possible and final** [M]. After tx #1 of 2 executed, the Approvers cancelled the batch proposal: status Cancelled, #1's money had already moved, #2 can never run (InvalidProposalStatus). The same can happen on a late rejection/cancel. A Call mapping must be per batch transaction (CONFIRMED for executed ones, FAILED/ABANDONED for the rest), and "all Calls of a proposal share a fate" (spec) no longer holds. Committed amounts for the Funding Check = sum of the not-yet-executed batch transactions.
4. **Proposal must be a DRAFT while transactions are added** [M]. Order is batchCreate, proposalCreate(draft:true), batchAddTransaction x N, proposalActivate, votes. Adding after activation fails (InvalidProposalStatus); Voters cannot approve a Draft. The engine (Initiate) can activate. Spec's "create the proposal" must become draft + activate, and contents are frozen at activation (good for approvers).
5. **Closing is mandatory per account and in REVERSE order** [M]: each batch transaction must be closed last-index-first (`TransactionNotLastInBatch` 6037 otherwise), then the batch + proposal (`BatchNotEmpty` 6038 before). Closing 42 transactions is 42 more transactions.
6. The Squads **app display of batches could not be verified** (see 5 below).

## 1. Who may do what [M]
- batchCreate, batchAddTransaction, proposalActivate: engine (Initiate+Execute only) works. A Voter-only member gets Unauthorized (6004) on batchCreate and on batchAddTransaction. batchExecuteTransaction: engine (Execute) works.
- The Voter-only members approve the single batch proposal normally (2 votes -> Approved). Voting on a Draft fails.
- Only while the proposal is Draft can transactions be added; index must be next (1, 2, ...; u32, own counter starting at 1 [D]); a skipped index is a seeds error.
- The batch uses the multisig's transaction counter: batchIndex = multisig.transactionIndex+1 (shares the number space with vault/config transactions) and the SAME proposal PDA scheme.
- PDAs [S]: batch = transaction PDA `["multisig", multisig, "transaction", u64 batchIndex]`; vault batch transaction = `["multisig", multisig, "transaction", u64 batchIndex, "batch_transaction", u32 txIndex]`; proposal = standard.
- Instructions (SDK `instructions.*` and generated bindings) [S+M]; (s)=signer, (w)=writable:
  - batchCreate `c28e8d1137b914f8`, args {vaultIndex u8, memo Option<String>}: multisig(w), batch(w), creator(s), rentPayer(s,w), system.
  - batchAddTransaction `5964e0124546364c`, args {ephemeralSigners u8, transactionMessage bytes}: multisig, proposal, batch(w), transaction(w), member(s), rentPayer(s,w), system.
  - batchExecuteTransaction `ac2cb398157feab4`, no args: multisig, member(s), proposal(w), batch(w), transaction, then the inner accounts (like vault execute; SDK returns lookup tables).
  - vaultBatchTransactionAccountClose `8612136a814461f7`: multisig, proposal, batch(w), transaction(w), rentCollector(w), system. batchAccountsClose `dac407af82660bff`: multisig, proposal(w), batch(w), rentCollector(w), system. Both permissionless (any fee payer).
- Batch account (91 bytes): multisig, creator, index u64, bump, vaultIndex, vaultBump, size u32 (transactions added), executedTransactionIndex u32 (0 = none) [M].

## 2. Limits [M]
- Transactions per batch: 3, then **42 added and executed successfully**; no cap hit (size is u32; each add is its own tx). Not tried beyond 42.
- Per batch transaction: same transfer count as a plain vault transaction. 12 SOL transfers: add tx 1022 bytes (51k CU), account 752 bytes; 12 SPL transferChecked: add tx 1086 bytes, account 816 bytes. Add-tx size is ~50 bytes/transfer, so the hard limit is 16 like before; 12 stays the safe number.
- Execute of a batch tx: 12 SOL: 822-byte tx, ~69k CU; 12 SPL: 888 bytes, ~81k CU. I always sent a 256KB heap frame and a 400k CU limit; I did NOT test without the heap frame, so keep requesting it (heap bit SPL execute at 18+ plain).
- Order: strictly sequential by index (contradiction 1); `executedTransactionIndex` is the cursor; the proposal flips to Executed after the last one.

## 3. Costs (devnet, 5080 lamports/byte rent; re-read on mainnet) [M]
| step | payer | fee | rent |
|---|---|---|---|
| batchCreate | engine | 5000 | 1,112,520 (91 B) |
| proposalCreate (draft) | engine | 5000 | 2,956,560 |
| each batchAddTransaction, 12 SOL / 12 SPL | engine | 5000 | 4,470,400 / 4,795,520 |
| proposalActivate | engine | 5000 | 0 |
| each vote | voter | 5000 | 0 |
| each batchExecuteTransaction | engine | 5000 | 0 |
| each vaultBatchTransactionAccountClose + batchAccountsClose | any | 5000 | refunds: tx rent each, then batch + proposal |
Everything is refunded to the multisig's rent collector (engine in A): 3-tx batch refunded 17,480,280 = 1,112,520 + 2,956,560 + 3 x 4,470,400. Same requirement as before: no rent collector => close fails. Closes were possible after Executed, and after Cancelled (tested: close of the last tx in a cancelled batch OK).

## 4. Time lock, stale, reject, cancel [M]
- Time lock (20s): exec #1 right after approval -> `TimeLockNotReleased` 6021; after the lock #1 and #2 ran. Counted from the Approved timestamp, applied to every transaction in the batch.
- Reject: with threshold 3 on multisig C one reject made it Rejected (cutoff = voters - threshold + 1); exec then InvalidProposalStatus.
- Cancel: needs `threshold` cancel votes from Voters even for an Approved batch; Cancelled; remaining txs unexecutable (contradiction 3).
- Stale: after a config change, an **Approved** stale batch kept executing (#1 and #2 both OK, then Executed); an **Active** stale batch proposal could not be approved (StaleProposal 6007). Same as plain proposals.
- Failure in the middle: see contradiction 2.

## 5. What Approvers see: NOT VERIFIED
I could not open the Squads web app. From docs: the SDK's create-batch page describes the flow ("batches allow you to approve, reject, cancel, or execute multiple transactions with a single action" [D]); the app's "Batch Actions" wording in the docs refers to selecting several separate transactions, which is a different thing. A third-party wrapper (Tether WDK Squads module) states "batch execution is unsupported" [D], which suggests tooling support for Batch accounts is uneven. The batch contents ARE on-chain and decodable (`VaultBatchTransaction` accounts hold full messages) [S], so our own verifier CLI could show them, but whether the Squads app renders a batch proposal's 42 transactions for a human to check is unknown. Verify by hand in the app (devnet batch accounts from these scripts exist) before choosing this path.

## 6. 500 recipients, 42 transactions of 12 SOL transfers
| | one batch (1 proposal) | 42 plain proposals | ALT path, 1 proposal per 56 SOL transfers |
|---|---|---|---|
| engine transactions | 1 create + 1 draft proposal + 42 adds + 1 activate + 42 executes + 42 closes + 1 batch close = **130** | 42 x (propose, execute, close) = **126** | 9 proposals x ~14 (buffer create/extends, create-from-buffer, ALT create/extends, execute, closes, ALT close) = **~126**; SPL impossible (max ~23 per proposal => 22 proposals) |
| Approver votes (2-of-3) | **2** | 84 | 18 |
| peak rent locked | **191.6M lamports = 0.192 SOL** (measured: 1,112,520 + 2,956,560 + 42 x 4,470,400) | ~8M x 42 = ~0.33 SOL (est.) | ~9 x 0.04 + ALTs (est.) |
| fees (engine) | 650,000 lamports for 130 txs [M] | ~630,000 | ~630,000 + |
| refund | all, to rent collector | all | all, ALT needs deactivate+wait+close |
| fits SPL | yes | yes | no (23 max) |
| partial-failure semantics | sequential, one failure blocks the rest; cancel mid-run leaves a partial payment | independent | independent |
Measured 42x12 run took ~7 minutes of sequential sends (single-threaded, polling confirmation).

**Recommendation:** use one batch per disbursement run when Approver burden matters (2 votes instead of 84), with 12 transfers per batch transaction, execute and close sequentially, and model Calls per batch transaction (partial outcomes). The costs are 130 engine transactions, sequential execution that a single failing transaction can stall, and the unverified Approver UI (section 5): if the Squads app cannot display the batch, Approvers would rely on our verifier CLI, which weakens ADR-0049's control; in that case prefer independent proposals (126 txs, 84 votes) or ALT proposals for SOL. Scripts: 20-batch.mjs, 21-close-batch.mjs, 22-batch-edge.mjs, 23-batch-auth.mjs, 24-batch-layouts.mjs, batchlib.mjs.
Devnet SOL spent in total (both spikes): ~1.44 SOL, mostly refundable rent.
