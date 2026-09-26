> **Note:** This is pre-spec research, not a `spec.md` or numbered issue. It exists to inform the `base-chain-handler` feature before any spec or issues are written. No code, spec, or ADR is proposed here — only findings and, per topic, an "implication for this engine's Chain Handler" note tying it back to this repo's existing vocabulary (`CONTEXT.md`) and ADRs.
>
> **Scope note (post-grill):** this research was originally framed as a generic "EVM Chain Handler," but the design review that followed it decided `base` and Ethereum L1 are **separate Chain Handlers** (see the ADR this produced), not one `evm` family with network-as-config. Everything below that's genuinely EVM-family-generic (EIP-1559, EIP-155, nonce mechanics, ERC-20 encoding, RLP/typed-transaction decoding) still applies directly to `base-chain-handler`; the Base-specific sections (§4 OP-Stack finality/L1 fee, and the chain-ID values in §3) are what actually justified splitting it out as its own handler rather than a config variant. Ethereum L1 itself is out of scope — undesigned, filed only as a future feature name.

# Base Chain Handler — primer research

Grounding used throughout: `CONTEXT.md` (Chain Handler, Chain, Call, Payment, Retry Policy, ABANDONED, Bulk Call, Attempt vs Transaction, Sender/Signer boundary, Idempotency Key, Funding Check); ADR-0002, 0003, 0004, 0006, 0015, 0017, 0018, 0019, 0027, 0028, 0030, 0032, 0033; `src/chain-handler/chain-handler.ts`; `src/chain-handler/solana/solana-chain-handler.ts`; `.scratch/solana-chain-handler/spec.md` and issues 06/08/09/10/13/14/15.

---

## 1. Nonce management

Every EVM account has a nonce: a strictly-increasing counter of transactions sent from that address. A client node's transaction pool tracks two nonce-relevant states per account: **pending** (the next executable nonce — `eth_getTransactionCount(address, "pending")`) and the account's on-chain confirmed nonce (`eth_getTransactionCount(address, "latest")`).

**Nonce gaps / "stuck" transactions.** If a transaction is submitted with a nonce higher than the account's next executable nonce, go-ethereum's pool holds it in a **queued** (non-executable) state rather than **pending** — it is not gossiped or minable until the gap is filled. It is promoted to pending only once the missing lower nonce arrives and is itself minable. This is the direct mechanical cause of a "stuck" nonce: if the transaction at the gap-filling nonce never confirms (dropped from mempool, underpriced, etc.), every transaction queued behind it stays stuck indefinitely, no matter how well-priced it is.
Source: go-ethereum `txpool` RPC namespace docs, "pending" vs "queued" semantics — https://geth.ethereum.org/docs/interacting-with-geth/rpc/ns-txpool (go-ethereum project docs).

**Replacing a stuck transaction — the minimum bump rule.** go-ethereum's default legacy/dynamic-fee pool (`core/txpool/legacypool`) enforces a minimum percentage price bump to accept a *replacement* transaction at the same nonce — otherwise it's rejected with `ErrReplaceUnderpriced`. The bump percentage is a pool config field:

```go
// PriceBump: Minimum price bump percentage to replace an already existing transaction (nonce)
PriceBump uint64
```
Default value (`DefaultConfig`): `PriceBump: 10` (10%).

Crucially, for a dynamic-fee (EIP-1559, type-2) transaction the bump is checked **independently on both fee fields**, in `core/txpool/legacypool/list.go`'s replacement logic:

```go
thresholdFeeCap = oldFC  * (100 + priceBump) / 100
thresholdTip    = oldTip * (100 + priceBump) / 100
...
if tx.GasFeeCapIntCmp(thresholdFeeCap) < 0 || tx.GasTipCapIntCmp(thresholdTip) < 0 {
    return false, old // return old and don't add new to prevent SlOaD attack
}
```
i.e. a valid replacement must bump **both** `maxFeePerGas` (`GasFeeCap`) and `maxPriorityFeePerGas` (`GasTipCap`) by at least the configured percentage over the old transaction's values — bumping only one is rejected.
Source: `ethereum/go-ethereum`, `core/txpool/legacypool/legacypool.go` (`PriceBump` field, `DefaultConfig`) and `core/txpool/legacypool/list.go` (replacement threshold check) — https://github.com/ethereum/go-ethereum/blob/master/core/txpool/legacypool/legacypool.go and same directory's `list.go`. The blob pool (`core/txpool/blobpool`) applies the identical percentage-based rule to blob transactions.

**Implication for this engine's Chain Handler:** the engine's nonce-owning single authority (per ADR-0002's rejected-alternative discussion) maps directly onto "pending" nonce assignment — the Chain Handler should track/assign the next nonce itself (analogous to Solana's own account-sequencing, but EVM nonces are a per-account integer, not a blockhash) rather than trusting `eth_getTransactionCount("pending")` under concurrent submission, since the pending pool view can lag or be inconsistent across RPC providers. A **fee-bump** (Retry Policy, ADR-0003) is a **new Transaction** at the *same nonce* (CONTEXT.md's Attempt-vs-Transaction split maps exactly onto go-ethereum's own replace-at-same-nonce shape) and must set both `maxFeePerGas` and `maxPriorityFeePerGas` at least `PriceBump`% (10% default, but pool-operator-configurable — Base's sequencer may run a different value, so this shouldn't be hardcoded as "10%" without checking) above the stuck transaction's values, or every RPC/sequencer that enforces this default will reject it outright. A transaction stuck behind a nonce gap can *only* be resolved by replacing the transaction at the gapped nonce (or waiting) — this is the direct EVM analogue of Solana's blockhash-expiry problem, but structurally different: it's an unresolved position in a sequence, not a time-boxed validity window.

---

## 2. EIP-1559 fee market

EIP-1559 (`Final`, Byzantium→London hard fork) introduces a new, typed transaction (`TransactionType = 2`, per EIP-2718 — see §9) whose payload is:

```
rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit,
     destination, amount, data, access_list, signature_y_parity, signature_r, signature_s])
```

- **`max_fee_per_gas`**: the absolute ceiling the sender is willing to pay per unit of gas, inclusive of both the base fee and the priority fee.
- **`max_priority_fee_per_gas`**: the maximum tip offered to the block producer.
- **Base fee** is a *per-block*, protocol-computed value (not chosen by the sender), adjusted from the parent block's gas usage relative to its gas target (`parent_gas_target = parent_gas_limit / ELASTICITY_MULTIPLIER`, `ELASTICITY_MULTIPLIER = 2`):
  - If parent gas used == target: `base_fee_per_gas` unchanged.
  - If above target: `base_fee_per_gas_delta = max(parent_base_fee_per_gas * gas_used_delta // parent_gas_target // BASE_FEE_MAX_CHANGE_DENOMINATOR, 1)`, base fee increases.
  - If below target: analogous decrease (no `max(...,1)` floor).
  - `BASE_FEE_MAX_CHANGE_DENOMINATOR = 8` — i.e. base fee can move at most ~12.5% per block in either direction.
- **Payment / effective price**: `priority_fee_per_gas = min(max_priority_fee_per_gas, max_fee_per_gas - base_fee_per_gas)`; `effective_gas_price = priority_fee_per_gas + base_fee_per_gas`. The base-fee portion is burned; only the priority fee goes to the block producer. A transaction is only includable if `max_fee_per_gas >= base_fee_per_gas`.
- **Signing hash**: `keccak256(0x02 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, destination, amount, data, access_list]))`, signed via secp256k1 to produce `(signature_y_parity, signature_r, signature_s)`.

Source: EIP-1559, `ethereum/EIPs` repo — https://eips.ethereum.org/EIPS/eip-1559.

**`eth_feeHistory`**: an RPC method (added alongside EIP-1559) for estimating fees over recent blocks — takes a block count (1–1024), a `newestBlock` (number or tag, including `"latest"`/`"pending"`/`"safe"`/`"finalized"`), and an optional list of `rewardPercentiles` (ascending percentiles of each block's effective priority fees per gas, weighted by gas used); returns historical `baseFeePerGas`, `gasUsedRatio`, and the requested percentile rewards. Source: Ethereum JSON-RPC (`ethereum/execution-apis`) spec, as summarized in the official docs at https://ethereum.github.io/execution-apis/ and https://ethereum.org/en/developers/docs/apis/json-rpc/ (both reflecting the `ethereum/execution-apis` OpenRPC spec).

**Implication for this engine's Chain Handler:** `prepare()` for EVM must set `maxFeePerGas`/`maxPriorityFeePerGas` (never a bare legacy `gasPrice`, to remain correctly-priced under base-fee volatility) — a reasonable default estimate is `eth_feeHistory`'s recent base fee plus a percentile-derived tip, though the exact estimation policy is an implementation choice, not something this research pins. A **fee-bump** (Retry Policy on) concretely means: build a *new* `PreparedTransaction`/`SignedTransaction` (new Transaction, same nonce) with both fields raised at least the enforced bump percentage (§1) above the stuck transaction's own values — not just re-signing the same fields. Base fee's ~12.5%-per-block ceiling means fee spikes are bounded and somewhat predictable, which may matter for how aggressively a default fee-bump policy is tuned relative to e.g. Solana's blockhash-refresh retry (`solana-chain-handler` issue 06).

---

## 3. EIP-155 chain ID replay protection, and Base's chain IDs

EIP-155 (Final) fixes the transaction-replay problem across two chains that share transaction format/history (e.g. mainnet vs. a fork/testnet) by folding the chain ID into what gets signed. For a *legacy* transaction, instead of hashing 6 RLP elements `(nonce, gasprice, startgas, to, value, data)`, a chain-ID-aware signature hashes 9: `(nonce, gasprice, startgas, to, value, data, chainid, 0, 0)`, and the resulting signature's `v` **MUST** be `{0,1} + CHAIN_ID * 2 + 35` (the `{0,1}` being the y-parity bit) — so `chainid` is baked directly into the signature-recovery arithmetic, not just appended as metadata. A transaction signed for one chain ID is cryptographically invalid (wrong `v`, or wrong signing hash) when replayed against a node expecting a different chain ID.
Source: EIP-155, `ethereum/EIPs` — https://eips.ethereum.org/EIPS/eip-155. (Typed transactions, EIP-1559/EIP-2930, carry `chain_id` as an explicit RLP field in the payload itself instead — see §2/§9 — same purpose, cleaner encoding.)

**Base's chain IDs** (official Base docs):
- Base **mainnet**: chain ID `8453`, RPC `https://mainnet.base.org`, explorer `basescan.org`.
- Base **Sepolia** (current public testnet): chain ID `84532`, RPC `https://sepolia.base.org`, explorer `sepolia.basescan.org`.

Source: Base Documentation, "Connect to Base" — https://docs.base.org/base-chain/quickstart/connecting-to-base.

**Implication for this engine's Chain Handler:** chain ID is exactly the kind of "deployment config detail" ADR-0017/CONTEXT.md's `Chain` entry describes (RPC URL, chain ID, mint/contract addresses passed into the one EVM Chain Handler instance) — never a separate `Chain` type value. `prepare()`/`sign()` must bake the configured chain ID into every transaction it builds (as an explicit field for typed transactions), and `validateSignedTransaction` (§9, ADR-0032) should reject a signed transaction whose embedded chain ID doesn't match this instance's configured network — a structural, RPC-free check exactly like Solana's `validateSignedTransaction` checks a signature/fee-payer rather than simulating.

---

## 4. Base specifics as an OP Stack L2

**Sequencer submission path.** Base runs a centralized sequencer (an OP Stack "Bedrock"-derived rollup) that accepts transactions, orders them, and produces L2 blocks; block production/gossip happens off L1 in real time, and batches of L2 transaction data are later posted to L1 (Ethereum) for data availability, from which anyone can independently derive/verify the L2 chain state.

**Confirmation semantics — four progressive stages**, per Base's own docs:
1. **Flashblocks (~200ms)**: sub-block preconfirmations from the sequencer; documented reorg rate "less than 0.001%".
2. **L2 block inclusion (~2 seconds)**: the sequencer has built the tx into a full L2 block and distributed it; documented as "near 0% probability of a reorg" ("Only a single Base L2 block has ever reorged").
3. **L1 batch inclusion (~2 minutes)**: the batch containing the L2 block has been posted to Ethereum L1, removing the sequencer's own ability to reorder those transactions; "There has never been a reorg of L2 blocks that were batched to Ethereum L1."
4. **L1 batch finality (~20 minutes)**: the L1 batch transaction itself is older than 2 L1 epochs (64 L1 blocks) and is "in practice impossible to reverse."
Source: Base Documentation, "Transaction Finality" — https://docs.base.org/base-chain/network-information/transaction-finality. Block time: ~2 seconds per L2 block (standard OP Stack cadence), same source plus general OP Stack sequencer docs (https://specs.optimism.io/interop/sequencer.html, `ethereum-optimism/specs`).

**L2 execution fee vs. L1 data-availability fee.** Since the Ecotone upgrade (EIP-4844 blob-based DA), a Base transaction's total cost has two components: (a) ordinary L2 execution gas (priced the same EIP-1559 way as any EVM chain, §2), and (b) an **L1 data fee** covering the cost of publishing that transaction's calldata to L1 as a blob. The `GasPriceOracle` predeploy computes this L1 portion:

- **Address** (same on every OP Stack chain, including Base mainnet and Base Sepolia): `0x420000000000000000000000000000000000000F`.
- **Key methods** (public/external, Solidity, from the contract source):
  - `function getL1Fee(bytes memory _data) external view returns (uint256)` — "Computes the L1 portion of the fee based on the size of the rlp encoded input transaction, the current L1 base fee, and the various dynamic parameters." Takes the *unsigned* RLP-encoded transaction bytes.
  - `function getL1FeeUpperBound(uint256 _unsignedTxSize) external view returns (uint256)` — a gas-cheaper upper-bound estimate for on-chain callers, keyed only by size.
  - `function getL1GasUsed(bytes memory _data) public view returns (uint256)` — L1 "gas used" equivalent for a given tx's calldata (pads 68 bytes for the absent signature).
  - `l1BaseFee()`, `blobBaseFee()`, `baseFeeScalar()`, `blobBaseFeeScalar()` — the raw inputs to the post-Ecotone formula.
  - Post-Ecotone L1 fee formula (`_getL1FeeEcotone`): `l1GasUsed * (scaledBaseFee + scaledBlobBaseFee)` where `scaledBaseFee = baseFeeScalar() * 16 * l1BaseFee()` and `scaledBlobBaseFee = blobBaseFeeScalar() * blobBaseFee()`, i.e. `(zeroes*4 + ones*16) * (16*l1BaseFee*l1BaseFeeScalar + l1BlobBaseFee*l1BlobBaseFeeScalar) / 16e6`. `isEcotone`/`isFjord`/`isIsthmus`/`isJovian` booleans gate which formula version is active.
  - `overhead()`/`scalar()`/`decimals()` are pre-Ecotone, now-deprecated legacy fields kept only for API compatibility.
Source: `ethereum-optimism/optimism`, `packages/contracts-bedrock/src/L2/GasPriceOracle.sol` — https://github.com/ethereum-optimism/optimism/blob/develop/packages/contracts-bedrock/src/L2/GasPriceOracle.sol; predeploy address confirmed at OP Stack Specification, "Predeploys" — https://specs.optimism.io/protocol/predeploys.html (`ethereum-optimism/specs`).

**What "confirmed" should mean for a Chain Handler's status check:** Base's own docs frame this as a choice among the four stages above, not a single answer — "sequencer confirmation" (~2s, stage 2) is fast but not yet L1-secured; "safe"/L1-batch-inclusion (~2min) is the point past which the sequencer itself can no longer reorder the transaction; full L1 finality (~20min) is the strongest guarantee.

**Implication for this engine's Chain Handler:** the L1 data fee is a real, chain-specific cost component that a naive `eth_estimateGas`-only fee estimate would silently omit — for Base specifically, `prepare()`/fee-estimation logic should call `GasPriceOracle.getL1Fee(unsignedRlpTx)` (or the cheaper `getL1FeeUpperBound`) in addition to the ordinary EIP-1559 gas estimate, mirroring how the Funding Check (`getBalance`) must already account for total spend, not just L2 gas. `getStatus()`'s `ChainStatus` mapping (`PENDING`/`CONFIRMED`/`FAILED`) needs an explicit, documented choice of which finality stage counts as `CONFIRMED` — this is a genuinely new design decision this project hasn't made (see Open Questions).

---

## 5. Multicall3

- **Deployed address**: `0xcA11bde05977b3631167028862bE2a173976CA11`, deployed on 250+ chains including Base (mainnet — confirmed by an on-chain example tx linked in the repo) — the same address everywhere because deployment uses a **pre-signed transaction** (a fixed nonce-0, fixed gas price/limit transaction anyone can rebroadcast on a new chain) rather than a factory the deployer must call per-chain, so the resulting contract address (a function of sender+nonce for a plain `CREATE`) is identical across every chain it's deployed to.
- **`aggregate3`** — batches calls, each independently allowed to fail without reverting the whole batch:
  ```solidity
  struct Call3 { address target; bool allowFailure; bytes callData; }
  struct Result { bool success; bytes returnData; }
  function aggregate3(Call3[] calldata calls) public payable returns (Result[] memory returnData);
  ```
- **`aggregate3Value`** — like `aggregate3` but each call also carries its own ETH `value`, and the function enforces that `msg.value` exactly equals the sum of all per-call values:
  ```solidity
  struct Call3Value { address target; bool allowFailure; uint256 value; bytes callData; }
  function aggregate3Value(Call3Value[] calldata calls) public payable returns (Result[] memory returnData);
  // internally: unchecked { valAccumulator += calli.value; } ... require(msg.value == valAccumulator, "Multicall3: value mismatch");
  ```
Source: Multicall3, `mds1/multicall3` GitHub repo — https://github.com/mds1/multicall3 (README: address, chain list, deployment method) and `src/Multicall3.sol` (struct/function definitions) — https://github.com/mds1/multicall3/blob/main/src/Multicall3.sol.

**Implication for this engine's Chain Handler:** Bulk Call (ADR-0006, EVM-only, opt-in, caller-supplied aggregator address — the engine never deploys/owns Multicall3 itself) would encode a batch of Payments as one `EvmCall` targeting the caller-supplied aggregator address, with `data` = ABI-encoded `aggregate3Value(Call3Value[])` (needed, not plain `aggregate3`, whenever any bundled payment carries native ETH `value` — an ERC-20 transfer's `value` is always 0 so `aggregate3` alone would suffice for a token-only batch, but a mixed or native-ETH batch needs `aggregate3Value`). Each element's `target`/`callData` is exactly the `{to, data}` the caller already encoded for that individual Payment/Call (ADR-0018: the engine never invents the per-item encoding, only wraps it). `allowFailure` is a per-item choice this engine would need to make a policy decision about (fail the whole bundle vs. surface a partial per-item result) — flagged in Open Questions.

---

## 6. ERC-20 `transfer` encoding

`ERC-20`/EIP-20 defines: `function transfer(address _to, uint256 _value) public returns (bool success)`.

- **4-byte selector**: `keccak256("transfer(address,uint256)")`'s first 4 bytes → `0xa9059cbb` (the canonical, universally-recognized ERC-20 transfer selector).
- **ABI encoding of the call**: `0xa9059cbb` followed by the recipient address left-padded to 32 bytes (12 zero bytes + 20-byte address) followed by the amount as a big-endian 32-byte `uint256` — 4 + 32 + 32 = 68 bytes of calldata total.
Source: EIP-20, `ethereum/EIPs` — https://eips.ethereum.org/EIPS/eip-20 (function signature); selector derivation per the standard Solidity ABI function-selector rule (`keccak256(canonicalSignature)[0:4]`), which EIP-20's own signature directly determines.

**Implication for this engine's Chain Handler:** this is exactly the "known token-transfer encoding" CONTEXT.md's `Payment` entry names for `paymentToCall` (ADR-0028) on EVM — an SPL-transfer-equivalent for this chain family. `paymentToCall` for a non-native asset would build `{to: tokenContractAddress, data: 0xa9059cbb + encodedRecipient + encodedAmount, value: "0"}`, symmetric to `SolanaChainHandler.paymentToCall`'s `buildSplTransferCall`. A native ETH Payment instead builds `{to: recipient, data: "0x", value: amount}` (no calldata needed, matching Solana's native-transfer-vs-SPL-transfer split in `paymentToCall`/`known-tokens.ts`).

---

## 7. JSON-RPC surface a Chain Handler needs

All from the `ethereum/execution-apis` specification (canonical execution-layer JSON-RPC spec, written in OpenRPC) — https://github.com/ethereum/execution-apis, published at https://ethereum.github.io/execution-apis/:

| Method | Purpose | Notes |
|---|---|---|
| `eth_sendRawTransaction` | Broadcast a signed transaction | Param: signed transaction bytes (`DATA`). Returns the transaction hash. |
| `eth_getTransactionReceipt` | Fetch a transaction's outcome | Param: tx hash. Returns `null` if not yet mined, else a receipt with `status` (§8), `blockHash`, `blockNumber`, `gasUsed`, `logs`, etc. |
| `eth_getTransactionCount` | Read an account's nonce | Params: address, block tag (`"latest"`, `"pending"`, `"earliest"`, `"safe"`, `"finalized"`, or a block number). `"pending"` includes the mempool's own view (next executable nonce for that account per the pool — see §1); `"latest"` is the last confirmed block's committed nonce only. |
| `eth_estimateGas` | Estimate gas for a call/transaction | Takes a transaction-like object (all fields optional); if no gas limit given, the node uses the pending block's own gas limit as an upper bound. |
| `eth_chainId` | Read the connected node's chain ID | No params; returns hex chain ID — this is what a Chain Handler should verify against its own configured chain ID at startup/on each connection, not just trust config. |
| `eth_getBalance` | Read an account's native-asset balance | Params: address, block tag. Returns balance in wei. |

Source: Ethereum JSON-RPC specification (`ethereum/execution-apis`), method descriptions as published at https://ethereum.github.io/execution-apis/ and mirrored at https://ethereum.org/en/developers/docs/apis/json-rpc/.

**Base-specific RPC notes:** Base runs the full standard Ethereum JSON-RPC surface unchanged (per Base's own "Base is a standard EVM chain, any Ethereum tool/wallet/library works unchanged" framing, docs.base.org), plus the `debug_*`/`trace_*` namespaces (`debug_traceTransaction`, `debug_traceCall`, `debug_traceBlockByNumber`, etc.) common to go-ethereum-derived nodes for deep execution tracing — not required for a Chain Handler's core methods above, but available if deeper diagnostics are ever needed.

**Implication for this engine's Chain Handler:** `getBalance` (interface method) maps straight to `eth_getBalance` (native) or an ERC-20 `balanceOf` `eth_call` (token) — symmetric to Solana's native-lamports-vs-ATA split. `getStatus` maps to `eth_getTransactionReceipt` (see §8 for the PENDING-vs-FAILED-vs-not-found subtlety). Nonce assignment (§1) should prefer the Chain Handler's own internally-tracked "next nonce" over trusting `eth_getTransactionCount("pending")` across concurrent Managed Dispatch batches, using the RPC call only to initialize/resync that counter (e.g. on startup, or to detect drift) — the single-nonce-authority requirement ADR-0002 argues for Managed Dispatch generally.

---

## 8. Transaction status / receipt semantics

EIP-658 (Byzantium, Final) replaced a transaction receipt's former intermediate-state-root field with a binary **`status`** field: `0` for failure ("due to any operation that can cause the transaction or top-level call to revert"), `1` for success. This lets any node type determine success/failure without replaying the transaction.
Source: EIP-658, `ethereum/EIPs` — https://eips.ethereum.org/EIPS/eip-658.

**Pre-inclusion vs. definitively-failed, concretely:**
- **Not yet included**: `eth_getTransactionReceipt` returns `null`. The transaction may be pending (nonce-executable, sitting in the pool, likely to be mined), queued (nonce-gapped, §1), dropped/evicted from the pool (e.g. underpriced, replaced, pool full), or simply never propagated. None of these states are distinguishable from each other by receipt lookup alone — a Chain Handler cannot tell "still trying" from "silently vanished" from just `null`.
- **Definitively failed (reverted)**: a receipt *exists* with `status: 0` — the chain executed the transaction (consuming gas, incrementing the nonce) and its top-level call reverted. This is a genuine, provable on-chain outcome.
- **Definitively succeeded**: a receipt exists with `status: 1`.

**Mapping onto this repo's FAILED vs. ABANDONED (ADR-0004):** `status: 0` (a receipt that exists but reverted) maps cleanly to this engine's `FAILED` — the chain itself rejected/reverted it, a definitive on-chain outcome, exactly analogous to Solana's `status.err` case in `getSignatureStatuses` (used by `SolanaChainHandler.getStatus`). A `null` receipt after the configured timeout is exactly what `ABANDONED` (ADR-0004) already describes — "the engine stopped watching without a definitive outcome" — because EVM, unlike Solana (ADR-0030), has **no protocol-level proof that a `null`-receipt transaction can never be included later**: it might still sit in some node's mempool, or get rebroadcast, and confirm on-chain hours after the engine gave up.

**Open design question this repo hasn't resolved (analogous to ADR-0030 for Solana):** ADR-0030 established that Solana's stuck-transaction case resolves to `FAILED`, not `ABANDONED`, *because* blockhash expiry is protocol-provable. EVM's mempool has no equivalent protocol-guaranteed "this exact transaction can never land" signal — a `null` receipt is never provably permanent on its own. The one condition that *can* make it provable is nonce-based: once a transaction with a **higher** nonce from the same sender has been mined and confirmed (with enough confirmations to be itself non-reorgable), the lower-nonce transaction is now cryptographically impossible to ever include (nonces are strictly sequential and non-reusable) — this is a genuine EVM analogue to Solana's blockhash-expiry proof, but it only applies when *this Chain Handler itself* controls the nonce sequence (i.e. Managed Dispatch, where the engine assigned and tracks that nonce) and has visibility into a later transaction confirming. It does **not** apply to a Relay Dispatch transaction, whose nonce this engine never assigned and whose sender's other transactions it has no reason to be tracking. This mechanism is *not* documented in any EIP/go-ethereum source found here — it follows purely from EIP-155/nonce semantics (§1, §3), not from a citable spec paragraph — flagged explicitly as project-original reasoning, not sourced fact.

**Implication for this engine's Chain Handler:** `getStatus` should map `status: 1` → `CONFIRMED`, `status: 0` → `FAILED`, and `null` (still within the ABANDONED timeout) → `PENDING`, with the Coordinator's existing generic `abandonmentTimeoutMs` path (chain-agnostic, per ADR-0030's description of it) producing `ABANDONED` for a `null` receipt past that window — the "chain-aware, probabilistic ~10-15min default" ADR-0004 already anticipates for EVM specifically. Whether to *also* implement the higher-nonce-confirmed proof above as an EVM-specific `FAILED`-resolution path (Solana-style) is exactly the open decision flagged for a future issue (see Open Questions) — it would require the Chain Handler to track a Sender's own nonce-to-hash history, an extra piece of state Solana's `blockhashByHash` doesn't need an analogue of today.

---

## 9. Externally-signed transactions (Relay Dispatch) — validating and deriving bookkeeping

**Typed transaction envelope (EIP-2718, Final):** `Transaction = TransactionType || TransactionPayload` (typed) or a bare RLP list (legacy). `TransactionType` is a single byte, `0x00`–`0x7f`. Detection rule: if the first byte is in `[0x00, 0x7f]`, it's a typed transaction; if in `[0xc0, 0xfe]` (i.e., it parses as the start of an RLP list), it's a legacy transaction — the two ranges never overlap, so a decoder can dispatch on the first byte alone.
Source: EIP-2718, `ethereum/EIPs` — https://eips.ethereum.org/EIPS/eip-2718.

**Decoding an EIP-1559 (type `0x02`) signed transaction** (the type this engine should expect/require for any modern Relay Dispatch submission, given Base is post-London/Ecotone): after stripping the leading `0x02` byte, RLP-decode the remaining payload as `[chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, destination, amount, data, access_list, signature_y_parity, signature_r, signature_s]` (§2) — every field this engine needs (`chainId`, `nonce`, `to`/`destination`, `value`/`amount`, `data`) is a plain positional RLP element, no ABI decoding needed for the envelope itself (only for `data`'s own contents, which remains opaque per ADR-0018/0027).

**Recovering the sender address:** the signature is over `keccak256(0x02 || rlp([chain_id, nonce, max_priority_fee_per_gas, max_fee_per_gas, gas_limit, destination, amount, data, access_list]))` (the payload *without* the trailing signature fields) — recompute that hash from the decoded fields, then run standard secp256k1 public-key recovery using `(signature_y_parity, signature_r, signature_s)` against that hash to recover the signer's public key, then derive the address as the low 20 bytes of `keccak256(pubkey)` (standard Ethereum address derivation — this last step is the well-known Ethereum Yellow Paper convention, not itself restated in EIP-1559's text). For a legacy transaction, the equivalent hash is EIP-155's 9-element RLP hash (§3), with `v` encoding both the chain ID and the y-parity bit that must be decoded back out before recovery.
Source: EIP-1559 (signing hash formula, §2 above) and EIP-155 (legacy signing hash and `v` encoding, §3 above), both `ethereum/EIPs`.

**Implication for this engine's Chain Handler (ADR-0032/0033's Solana precedent):** `validateSignedTransaction` for EVM should, with **no RPC round-trip** (matching `SolanaChainHandler`'s own no-RPC discipline): (1) read the first byte to determine transaction type (§9) and reject anything it doesn't support (e.g. only accept type `0x02`, reject legacy/type-1 if the engine chooses not to support them — a real scoping decision for the future issue); (2) RLP-decode the payload; (3) recompute the signing hash and recover the sender address, rejecting if recovery fails or the signature is malformed (mirrors Solana's `verifySignatures()` check); (4) reject if the decoded `chain_id` doesn't match this Chain Handler instance's configured network (§3) — the EVM-specific version of "a fee payer set" from ADR-0032's Solana description. `broadcast`'s bookkeeping-derivation (ADR-0033's Solana precedent: populate `blockhashByHash` from the signed bytes' own embedded blockhash with no RPC) has a direct EVM analogue: the decoded `nonce` and `chain_id` are already public information embedded in the signed bytes themselves, so `broadcast` can derive whatever internal bookkeeping an EVM Chain Handler ends up needing (e.g. a nonce-to-hash record, if the higher-nonce-confirmed FAILED proof from §8 is ever built) the same way — no RPC needed to read information that's already sitting in the bytes it was handed.

---

## Open questions / decisions this project hasn't made yet

1. **EVM's `FAILED`-vs-`ABANDONED` analogue to ADR-0030.** Solana resolved this by finding a protocol-provable dead end (blockhash expiry). EVM has no equivalent *generic* proof, but §8 above identifies one *conditional* proof: a later transaction from the same sender at a higher nonce, once itself confirmed with sufficient depth, cryptographically proves the lower-nonce transaction is dead. This only works for a nonce sequence the Chain Handler itself owns and watches (Managed Dispatch), never for Relay Dispatch (nonce assigned by someone else, no reason to be watching that sender's other traffic) — so any future EVM Chain Handler may need *two* different resolution paths for the two dispatch modes, unlike Solana where both get identical treatment (ADR-0033). Undecided: whether this proof is worth building at all versus just keeping EVM's existing chain-aware probabilistic `ABANDONED` timeout (ADR-0004) as the whole story.
2. **Does Base's L1 data fee need its own line item anywhere** — in the Funding Check's balance comparison, in whatever a "cost" or "fee" field looks like in a persisted Transaction record, or in how a Retry Policy fee-bump reasons about "how much more will this cost" (a bump to `maxFeePerGas`/`maxPriorityFeePerGas` doesn't touch the L1 fee component at all, so a fee-bumped Base transaction's total cost changes by less than the bump percentage might suggest, or the L1 component could independently move between the original and replacement broadcast). Undecided.
3. **Which of Base's four finality stages (§4) counts as `CONFIRMED`** for `getStatus`. Sequencer/L2-block inclusion (~2s) is fast but pre-L1; "safe" (~2min, batch posted to L1) is the point the sequencer itself can't reorder past; full finality (~20min) is strongest. This is a real product/reliability trade-off (fast-but-softer vs. slow-but-harder confirmation) with no existing ADR precedent — Solana's `getStatus` uses `confirmed`/`finalized` commitment levels (an analogous but not identical two-tier idea) but that mapping was never framed as an open trade-off in `solana-chain-handler`'s spec.
4. **Multicall3's `allowFailure` semantics for Bulk Call.** ADR-0006 says Bulk Call only ever encodes against a caller-supplied aggregator (never owns/deploys one), but doesn't yet say what the engine should set `allowFailure` to per bundled item, or how a partial-failure `Result[]` (`aggregate3`/`aggregate3Value` return `success`/`returnData` per call, but the top-level transaction itself still succeeds and confirms) should map onto this project's `FAILED` semantics for the *individual* payments inside a Bulk Call batch — CONTEXT.md's `Bulk Call` entry doesn't address per-item outcomes at all yet.
5. **Bump-percentage portability.** §1's 10% `PriceBump` default is a go-ethereum client default, not a protocol rule — Base's own sequencer/mempool-equivalent may enforce a different (undocumented, not found in this research pass) minimum, or none at all if it doesn't run a public mempool the way L1 does. A future EVM Chain Handler issue should verify this against Base's actual sequencer behavior before hardcoding "10%" as a fee-bump floor.
6. **Legacy vs. typed-transaction support scope for `validateSignedTransaction`/Relay Dispatch.** §9 flags this as a real scoping choice (type `0x02` only, or also type `0x01`/legacy) that this research surfaces but doesn't resolve.
