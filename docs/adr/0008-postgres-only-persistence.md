# Postgres is the only supported persistence backend

The engine's core correctness guarantee — an atomic, DB-owned nonce counter (`UPDATE ... RETURNING`) that never re-derives a nonce from a live RPC read under concurrency — depends on real transactional guarantees. A zero-config embedded database (e.g. SQLite) was considered to lower "fork and run" friction, but re-validating the same concurrency-safety story on a second database backend is real, avoidable scope. Onboarding friction is solved instead with a one-command `docker-compose up`, not by swapping databases.
