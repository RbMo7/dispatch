# Squads v4 devnet spike (#70) findings

Tags: [M] measured on devnet, [S] from SDK/IDL source, [D] from docs. Devnet only; nothing under the repo touched.
SDK: `@sqds/multisig` 2.1.4 + `@solana/web3.js` 1.99.0 (NOT 3.x: the SDK needs 1.x) + `@solana/spl-token` 0.4.15. The RPC has no websocket (`signatureSubscribe` missing), so confirm by polling `getSignatureStatuses`.

## Contradictions
1. **Stale is not "treated as rejected".** After a config transaction (ChangeThreshold, stale index = 4): a stale proposal that was **Active** stays Active forever; approve/reject fail `StaleProposal` (6007), cancel fails `InvalidProposalStatus`. It can only be closed. A stale proposal that was already **Approved** is STILL EXECUTABLE (executed OK after the change) [M]. Rule: stale (`index <= multisig.staleTransactionIndex`) and status != Approved => dead (treat as rejected); stale + Approved => live, and the engine's own late-execution rule (ADR-0053) must decide. Spec's "stale counts as rejected" is only right for non-Approved.
2. **Rent is not recovered automatically; the refund goes to `multisig.rentCollector`, not the creator.** Engine (creator + rent payer) pays vault-tx + proposal rent at propose time (4.73M lamports for 1 transfer; 9-21M for big bundles). Closing is a separate permissionless instruction (`vaultTransactionAccountsClose`), only if the multisig has a rent collector (else `RentReclamationDisabled` 6032). The spec has no closing step. Operator must set rentCollector = engine member key (or accept drain); engine/operator must send closes. Funding Check for the member key should count rent as locked until closed.
3. **Bundle limit is far smaller than plain Sender bundling**, and needs an executor-side compute heap request: direct create fits 16-17 transfers; default 32KB heap makes SPL execute fail from N=18 (SOL fine to 26). See bundle section.
4. **Engine cannot cancel**: cancel needs Vote (Unauthorized 6004). Only Approvers cancel an Approved proposal (needs `threshold` cancel votes). Consistent with ADR-0049, but "engine logs, a human cancels" is the only path.
5. A proposal whose execute fails inside (e.g. vault underfunded) stays **Approved** and is retryable; the failed tx still costs 5000 lamports [M]. A too-large-to-execute Approved proposal is stuck forever (only cancel by Approvers). Committed-amount accounting must keep counting it.
6. Proposals can be closed by anyone once Executed/Rejected/Cancelled/stale-non-Approved, after which the Proposal account **no longer exists**; engine must treat "missing" as "closed, consult tx history".
Confirmed (no contradiction): Initiate+Execute-only member works end to end; no activation step (non-draft proposal is Active immediately); proposals are independent and executable in any order.

## Program / SDK
- Program ID, mainnet AND devnet: `SQDS4ep65T869zMMBKyuUq6aD6EgTu8psMjkvj52pCf` [D: github.com/Squads-Protocol/v4; M: executable on devnet, owner BPFLoaderUpgradeable]. Eclipse differs (irrelevant).
- ProgramConfig PDA `BSTq9w3kZwNwpBXJEvTZz2G9ZTNyKBvoSeXMvwb4cNZr`: devnet `multisigCreationFee` = 0, treasury `HM5y4mz3Bt9JY9mr1hkyhnvqxSH4H2u2451j7Hc2dtvK` [M]. Mainnet fee not read (no mainnet access); read ProgramConfig at implementation.
- Permission bitmask: Initiate=1, Vote=2, Execute=4 [S]. Engine member = 5.
- PDAs [S]: multisig `["multisig","multisig",createKey]`; vault `["multisig", multisig, "vault", u8 index]` (index 0 = Sender); transaction `["multisig", multisig, "transaction", u64le index]`; proposal `[... "transaction", u64le index, "proposal"]`; buffer `["multisig", multisig, "transaction_buffer", creator, u8 bufferIdx]`.
- Proposal status enum (data enum, tag byte at account offset 48, followed by i64 timestamp) [M+S]: 0 Draft, 1 Active, 2 Rejected, 3 Approved, 4 Executing, 5 Executed, 6 Cancelled. Timestamp = time status was entered (Approved timestamp is what the time lock counts from).
- Proposal account: disc `1a5ebdbb74883521`; fields multisig, transactionIndex u64, status, bump, approved[], rejected[], cancelled[] (Vec<Pubkey>). Size = 58 + 3*(4+32*members) = 454 for 4 members [M].
- Multisig account (264 bytes, 4 members): createKey, configAuthority, threshold u16, timeLock u32 (seconds), transactionIndex u64 (LAST created index; next = +1), staleTransactionIndex u64, rentCollector Option<Pubkey>, bump, members[{key, permissions mask}] (sorted by key) [M]. Rejection cutoff = voters - threshold + 1 (2 of 3 voters, threshold 2: two rejects => Rejected) [M].
- Instructions (Anchor discriminators, accounts in order; (s)=signer, (w)=writable) [M, built by the SDK]:
  - vaultTransactionCreate `30fa4ea8d0e2dad3`; args {vaultIndex u8, ephemeralSigners u8, transactionMessage bytes, memo Option<String>}; accounts: multisig(w), transaction(w), creator(s), rentPayer(s,w), system. Message bytes = Squads compact message (SDK `transactionMessageToMultisigTransactionMessageBytes`), payer = vault.
  - proposalCreate `dc3c49e01e6c4f9f`; args {transactionIndex u64, draft bool}; accounts: multisig, proposal(w), creator(s), rentPayer(s,w), system.
  - proposalActivate `0b225cf89a1b336a`: multisig, member(s,w), proposal(w). (Only for draft.)
  - proposalApprove `9025a488bcd82af8` / proposalReject `f33e869ce66af687`: args {memo Option<String>}; accounts: multisig, member(s,w), proposal(w).
  - proposalCancelV2 `cd29c23ddc8b10f7` (adds system program 4th); legacy proposalCancel `1b2a7fed26a354cb` (3 accounts). Both need Vote.
  - vaultTransactionExecute `c208a15799a419ab`, no args; accounts: multisig, proposal(w), transaction, member(s), then remaining accounts = [ALT accounts if the inner message uses lookups], vault (w), then each inner account, programs. SDK helper reads the on-chain vault tx and returns the ALTs to use.
  - vaultTransactionAccountsClose `c447bbb00223aaa5`: multisig, proposal(w), transaction(w), rentCollector(w), system. No member signer: anyone can send it.
  - configTransactionCreate/Execute exist (used in the stale test; engine never uses them).
  - Large messages: transactionBufferCreate / Extend / vaultTransactionCreateFromBuffer exist on the devnet program (generated bindings only; not in the SDK's `instructions` helpers) [M].
- Error codes seen: 6004 Unauthorized, 6007 StaleProposal, 6008 InvalidProposalStatus, 6021 TimeLockNotReleased ("Proposal time lock has not been released"), 6032 RentReclamationDisabled.

## Permissions end to end [M]
Multisig A: members engine (Initiate+Execute), v1,v2,v3 (Vote), threshold 2. Engine created vault tx + proposal in ONE tx (proposal Active immediately, no activation), v1+v2 approved (Active -> Approved at 2nd), engine executed (Executed). Engine approve => Unauthorized; engine cancel => Unauthorized. A draft proposal (`draft:true`) needs `proposalActivate`, which the engine (Initiate) CAN do; approve on a Draft fails InvalidProposalStatus.

## Bundle size (vault tx + proposal) [M]
Per transfer: about 50 bytes in the create tx for both SOL and SPL; about 33 bytes extra in the execute tx. Limits, in the order they bite:
| path | SOL | SPL transferChecked (classic) | Token-2022 |
|---|---|---|---|
| create vault tx alone, 1232-byte tx | 17 | 16 | same size as classic (16 ok) |
| create + proposalCreate in one tx | 16 | 15 | |
| same, plus CU-limit + CU-price ixs | 15 | 14 | |
| execute, default 32KB heap, no ALT | 26 ok (1203 B, 121k CU) | 16 ok; 18, 20, 22, 24 FAIL "Access violation ... heap" at ~77k CU (17 untested) | 16 ok (127k CU) |
| execute with `requestHeapFrame(256KB)` + CU limit | needs size: tx limit 1232 -> 26 (no ALT) | 20, 22 ok (116k/126k CU); 24 fails tx size 1251; 23 expected max | |
| buffer create + outer ALT + heap + CU 1.4M | 40 ok (178k CU), 52 ok (225k), 56 ok (241k CU); **60 FAILS "locked too many accounts" (64-account limit)** | not tested beyond 24 | |
Limiting factors: (1) create tx size 1232 B, (2) execute tx size (accounts at 32 B each), (3) program heap 32KB (SPL), (4) 200k default CU above ~45 SOL transfers, (5) 64 account locks (~56 SOL transfers). Account size is not binding (3.5KB at N=60, below the 10KB limit). Address lookup tables are needed only for N>26 and cost ALT rent (about 0.011 SOL per ~60 addresses, reclaimable after deactivation).
**Recommended bundle limit: 12 Calls per vault transaction** (direct create path, no buffer, no ALT): 14-15 is the hard limit with budget instructions and a proposalCreate in the same tx, and mixed bundles add mint/program keys (32 B each) and ATA creates. The engine should still use byte-size-aware bundling with a Squads-specific budget, and always add `requestHeapFrame` + a CU limit to execute. Going beyond ~16 needs the buffer path (multi-tx create) and ALTs for execute: not recommended for v1.

## Fees and rent (devnet lamports) [M]
Devnet rent is 5080 lamports per byte incl. 128-byte header (`getMinimumBalanceForRentExemption`); mainnet value must be re-read, do not hard-code. Base fee 5000 per signature.
| step | payer | fee | rent |
|---|---|---|---|
| multisig create (2 signers: creator+createKey) | creator (funder) | 10,000 | 1,991,360 (264 B); program creation fee 0 on devnet |
| vault tx create (1 SOL transfer, 221 B) | engine (creator/rentPayer) | 5000 | 1,772,920; grows ~50 B*5080 per transfer: N=12 SPL 5.17M, N=16 SPL 6.29M, N=17 SOL 6.24M, N=26 SOL 8.76M |
| proposal create (454 B, 4 members) | engine | in same tx | 2,956,560 |
| 1 transfer total propose (one tx) | engine | 5000 | 4,729,480 => 4,734,480 |
| each approve / reject / cancel vote | voter | 5000 | 0 |
| execute | engine | 5000 (failed execute also 5000) | 0 |
| close (anyone sends; fee 5000 from sender) | sender | 5000 | refunds BOTH accounts to `rentCollector` (4,729,480 for 1 transfer; 15.6M for N=40) |
Buffer path: engine pays an extra tx per 700 B chunk; buffer account is consumed by create-from-buffer.
Closable states: Executed, Rejected, Cancelled, stale-and-not-Approved. NOT closable: Active, fresh Approved (InvalidProposalStatus). No rent collector => RentReclamationDisabled.

## Execution order [M]
Created proposals 16 and 17, approved both, executed 17 FIRST (OK), then 16 (OK). **Yes: independent, any order.**

## Time lock [M]
Multisig B timeLock=20s. Approved at on-chain T; execute 4 s later fails `TimeLockNotReleased` (6021, "Proposal time lock has not been released"); after T+20 execute succeeded. Counted from the Approved status timestamp. Simulation fails first (preflight), so the engine sees it as a send error with that code.

## Stale [M]
See Contradiction 1. On-chain signature: `Multisig.staleTransactionIndex = 4` after ChangeThreshold executed at index 4; proposals 1..3 have `index <= stale`; stale Active p1 unchanged ("Active", 1 approval); stale Approved p2 still executed. Config transaction executed by the engine (Initiate+Execute) after 2 Voter approvals. Fresh proposals follow the new threshold (needed 3 approvals).

## Rejection / cancel [M]
Rejected: 2 of 3 voters reject (rejected[] has 2 keys) => status Rejected (timestamp set); approve/execute then fail InvalidProposalStatus. Cancelled Approved: needs `threshold` cancel votes from Voters (cancelled[] fills; approved[] keeps its entries); after 2 cancel votes status = Cancelled, approved[] still lists the 2 approvers. After 1 cancel vote status still Approved.

## What the engine reads, and detecting someone else's execute [M]
- `Proposal.fromAccountAddress(proposalPda)`: status kind + timestamp, approved/rejected/cancelled vectors; `Multisig`: threshold, timeLock, transactionIndex, staleTransactionIndex, rentCollector, members. Approval count vs threshold: `approved.length`.
- A different member with Execute (multisig D) executed an approved proposal: the engine saw `Executed` with timestamp.
- Reliable signature lookup: `getSignaturesForAddress(proposalPda)` lists create, each vote, execute and close; pick the successful tx whose logs contain `Instruction: VaultTransactionExecute`; fee payer = executor. **Still works after the accounts are closed** (the Proposal then reads as missing). Script: 13-late-executor.mjs. Retention of old signatures depends on the RPC; fine for a 30-day window.

## Spend
Devnet funder spent 1.298 SOL in total, much of it locked in rent/ALTs/vaults and mostly reclaimable (engine key now holds 0.42 SOL, ALTs not closed).

## Correction found while building the verifier (#89)

The vault-transaction **account** stores the message as plain Borsh with `u32`-length vectors. The compact `SmallVec` form (what `transactionMessageToMultisigTransactionMessageBytes` produces) appears only in the **create instruction's arguments**. Anything that decodes the on-chain account (the verifier, the engine's `readProposal`) must read the Borsh layout; anything that builds the create instruction uses the compact form.
