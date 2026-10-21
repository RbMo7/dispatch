# Verifier

Check a multisig proposal against your own payment file **before you vote**.

The Dispatch engine proposes payments, but it cannot be trusted to describe them: a compromised engine can propose the wrong payments and report totals that look right (ADR-0049). This tool is the independent check. It shares no code with the engine or the Signer, needs no API key from them, and reads only the chain: you give it an RPC URL and your own file.

It supports a **Squads v4** proposal on Solana and a **Safe** (1.3.0 or 1.4.1) transaction on Base.

## Run it

```sh
cd verifier && pnpm install
```

Squads (Solana): pass the **proposal account address** shown in the Squads app (or in the engine's `approval` block).

```sh
pnpm verify --chain solana \
  --rpc-url https://api.mainnet-beta.solana.com \
  --proposal <proposal address> \
  --payments payments.csv
```

Safe (Base): pass the Safe address and the **safeTxHash** the Safe app shows for the queued transaction.

```sh
pnpm verify --chain base \
  --rpc-url https://mainnet.base.org \
  --safe 0xYourSafe \
  --safe-tx-hash 0x... \
  --nonce 12 \
  --payments payments.csv
```

An RPC URL often contains a key. It is never printed, but to keep it out of your shell history you can set `VERIFIER_RPC_URL` instead of `--rpc-url`.

| Option                      | Meaning                                                                                                                                                                                     |
| --------------------------- | ------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------------- |
| `--chain`                   | `solana` or `base`.                                                                                                                                                                         |
| `--rpc-url`                 | A JSON-RPC endpoint for that chain.                                                                                                                                                         |
| `--payments`                | Your payment file (below).                                                                                                                                                                  |
| `--proposal`                | Solana: the Squads proposal account.                                                                                                                                                        |
| `--safe`, `--safe-tx-hash`  | Base: the Safe and the hash the owners see.                                                                                                                                                 |
| `--nonce`                   | Base: the proposal's nonce. Default: the Safe's current nonce (the next transaction to run), which is printed. If the hash does not match, the tool also tells you if it matches at another nonce. |
| `--bundle-size`             | Base: how many payments the engine puts in one Safe transaction (default 50: use the engine's configured size). Your file is cut into consecutive chunks of this size. Ignored on Solana.    |
| `--tx-service-url`          | Base, optional: the Safe Transaction Service (for example `https://api.safe.global/tx-service/base`). Lets the tool decode the proposal, show a line-by-line diff, and read confirmations. |

Exit code: **0** `MATCH`, **1** `MISMATCH`, **2** a usage or RPC error (nothing was verified).

## The payment file

Your own record of what should be paid, in base units (lamports, token base units, wei). CSV with a header row, or JSON.

```csv
recipient,asset,amount
2dXk7KqsKDMVK9F9zssWKz18nRvQ6faPonREprwn72zi,native,1000000
Ge2MhVK4n8HLYqAc39duT1BfYoyBLC4aUnq9Uze5HPzu,4vmApcQdbZCc8BBXnoLcih69TH1uhGKUnDXU2yb1p18e,500
```

```json
[
  { "recipient": "0x1111111111111111111111111111111111111111", "asset": "native", "amount": "1000000000000000" },
  { "recipient": "0x1111111111111111111111111111111111111111", "asset": "0x036CBD53842c5426634e7929541eC2318f3dCF7e", "amount": "5000000" }
]
```

- `recipient`: the wallet that receives the funds (for a token, the wallet, not its token account).
- `asset`: `native` (SOL or ETH), or the token mint (Solana) / token contract (Base).
- `amount`: a whole number of base units. Use a string in JSON for large values. No decimals: `1.5 SOL` is `1500000000`.
- A JSON file may also be `{ "payments": [ ... ] }`. Order matters for Safe (see below); for Squads it does not.
- Include the **whole** Dispatch's payments, in the order the engine received them. A proposal holds a subset of a Dispatch (a large Dispatch is split into several proposals), so most of your file will not be in any one proposal.

## What the output says

- **Squads.** The tool reads the proposal and its vault transaction on chain, decodes every instruction (SOL transfers, SPL Token and Token-2022 `transfer` / `transferChecked`, token-account creation) and resolves each token destination to its owner wallet. `MATCH` means every payment in the proposal appears in your file with the exact recipient, asset and amount (each file payment used at most once), and nothing else is in the proposal. Payments in your file that this proposal does not make are listed and counted as **coverage**, not as an error. Any other instruction is a `MISMATCH` ("unrecognized instruction"). A token destination that cannot be resolved to an owner is a `MISMATCH` and says so.
- **Safe.** The tool rebuilds the MultiSend bundle (`MultiSendCallOnly`, chosen from the Safe's `VERSION()`) for each consecutive chunk of your file and computes the EIP-712 `safeTxHash` for your Safe, the chain id the RPC reports and the nonce. `MATCH` means the hash the owners will sign is exactly the hash of one chunk, and it says which (and which file payments). The hash commits to the payments **and their order**, so the same payments in another order do not match. If no chunk matches, it is a `MISMATCH`; add `--tx-service-url` to decode the proposal and see the differences against the closest chunk. If you give `--tx-service-url`, the tool also re-hashes the service's copy of the transaction and refuses to trust it if it does not give the hash you passed.
- Both print the proposal **status** (Squads: Active, Approved, Executed, Rejected, Cancelled, with approvals against the threshold and the time lock; Safe: the nonce position, and confirmations when `--tx-service-url` is given), so you can also check a proposal after it has been decided.

## What `MATCH` proves, and what it does not

It proves that the payments the multisig will make are the payments in your file: same recipients, assets and amounts.

It does **not** prove:

- **That it is the right multisig, Safe or program.** The tool prints the Squads program, multisig and vault (or the Safe address, version and chain) it read. **Confirm those yourself** against what your organisation expects. A proposal on a look-alike multisig can match your file perfectly.
- **That your file is right.** If the file came from the same place as the proposal, it proves nothing. Use your own record of what you meant to pay.
- **That the payment will succeed.** It does not check that the vault or Safe has the funds, or that a recipient can receive a token.
- **Anything beyond payments**, such as who the other signers are, or whether the multisig's own settings changed.

## Limits

- Squads: only a vault transaction that holds payments the tool recognises. Batches, config transactions and instructions from other programs report `MISMATCH`. A closed proposal (Squads lets anyone close an executed, rejected or cancelled proposal) can no longer be read: the tool exits with an error and you must check a block explorer.
- Squads: a proposal that uses address lookup tables is decoded by reading the tables; if one cannot be read, that is a `MISMATCH`.
- Safe: versions 1.3.0 and 1.4.1 only. A transaction that is not the engine's `MultiSendCallOnly` bundle of native and ERC-20 `transfer` items is a `MISMATCH`.
- Safe: the hash alone cannot show _what_ differs. Without `--tx-service-url` you only learn that no chunk matches (plus which nonce would match, if you gave the wrong one). If the engine's bundle size differs from `--bundle-size`, nothing matches until you set it.
- It trusts your RPC endpoint to tell the truth about the chain. Use one you trust (your own node, or two independent providers: run it twice).
- Squads' stored vault transaction and the Safe hash are read in the formats Squads and Safe define; the tool does not read anything the engine invents.

## Tests

```sh
pnpm test        # offline: fixtures only
RUN_VERIFIER_LIVE=1 pnpm test   # also two read-only checks on public devnet / Base Sepolia data
```

The Squads fixtures in `fixtures/squads.json` are account bytes built with `@sqds/multisig` (see `fixtures/generate-squads.mjs`); the Safe fixtures are the Safe spike's test vectors.
