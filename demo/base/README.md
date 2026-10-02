# Base Sepolia demos

Three end-to-end runs through the engine's real HTTP API (`POST`/`GET /v1/dispatch`) against real Base Sepolia. Each one boots the engine in-process (API, Coordinator and a Signer; an in-memory store instead of Postgres), submits one Managed Dispatch, polls it to a terminal state, then checks the result on-chain rather than trusting the engine's own status.

| Script | What it dispatches |
|---|---|
| `native-transfer.ts` | Native ETH from the Sender to 5 fresh wallets |
| `token-transfer.ts` | Deploys `DemoToken` (ERC-20), registers it as a known token, pays 5 fresh wallets |
| `contract-calls.ts` | Deploys `Runner` (public `run(n)` calling internal `_run`), then 15 raw `call` items: 15 transactions on consecutive nonces |

Contracts are compiled with `solc` and deployed directly from the Sender before the engine starts. Deployment is setup, not a dispatch.

## Running

From the repo root:

```sh
pnpm tsx demo/base/native-transfer.ts
pnpm tsx demo/base/token-transfer.ts
pnpm tsx demo/base/contract-calls.ts
```

- Sends from the `dev-sender` key in `signer/keys.dev.json`, the same funded wallet the live tests use. It needs Base Sepolia ETH.
- `BASE_SEPOLIA_RPC_URL` in `.env` sets the RPC. `https://sepolia.base.org` is the fallback, and it rate-limits.
- Don't run a demo while `pnpm test` is running. Both would own the Sender's nonce.
