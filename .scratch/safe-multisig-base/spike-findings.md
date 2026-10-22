# Spike #79: Safe on Base Sepolia (measured 2026-10-21)

Tags: [M] measured on Base Sepolia / the live service, [S] from contract/SDK source, [D] from docs.
Throwaway Safes: 1.4.1+L2 `0x84Ac281B68de095f6227050F56C74d93d294e609` (2-of-3), 1.3.0 `0xD784eeEA715626931bAb54b90b4d9cDE61d8DD97`. Test ERC-20 `0x47b1eafd9462874dc72ae79db82d120b886f178a`. ETH spent from the dev key: ~0.00101 ETH (incl. 0.0006 funding of two throwaway keys).

## Contradictions (with the spec/ADRs)

1. **The official SDK refuses to run without an API key against the hosted service.** [S] `@safe-global/api-kit` 5.0.4 throws "apiKey is mandatory when using api.safe.global". The REST service itself works unauthenticated [M] (2 RPS, 5,000 req/month; 429 beyond 2 RPS). Consequence: the engine should use its own thin REST client (the 4 endpoints below), not api-kit; `BASE_SAFE_API_KEY` is optional in code but effectively mandatory in production (quota, below).
2. **A delegate's proposal is attributed to the registering owner in the service.** [M] `proposer` = the owner who registered the delegate (delegator), `proposedByDelegate` = the engine. In the Safe app it will look like that owner proposed it. The runbook should say so; it is also why the engine's `origin` field is useful.
3. **A non-delegate's proposal is not "hidden"; it is rejected with HTTP 422** [M] ("Sender=... is not an owner or delegate"). `trusted: true` on delegate proposals. So the spec's "what the service shows for a non-delegate" = nothing; the engine learns about a missing delegate registration at the first POST, and the startup check must use `GET /v2/delegates/?safe=&delegate=`.
4. **"Safe nonce moved past the proposal => APPROVAL_REJECTED" is not sufficient alone.** [M] If the engine's own tx executed, the nonce also moves. The watcher must check `isExecuted` and the executing `safeTxHash` for that nonce (service) or the `ExecutionSuccess(txHash)` event on-chain; only a different hash at that nonce is a replacement. Also the superseded proposals stay in the service forever with `isExecuted: false` (they are never marked rejected/dropped).
5. **RPC read-after-write lag on the public Base Sepolia RPC (`sepolia.base.org`).** [M] Reading `nonce()`/storage immediately after a receipt returned the stale value several times (nonce 1 vs real 2; guard slot). Safe-state reads for the watcher/startup must pin `blockNumber` to the receipt block or retry. The service itself also lags a few seconds on `nonce` after execution.
6. No other spec assumption broken: non-owner execution works, `approveHash` works, GS013 leaves the nonce unchanged, MultiSendCallOnly is canonical and cheap.

## 1. Safe Transaction Service (answer first)

- **Base Sepolia IS supported.** [M] `https://api.safe.global/tx-service/basesep` (shortName `basesep`). **Base mainnet:** `https://api.safe.global/tx-service/base`. [M] Both return `GET /api/v1/about/` 200 (service 6.12.0, `ETH_L2_NETWORK: true`, event indexing, no tracing node). Old hosts `safe-transaction-base-sepolia.safe.global` / `safe-transaction-base.safe.global` 308-redirect to these.
- Paths: `<base>/api/v1/...` and `/api/v2/...` (SDK uses v2 for propose and delegates).
- **Works without an API key** [M] for everything we need: `GET /v1/safes/{safe}/` (owners, threshold, nonce, modules, guard, masterCopy, version `1.4.1+L2`), `POST /v2/safes/{safe}/multisig-transactions/` (propose), `GET /v2/safes/{safe}/multisig-transactions/?nonce=N`, `GET /v2/multisig-transactions/{safeTxHash}/` (confirmations), `POST /v1/multisig-transactions/{hash}/confirmations/`, `POST /v2/delegates/`, `GET /v2/delegates/?safe=&delegate=`. The Safe was indexed within seconds of deployment. Unauthenticated limits: `x-ratelimit-limit: 5000` (per month, reset ~30 days) and 2 RPS [M]: 6 parallel requests => 2 x 200, 4 x 429. A bogus `Authorization: Bearer sk_invalid` header on `/about/` was still 200 [M] (not validated there; do not rely on it).
- **API key:** header `Authorization: Bearer <key>` [D docs.safe.global/core-api/how-to-use-api-keys; S api-kit]. Keys come from developer.safe.global. 401 invalid/missing key, 429 quota/rate exceeded. Quota headers `X-RateLimit-Limit/Remaining/Reset` (Reset = seconds) on every response [D, M].
- **Plans** [D safe.global/api, partial]: Builder (free), Growth EUR199/mo, Scale from EUR499/mo; RPS 5 / 15 / 50 respectively. Exact monthly quotas are not published on a scrapeable page (behind the plan table); confirm in the dashboard before choosing. One API unit = one HTTP request.
- **Poll budget:** unauthenticated 5,000/month = one request per ~8.6 min. Watching one open proposal at 15 s polling is ~173k requests/month; at 60 s, ~43k. So a key is required in production; size #84/#88 cadence from the plan quota (e.g. 60 s while awaiting, hourly after the first day for the re-watch). Keep polls to one request each: `GET /v2/multisig-transactions/{hash}/` returns confirmations, `isExecuted`, `confirmationsRequired`; `GET /v1/safes/{safe}/` returns nonce+owners+threshold.
- **Self-host** [D github.com/safe-global/safe-transaction-service]: Django app + Postgres + Redis + RabbitMQ via docker-compose; set `ETHEREUM_NODE_URL`, `DJANGO_SECRET_KEY`; for an L2 like Base use event indexing (no tracing node); `.env` sample in repo; check `curl localhost:8000/api/v1/about/`. Operator then sets `BASE_SAFE_TX_SERVICE_URL` to it (paths `/api/v1|v2` the same; the hosted prefix is `/tx-service/<shortName>`). Not run here.

## 2. Delegate flow [M unless noted]

- **Register (owner, one-time):** `POST /v2/delegates/` body `{safe, delegate, delegator, label, signature}`; api-kit `addSafeDelegate({safeAddress, delegateAddress, delegatorAddress, label, signer})`. 201 on success. `delegator` must be an owner (else 400 "Provided delegator=... is not an owner"). `expiryDate: null` by default.
- **Signature to register:** the OWNER signs EIP-712 typed data: domain `{name:"Safe Transaction Service", version:"1.0", chainId}` (no verifyingContract), type `Delegate(address delegateAddress, uint256 totp)`, `totp = floor(unix_seconds / 3600)` (valid for the current hour window) [S api-kit signDelegate, D]. Plain EOA signature, v 27/28.
- **List:** `GET /v2/delegates/?safe=<safe>` -> `{delegate, delegator, label, expiryDate}`; use it for the startup check. Removal: `DELETE /v2/delegates/{delegate}` with `{delegator, signature}` (same typed data) [S].
- **What a delegate may post:** a proposal (`POST /v2/safes/{safe}/multisig-transactions/` with `sender` = delegate). It CANNOT confirm: `POST /v1/multisig-transactions/{hash}/confirmations/` signed by the delegate -> 400 "Signer=... is not an owner". A stranger's confirmation: same 400. A stranger's proposal: 422.
- **Exact proposal signature:** sign the 32-byte `safeTxHash` (EIP-712 digest) directly with secp256k1, i.e. raw digest, no prefix; 65 bytes r|s|v, v = 27/28. Accepted. Also accepted: eth_sign style (personal_sign over the 32 hash bytes) with v bumped by +4 (v = 31/32). REJECTED: personal_sign over the hash with unmodified v 27/28 (service recovers a different signer). The Signer can therefore keep using the same raw-digest primitive as for transactions (ADR-0052). The body also needs `contractTransactionHash` = safeTxHash (service re-computes and verifies it), plus `to,value,data,operation,safeTxGas,baseGas,gasPrice,gasToken,refundReceiver,nonce,sender,signature,origin`. Re-posting the same proposal is idempotent (201 again, no duplicate).
- Service view of a delegate proposal: `proposer` = delegator owner, `proposedByDelegate` = delegate, `trusted: true`, `confirmations: []` (the delegate's signature is NOT counted as a confirmation), `dataDecoded` with a decoded multiSend `valueDecoded` list (the Safe app shows this to owners), `origin` echoed.

## 3. EIP-712 domain and struct (hashes verified three ways: viem `hashTypedData`, protocol-kit `getTransactionHash`, on-chain `getTransactionHash`)

- Domain: `{ chainId, verifyingContract: <safe> }` only (no name/version) — identical for 1.3.0 and 1.4.1 and the L2 variants (typehash `EIP712Domain(uint256 chainId,address verifyingContract)`) [M both versions, S].
- Struct `SafeTx(address to,uint256 value,bytes data,uint8 operation,uint256 safeTxGas,uint256 baseGas,uint256 gasPrice,address gasToken,address refundReceiver,uint256 nonce)`. Sign the digest `keccak256(0x1901 || domainSeparator || structHash)`.
- Vectors (1.4.1+L2 Safe `0x84Ac281B68de095f6227050F56C74d93d294e609`, chain 84532; full inputs in `vectors.json`; 1.3.0 Safe `0xD784eeEA715626931bAb54b90b4d9cDE61d8DD97` vectors in `vectors-1.3.0.json`, same inputs, different verifyingContract):
  - v1 ETH transfer to 0x1111..1111, value 1e15, nonce 0, op 0: `0xfd11475aa4e3a78acc2033b01fb4fcce98e1f948f4faf7563b73e3853443300e`
  - v2 MultiSendCallOnly(1.4.1) delegatecall (1 wei native + USDC transfer 5e6), nonce 7: `0x4ad3beb568f992d2a87b4ab1dcb66bef600254d0b1c428aa15ff842fde28860b`
  - v3 non-zero gas fields, gasToken/refundReceiver set, nonce 123456: `0xbd958f820b48f94884ab292c11d023cf2b8dfb2b1be0fc3a074ee221ed9e3457`
  - 1.3.0 Safe: v1 `0x44a61601...9014`, v2 `0x3c1fc219...6f98`, v3 `0x21adc3cd...984c` (full values in vectors-1.3.0.json).
- Code: `lib.mjs` (`typedData`, `safeTxHash`).

## 4. MultiSendCallOnly

- Addresses [S safe-deployments 1.x, M code present on 84532]: **1.4.1: `0x9641d764fc13c8B624c04430C7356C1C7C8102e2`** (canonical; same on 8453 and 84532). **1.3.0: `0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B`** (eip155 variant; the package maps both 8453 and 84532 to it; the canonical-variant `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` also has code on Base Sepolia, identical codeHash). Code verified on Base Sepolia only; mainnet NOT queried (rule), mapping comes from the package. The Signer's allowlist should be this set {1.3.0 eip155, 1.3.0 canonical, 1.4.1} chosen by the Safe's `VERSION()`.
- Encoding [M]: `multiSend(bytes)` where bytes = concat of `operation(uint8) | to(address,20) | value(uint256,32) | dataLength(uint256,32) | data`; native item: operation 0, value=amount, data empty; ERC-20 item: operation 0, to=token, value 0, data=`transfer(to,amount)`. MultiSendCallOnly only allows operation 0 inside. The outer Safe tx: `to`=MultiSendCallOnly, `value` 0, `operation` 1 (delegatecall), `data`=multiSend calldata. Code: `lib.mjs` (`multiSendCalldata`). The service decoded it (`dataDecoded.valueDecoded`).
- Inner failure reverts the whole bundle (all-or-nothing) [M].

## 5. Executing from a non-owner EOA [M]

- 2-of-3 Safe deployed (305,883 gas, via protocol-kit, `createSafeDeploymentTransaction`). The engine key (a non-owner, registered delegate) submitted `execTransaction` and it succeeded (gas 131,147 for a 2-item bundle). **Yes, non-owner execution works.**
- Signatures: 65 bytes each, concatenated in ascending owner-address order (numeric). ECDSA: r|s|v with v 27/28 over `safeTxHash`. Pre-approved (on-chain `approveHash`): r = owner padded to 32, s = 0, v = 1. A mix worked in one call (o2 ECDSA, then o1 approveHash; 130 bytes). `approveHash(bytes32)` costs ~32.9k gas, emits `ApproveHash(hash, owner)`; `approvedHashes(owner, hash)` returns 1. The service indexed the on-chain approval as a confirmation with `signatureType: APPROVED_HASH` within 15 s, before execution; ECDSA ones are `EOA`. The executed tx in the service shows `executor`=engine address, `isExecuted`, `isSuccessful`, `transactionHash`, `gasUsed`.
- **Inner failure:** with `safeTxGas=0` and `gasPrice=0`, a failing inner call makes `execTransaction` revert with `Error("GS013")` (simulation shows it; sent on-chain with explicit gas it is a reverted tx, 92,853 gas wasted, 0 logs). **The Safe nonce is unchanged** (0 before/after). So: always simulate (`eth_call`/estimateGas) before sending; a GS013 simulation means the proposal can never succeed as built (insufficient Safe balance etc.).
- `estimateGas` for the engine ran 2-3% above `gasUsed` on bundles; add margin (1.2x used in the spike).

## 6. Rejection and replacement [M]

- Two or more different proposals at the same nonce coexist in the service. `GET /v2/safes/{safe}/multisig-transactions/?nonce=N` lists them all, newest `submissionDate` first (the Safe app shows them as alternatives). Re-posting the same hash is idempotent.
- Standard rejection = a Safe tx to the Safe itself, value 0, data 0x, operation 0, same nonce; an owner proposes it (owner sender), another owner confirms via `POST /v1/multisig-transactions/{hash}/confirmations/`, anyone executes it with the service's confirmations (we executed it from the engine, 66,622 gas).
- After the rejection executed: the rejection tx has `isExecuted: true, isSuccessful: true, transactionHash`; the competing proposals at that nonce remain `isExecuted: false` forever, and `GET /v1/safes/{safe}/` nonce moved to N+1. **Watcher rule:** a proposal P at nonce N is replaced/rejected iff chain nonce > N and no executed tx with `safeTxHash == P` exists (service `isExecuted` for P false, or on-chain `ExecutionSuccess/Failure(txHash)` events; read the event `txHash` to see which hash won). A self-call, 0-value, empty-data winner is a rejection (can be reported as such); any other winner is a replacement. Both map to `APPROVAL_REJECTED`.
- Note: stale nonce reads right after execution (see Contradiction 5).

## 7. Gas of an execTransaction MultiSend bundle (2 ECDSA sigs, fresh recipients = worst-case storage, half native half ERC-20) [M]

| N | gasUsed | per item | exec calldata bytes | L1 fee (Sepolia, ~0) |
|---|---|---|---|---|
| 1 (native) | 105,200 | 105k | 294 | 234 wei |
| 10 | 396,011 | 39.6k | 1,414 | 136 wei |
| 25 | 878,574 | 35.1k | 3,142 | 92 wei |
| 50 | 1,672,693 | 33.5k | 6,150 | 1,342 wei |
| 100 | 3,269,319 | 32.7k | 12,102 | 2,421 wei |

- Fixed overhead ~70k, ~32.5k per fresh item (ERC-20 to a new holder is the dominant cost; repeat recipients cost less). Base Sepolia block gas limit 1.2e9; `estimateGas` worked up to N=400 (13.3M) and failed (GS013, out of gas inside) at N=600, i.e. the per-tx gas cap (~16.7M) bites near ~500 items. The Sepolia L1 data fee here is meaningless; on mainnet it scales with calldata (~120 bytes/item) and must be estimated by the existing fee code.
- **Recommendation: bundle limit 50** (= existing `BASE_BULK_CALL_MAX_BATCH_SIZE` default): ~1.7M gas worst-case, ~6 KB calldata, comfortable on-chain (<12% of the ~16.7M tx cap), and still reviewable by owners in the Safe app. Allow raising to 100 (3.3M gas) by config; do not exceed ~300.

## 8. Guards, modules, versions, reading state [M]

- Read on-chain: `getOwners()`, `getThreshold()`, `nonce()`, `VERSION()` (returned "1.4.1" and "1.3.0"; the service shows `1.4.1+L2`), `isOwner(a)`, `domainSeparator()`.
- **Guard:** storage slot `keccak256("guard_manager.guard.address")` = `0x4a204f620c8c5ccdca3fd54d003badd85ba500436a431f0cbda4f558c93c34c8`; non-zero => guard set. Verified: zero on a fresh Safe; after `setGuard(<erc165 guard>)` the slot held the guard address and the service `guard` field matched. (The 1.5.0 module guard slot is `keccak256("module_manager.module_guard.address")` = `0xb104e0b9...9947`, only relevant if 1.5.0 is ever accepted.)
- **Modules:** `getModulesPaginated(0x...01, 10)` returns the list; verified after `enableModule` (and the service `modules` field matched). Also `GET /v1/safes/{safe}/` gives `guard`, `moduleGuard`, `modules`, `masterCopy`, `version` in one request; use on-chain as authority and the service as a cross-check.
- Singleton: storage slot 0 of the proxy; protocol-kit deploys the L2 singleton on Base (1.3.0 L2 `0xfb1bffC9d739B8D520DaF37dF666da4C687191EA`, 1.4.1 L2 `0x29fcB43b46531BcA003ddC8FCB67FFE91900C762`; L1 variants 1.3.0 `0x69f4D178...2938`, 1.4.1 `0x41675C09...461a`).
- **Versions to accept:** 1.3.0 and 1.4.1 (both L1 and L2 variants), both verified for hashing; 1.4.1 fully exercised end to end. Reject others (1.5.0 changes module-guard storage and is not in the Safe app default yet; <1.3.0 has no chainId in the domain).
- A guard did not break execution in the test (guard that returns OK); guards in general can revert, hence the startup warning.

## Open items for the spec (not tested)

- Authenticated quota numbers for Builder/Growth (dashboard).
- Mainnet code check of the MultiSendCallOnly addresses (forbidden here; do it read-only at the smoke test).
- Delegate removal effects on already-posted proposals; delegate expiry (`expiryDate`) semantics.
- Service behaviour for contract-signature (v=0) owners; not in scope for EOA owners.

## Correction found while building the verifier (#89)

The Safe 1.3.0 test vectors in `spike-vectors/vectors-1.3.0.json` carry no `chainId` field (they match with 84532), and their v2 vector uses the 1.4.1 MultiSend address. For 1.3.0 the verifier checks against an independent viem computation. Treat the 1.4.1 vectors as the authoritative fixtures.
