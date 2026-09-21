Status: ready-for-agent

# Signer client and reference local-keyfile Signer

Implement the engine-side Signer client from ADR-0002/0012: a single concrete function/class that `POST`s `{chain, curve, address, unsignedTxBytes}` to a configured URL and returns `{signature}` — no interface/abstraction layer, per ADR-0012.

Also build the reference local-keyfile Signer itself: a tiny separate service (its own small process, wired into `docker-compose.yml` from issue 01) that reads a key from an env var/file and implements the `/sign` contract for both `secp256k1` and `ed25519`. This is explicitly reference/dev-only — production signing backends are an operator's own concern (ADR-0002) — but it's what makes `docker-compose up` produce a fully working local setup.
