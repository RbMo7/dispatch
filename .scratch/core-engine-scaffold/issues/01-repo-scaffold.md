Status: ready-for-agent

# Repo scaffold

Set up the base project: `package.json`, TypeScript config, lint/format config, a minimal Fastify app entrypoint (`src/index.ts`) and a separate worker entrypoint (`src/worker.ts`, per ADR-0009 — API and worker are separate processes sharing the DB), Postgres via `docker-compose.yml`, and Drizzle migration tooling. `docker-compose.yml` should bring up: Postgres, the engine's API process, the engine's worker process, and a placeholder service for the reference Signer (built out in issue 04) — so `docker-compose up` is the whole local dev story from day one, per ADR-0002's stated mitigation for the two-process cost.

No business logic yet — this is scaffolding only. A `GET /health` route on the API is enough to prove the Fastify app boots.
