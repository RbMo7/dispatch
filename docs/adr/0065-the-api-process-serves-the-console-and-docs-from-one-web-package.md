# The API process serves the console and docs, from one web package with two builds

Accepted 2026-11-01. Spec: `.scratch/web-console/spec.md` and `design.md`.

The operator console, the docs site and the public landing page share one look, one set of components and one docs renderer. The console needs the engine's `/v1` routes and a bearer token. The landing page describes the project; it is not part of anyone's engine.

## Decision

- **One package, `web/`** (Vite, React, TypeScript), a sibling of `signer/` and `verifier/`, with two builds. The engine build (`web/dist/engine`) holds `/console/*` and `/docs`. The public build holds the landing page at `/` and `/docs`, for static hosting.
- **The API process serves the engine build** (`src/web-static.ts`) on the same origin as `/v1`, and redirects `/` to `/console`. The engine's Docker image builds it.
- **A self-hosted engine never serves the landing page.**
- **Without a build on disk, the API registers no web routes** and is the API alone. The `console` setup check warns (ADR-0067).
- **The console uses only documented `/v1` routes.** It has no private API, so any client can read what it reads (ADR-0066).

## Considered options

- **A console deployed on its own.** Rejected: a second service to host and secure, CORS, and a bearer token sent across origins, for an engine that usually has one operator.
- **Separate packages for the console, the docs and the landing page.** Rejected: they share tokens, components and the renderer, so three packages would copy them or need a fourth shared one.
- **The engine serves the landing page too.** Rejected: an operator's engine would show the project's marketing page at its root.

## Consequences

- A console change ships with an engine release, and the API process serves static files.
- `web/` has its own dependencies and tests, outside the engine's dependency tree.
- The console never talks to the Signer: everything it shows comes through the API (ADR-0059).
