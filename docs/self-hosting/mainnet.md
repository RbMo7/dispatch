# Going to mainnet

This list covers the Signer, the engine, and a Multisig Sender if you use one. The guides behind it are [Set up a Signer](./signer.md) and [Set up a multisig Sender](./multisig.md), with its sections on [Squads on Solana](./multisig.md#squads-on-solana) and [Safe on Base](./multisig.md#safe-on-base).

Nothing in this repository has run on mainnet yet. The smoke test near the end of the list is the first time it will.

## The list

Clear every item before the first mainnet transaction.

- [ ] No address in the mainnet Signer's config uses the `keyfile` backend, and its startup log has no `WARNING: the keyfile backend` line.
- [ ] If any address uses `local`: the passphrase and the key files are backed up separately, the passphrase comes from a mounted secret file, the keystore directory is `0700`, and every `local` address has a tight policy and holds little.
- [ ] `SIGNER_AUTH_TOKEN` is a fresh random value (`openssl rand -hex 32`), set identically on the worker and the Signer, used in no other environment, and not Compose's `dev-only-signer-token`.
- [ ] Every address has a policy. On Base it has `chainIds: [8453]`. Every address has `allowedDestinations` and caps sized to what one transaction should ever move.
- [ ] Every Privy wallet has an owner (`owner_id` set), `PRIVY_AUTHORIZATION_KEY` is set on the Signer, and the authorization key is a fresh one made for mainnet that has never been pasted into chat, a ticket, or a commit.
- [ ] The KMS path is proven against real KMS. Today it is proven only against mocks (#61). Before mainnet, create a testnet key the same way (same key spec, same IAM policy), and run `RUN_AWS_KMS=1 pnpm test src/signer/aws-kms-e2e.test.ts` against Base Sepolia, and Solana devnet with `AWS_KMS_ED25519_KEY_ID`. The variables are listed in [`.env.example`](../../.env.example). Fix anything it finds before relying on the mainnet key.
- [ ] Each KMS credential can call only `kms:GetPublicKey` and `kms:Sign`, on its own keys.
- [ ] The Signer is reachable only from the worker. Its port is not published to the internet. The API's environment has no `SIGNER_URL` or `SIGNER_AUTH_TOKEN`.
- [ ] The audit log goes somewhere durable, with alerts on `refused`, `failed`, and `rejected` 401 and 404 lines.
- [ ] A small mainnet smoke test has landed first: one small Payment per enabled chain, confirmed on-chain, with a matching `signed` audit line, before any real volume.
- [ ] Every mainnet chain in `ENABLED_CHAINS` stays enabled while it has transactions in flight. Removing a chain with a `PENDING` transaction stops confirmation tracking for every chain until #57 is fixed.
- [ ] If you use a Multisig Sender, the engine's key can never approve. On Solana the member key holds exactly Initiate and Execute (permission mask 5) and never Vote. On Base the executor is not an owner of the Safe and is registered as a delegate. The engine refuses to start otherwise, but check it in the multisig's app yourself.
- [ ] Every multisig key has `allowedMultisig` (Solana) or `allowedSafe` and `chainIds: [8453]` (Base) in its policy, pinned to the one multisig. The engine's startup checks this: it refuses to start if the Signer reports a different pin or none, so confirm the worker's startup log has `checks passed`.
- [ ] A multisig's engine key on `local` is a weaker choice than on `aws-kms` or `privy`: a host compromise exposes it. It can only propose, execute and close, so the policy pin matters most for it.
- [ ] Solana: the multisig's rent collector is the member key's address. Without it, proposal rent is never refunded and the member key drains.
- [ ] Solana: the Squads `ProgramConfig` creation fee and the mainnet rent rate (`getMinimumBalanceForRentExemption`) are read on mainnet before sizing the member key's balance. The spike measured devnet only. The member key must hold the rent of every proposal open at once, plus fees.
- [ ] Base: `BASE_SAFE_API_KEY` is set to a key on a production plan of the Safe Transaction Service, and its monthly quota, read from the Safe developer dashboard, covers about one request a minute for each open proposal. Unauthenticated use (2 requests a second, 5,000 a month) is not enough.
- [ ] Base: the `MultiSendCallOnly` addresses have code on Base mainnet. The spikes ran on Base Sepolia only, and the mainnet check has never been done. A read-only check for each of `0x9641d764fc13c8B624c04430C7356C1C7C8102e2` (Safe 1.4.1), `0xA1dabEF33b3B82c7814B6D82A79e50F4AC44102B` and `0x40A2aCCbd92BCA938b02010E17A5b8929b49130D` (Safe 1.3.0): the result must not be `0x`. Repeat it for each address.

  ```sh
  curl -s https://mainnet.base.org -H 'content-type: application/json' \
    -d '{"jsonrpc":"2.0","id":1,"method":"eth_getCode","params":["0x9641d764fc13c8B624c04430C7356C1C7C8102e2","latest"]}'
  ```

- [ ] The approval deadline (`SOLANA_APPROVAL_DEADLINE_MS`, `BASE_APPROVAL_DEADLINE_MS`, 72 hours by default) is longer than the multisig's time lock plus the time your Approvers take to vote. The engine abandons an approved proposal that is still waiting out its time lock when the deadline passes.
- [ ] The Approvers know to compare each proposal with their own record of the payments, not with the engine's `expected` totals, and have the verifier (`verifier/`) installed and working against your RPC. `expected` is not a control.
- [ ] Your callers treat `APPROVAL_TIMEOUT` as ambiguous and check the multisig before sending again. The engine re-watches a timed-out proposal for 30 days by default, so a late execution is reported only inside that window.
- [ ] Treasury: the hot Sender's working balance is sized to what you accept losing with its key, and its policy caps match.
