# Live flow coverage

A repeatable run that drives each kind of Dispatch through a real engine on Solana devnet and Base Sepolia, and saves console screenshots of every Dispatch's Flow, Items and Details. It covers the rows of the Live flow coverage table in `.scratch/flow-coverage/spec.md` that today's engine supports: 1 to 10, 13 and 14. Rows 11 and 12 (Squads and Safe) are not in it yet.

It spends testnet funds. Run it by hand, never in CI.

## What it needs

- Postgres, for the scratch database `local-engine.ts` creates and drops. It connects to `FLOWS_PG_ADMIN_URL`, by default `postgres://dispatch:dispatch@localhost:5433/postgres`, and never touches the `dispatch` database.
- A funded devnet wallet, by default `.devnet-fixtures/sender-keypair.json` (`FLOWS_SOLANA_KEYPAIR` to change it), and the committed Base dev key in `signer/keys.dev.json`, funded on Base Sepolia.
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

`up` first runs `prepare.ts`, which creates the test assets once and caches their addresses in `assets.json`: an SPL mint and a Token-2022 mint on devnet, and on Base Sepolia an ERC-20 (`FlowToken`), a payable contract (`FlowVault`) and an owner-only Multicall3-style aggregator (`FlowAggregator`) funded with the ERC-20. The engine gets them as `SOLANA_KNOWN_TOKENS` (`FSPL`, `F22`) and `BASE_KNOWN_TOKENS` (`FLOW`). Each chain has two Senders, `payouts` (the funded keys, the default) and `refunds` (a key the run makes and funds through the engine).

For someone watching the console while it runs, `FLOWS_PACE_MS=20000` leaves each row's end state, and the held Dispatch in row 13, on screen for 20 seconds, and `FLOWS_LIVE_LOG=<file>` appends a line for each row and each Dispatch submitted, with its id.

To run against another engine, skip `local-engine.ts` and set `FLOWS_ENGINE_URL`, `FLOWS_AUTH_TOKEN` and `FLOWS_OPERATOR_TOKEN`. That engine must know the same assets and Senders. Rows 9 and 10 also need its RPCs to go through `rpc-proxy.ts` (`FLOWS_PROXY_URL`); without it they are recorded as skipped.

## What each row does

| Row | Flow | How |
| --- | --- | --- |
| 14 | Named Senders | `payouts` funds `refunds` and the two relay wallets; later `refunds` pays on each chain |
| 1 | SPL and Token-2022 payments | One Dispatch, one item in each test mint |
| 2 | ERC-20 payment | `FLOW` on Base |
| 3 | Unconfigured asset | A `USDT` payment, refused with `UNKNOWN_ASSET`; the run records that nothing appears in the list or the activity record |
| 4 | Base call with value | `FlowVault.deposit(note)` with 0.000001 ETH |
| 5 | Solana program call | A Memo and a raw SPL `transferChecked`, both as `call` items |
| 6 | Relay | A transfer signed by a relay wallet on each chain |
| 7 | Bulk Call | An ERC-20 and an ETH payment through `FlowAggregator`, `allowFailure: false` |
| 8 | Partial | An ETH payment plus a call to `FlowVault.revertAlways()` |
| 9 | Fee bump | The proxy reports a quarter of the real base fee for 20 seconds, so the first transaction is underpriced; `retryPolicy: true` and `BASE_STUCK_AFTER_MS=30000` make the engine bump it |
| 13 | Held, released, cancelled | A scoped `item_over` rule holds two payments; one is released, one cancelled, the rule is disabled |
| 10 | Solana expiry and resend | The proxy answers the engine's next `getLatestBlockhash` with one captured at the start of the run, by then expired, so the engine must resubmit |

## Output

- `shots/<row>-<label>-<view>.png`, with `<view>` one of `flow`, `items` or `details`, and a `.txt` beside each with the page's visible text. A Relay Dispatch has no Items tab, so its `items` shot shows the Flow tab.
- `shots/<row>-<page>.png` for whole pages: Overview, Activity and Dispatches for row 3; the Held page and the held Dispatch while it waits for row 13; Senders for row 14.
- `results-<runId>.json`: each row's outcome (`ran`, `skipped` or `failed`, with the reason), its Dispatch ids, end states and notes, and every wallet's balance before and after, which is what the run spent.

## Files

- `config.ts` holds the paths, keys and RPC URLs.
- `prepare.ts` and `contracts.ts` create the test assets.
- `rpc-proxy.ts` passes JSON-RPC through and rewrites the two answers rows 9 and 10 need.
- `local-engine.ts` starts and stops the throwaway engine.
- `engine-api.ts` is the small `/v1` client.
- `flows.ts` is the table of flows.
- `console-shots.ts` drives headless Chrome over the DevTools protocol.
- `run.ts` runs the flows and writes the results.
