# Live flow coverage

A repeatable run that drives each kind of Dispatch through a real engine on Solana devnet and Base Sepolia, and saves console screenshots of every Dispatch's Flow, Items and Details. It covers every row of the Live flow coverage table in `.scratch/flow-coverage/spec.md`, 1 to 14, including a Squads multisig and a Safe the run creates.

It spends testnet funds. Run it by hand, never in CI.

## What it needs

- Postgres, for the scratch database `local-engine.ts` creates and drops. It connects to `FLOWS_PG_ADMIN_URL`, by default `postgres://dispatch:dispatch@localhost:5433/postgres`, and never touches the `dispatch` database.
- A funded devnet wallet, by default `.devnet-fixtures/sender-keypair.json` (`FLOWS_SOLANA_KEYPAIR` to change it), and the committed Base dev key in `signer/keys.dev.json`, funded on Base Sepolia (`FLOWS_BASE_KEY`, a `{ "privateKey": "0x…" }` file, to change it). Give a run its own keys when another engine may be sending from the shared ones.
- RPC URLs from the repository's `.env` (`SOLANA_DEVNET_RPC_URL`, `BASE_SEPOLIA_RPC_URL`; `FLOWS_DOTENV` to read another file). The public endpoints are the fallback.
- Google Chrome, for the screenshots (`FLOWS_CHROME` to point elsewhere).
- The console built into `web/dist/engine`: `cd web && pnpm install && npx vite build --mode engine`.

Everything the run makes goes in `FLOWS_STATE_DIR`, by default `scripts/flows/.state` (ignored by git): throwaway keys, deployed asset addresses, the engine's config and logs, results and screenshots.

## Run it

```sh
export FLOWS_STATE_DIR=/tmp/dispatch-flows
pnpm tsx scripts/flows/local-engine.ts up     # assets, database, proxy, Signer, API on :8501, worker
pnpm tsx scripts/flows/run.ts                 # every row; or name rows: run.ts 6 9
pnpm tsx scripts/flows/local-engine.ts down   # stops everything and drops the database
```

`up` first runs `prepare.ts`, which creates the test assets once and caches their addresses in `assets.json`: an SPL mint and a Token-2022 mint on devnet, and on Base Sepolia an ERC-20 (`FlowToken`), a payable contract (`FlowVault`) and an owner-only Multicall3-style aggregator (`FlowAggregator`) funded with the ERC-20. The engine gets them as `SOLANA_KNOWN_TOKENS` (`FSPL`, `F22`) and `BASE_KNOWN_TOKENS` (`FLOW`). It also deploys a second ERC-20, `FUSD`, that the engine is not told about, for row 3 to add (`extra-token.json`).

Then `multisig.ts` creates the two Multisig Senders once and caches them in `multisigs.json`:

- **Squads, on devnet.** A 2-of-3 multisig made with `multisig_create_v2`: three voters, the engine's member key with Initiate and Execute as its rent collector, no time lock and no config authority. The member, the vault and the voters are funded from the devnet wallet, and the vault gets 20 `FSPL`.
- **Safe, on Base Sepolia.** A Safe 1.4.1 with three owners and a threshold of 2, created through the canonical `SafeProxyFactory`. The engine's executor is registered with the hosted Safe Transaction Service as a delegate, signed by the first owner. The executor gets ETH for gas, and the Safe gets ETH and `FLOW` to pay out.

Every multisig key is a throwaway in `keys/`. Each chain has three Senders: `payouts` (the funded keys, the default), `refunds` (a key the run makes and funds through the engine) and `treasury` (the multisig, with its Approvers named). The dev Signer holds the multisig keys under the `allowedMultisig` and `allowedSafe` policies the engine's pin check reads. Row 11's Proposals time out 3 minutes after they are created (`FLOWS_SQUADS_DEADLINE_MS`), so the run can watch one do it.

The hosted Safe Transaction Service allows 2 requests a second without an API key, so `up` starts the worker only once the API answers: both run the Safe Sender's startup checks.

For someone watching the console while it runs, `FLOWS_PACE_MS=20000` leaves each row's end state, and the held Dispatch in row 13, on screen for 20 seconds, and `FLOWS_LIVE_LOG=<file>` appends a line for each row and each Dispatch submitted, with its id.

To run against another engine, skip `local-engine.ts` and set `FLOWS_ENGINE_URL`, `FLOWS_AUTH_TOKEN` and `FLOWS_OPERATOR_TOKEN`. That engine must know the same assets and Senders. Rows 9 and 10 also need its RPCs to go through `rpc-proxy.ts` (`FLOWS_PROXY_URL`); without it they are recorded as skipped.

## What each row does

| Row | Flow | How |
| --- | --- | --- |
| 14 | Named Senders | `payouts` funds `refunds` and the two relay wallets; later `refunds` pays on each chain |
| 1 | SPL and Token-2022 payments | One Dispatch, one item in each test mint |
| 2 | ERC-20 payment | `FLOW` on Base |
| 3 | Unconfigured asset | A `USDT` payment, refused with `UNKNOWN_ASSET`; the run records that nothing appears in the list or the activity record. Then an `FUSD` payment is refused the same way, `FUSD` is previewed and added through `/v1/assets`, and the same request, same key, is sent again and confirms |
| 4 | Base call with value | `FlowVault`'s ABI is registered through `/v1/contracts`, then `FlowVault.deposit(note)` with 0.000001 ETH |
| 5 | Solana program call | A Memo and a raw SPL `transferChecked`, both as `call` items |
| 6 | Relay | A transfer signed by a relay wallet on each chain |
| 7 | Bulk Call | An ERC-20 and an ETH payment through `FlowAggregator`, `allowFailure: false` |
| 8 | Partial | An ETH payment plus a call to `FlowVault.revertAlways()` |
| 9 | Fee bump | The proxy reports a quarter of the real base fee for 20 seconds, so the first transaction is underpriced; `retryPolicy: true` and `BASE_STUCK_AFTER_MS=30000` make the engine bump it |
| 11 | Squads multisig | `treasury` pays SOL and `FSPL`; one voter approves, the console is photographed at 1 of 2, a second approves and the engine executes. A second Proposal gets one approval and is left to time out |
| 12 | Safe multisig | `treasury` pays ETH and `FLOW`; the engine proposes as the delegate, one owner confirms through the service, the console is photographed at 1 of 2, a second confirms and the engine executes |
| 13 | Held, released, cancelled | A scoped `item_over` rule holds two payments; one is released, one cancelled, the rule is disabled |
| 10 | Solana expiry and resend | The proxy answers the engine's next `getLatestBlockhash` with one captured at the start of the run, by then expired, so the engine must resubmit |

## Output

- `shots/<row>-<label>-<view>.png`, with `<view>` one of `flow`, `items` or `details`, and a `.txt` beside each with the page's visible text. A Relay Dispatch's Items tab shows its one transaction; against an engine too old to read the signed bytes it has no Items tab, and its `items` shot shows the Flow tab.
- `shots/<row>-<page>.png` for whole pages: Overview, Activity, Dispatches, Rejected and Assets for row 3; Contracts for row 4; each Proposal at 0 and 1 of 2 approvals for rows 11 and 12, and Senders for row 11; the Held page and the held Dispatch while it waits for row 13; Senders for row 14.
- `results-<runId>.json`: each row's outcome (`ran`, `skipped` or `failed`, with the reason), its Dispatch ids, end states and notes, and every wallet's balance before and after, which is what the run spent.

## Files

- `config.ts` holds the paths, keys and RPC URLs.
- `prepare.ts` and `contracts.ts` create the test assets.
- `multisig.ts` creates the Squads multisig and the Safe, and confirms Safe transactions as an owner.
- `rpc-proxy.ts` passes JSON-RPC through and rewrites the two answers rows 9 and 10 need.
- `local-engine.ts` starts and stops the throwaway engine.
- `engine-api.ts` is the small `/v1` client.
- `flows.ts` is the table of flows.
- `console-shots.ts` drives headless Chrome over the DevTools protocol.
- `run.ts` runs the flows and writes the results.
