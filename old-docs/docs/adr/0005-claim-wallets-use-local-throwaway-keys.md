# Claim wallets use local throwaway keys, not Turnkey

The stated engineering principle is that the execution engine never holds raw private keys (see the BYOS / Signing Provider model) — everything is signed via Turnkey. Taken literally, that would mean provisioning each fake-claim wallet (one per phone-number Payment) through Turnkey too.

Decided against that for the fake Claim Provider specifically: each claim wallet's keypair is generated and held locally by the engine, not provisioned through Turnkey. There is no real claim/export flow yet for a recipient to use that key — the wallet only exists as a transfer destination for the demo — so routing it through Turnkey would be ceremony with no security benefit. This is a deliberate, scoped exception to the BYOS principle for throwaway demo-value wallets, not a reversal of it: the Signing Provider abstraction still governs every wallet the engine sends *from* (the EVM sender, the Solana sender). It stops applying only to the disposable *destination* wallets created for fake claims.

Consequence: when real TipLink integration replaces the fake Claim Provider, this exception goes away — TipLink (or a real signer) owns claim-wallet custody, not the engine.
