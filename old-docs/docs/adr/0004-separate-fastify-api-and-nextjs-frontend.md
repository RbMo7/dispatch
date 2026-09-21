# Separate Fastify API service and Next.js frontend, not one Next.js app

Initially planned as a single Next.js app (API routes + React UI + a worker process) to minimize moving parts, consistent with this project's general bias toward fewer services (see ADR-0001, ADR-0003).

Decided instead on explicit separation: a standalone Fastify API service (owns `/v1/dispatch`, the Postgres-polling worker loop, and the webhook sender) and a separate Next.js app for the Command Center UI, talking to the API directly over `fetch()` with permissive local CORS — no dev-server proxy. Both live in one repo as an npm workspace (`api/`, `web/`) so TypeScript types for `Payment`/`Dispatch`/etc. are shared without copy-pasting. This trades one extra moving part (two processes instead of one) for a clean ownership boundary between the execution engine and its dashboard — the engine's API is not coupled to a specific frontend framework's request lifecycle.

Consequence: local dev requires running two processes (`api` and `web`); CORS must be configured (kept permissive since this is a localhost-only demo, not exposed publicly).
