# OpenAPI is the wire contract, and a contract test holds the routes to it

Accepted 2026-11-01. Replaces `docs/api.md` as the place the `/v1` wire format is pinned. Spec: `.scratch/web-console/spec.md`.

`docs/api.md` was written by hand and pinned the wire format, but nothing checked it against the routes. A route change stayed documented only if someone remembered to edit it. The new developer docs needed a full reference with request and response examples for every route.

## Decision

- **`docs/openapi.yaml` is the `/v1` contract** and the only source of the REST reference. `docs/api.md` is gone; older ADRs that name it now mean this file.
- **The docs site renders the reference from it** at build time (`web/scripts/reference.ts`), so the pages cannot disagree with the spec.
- **An offline contract test, `src/api/openapi.contract.test.ts`, drives the real routes** with the real Base and Solana handlers and an in-memory store. It sends every named request example and checks the answer against the schema and status the spec gives. It fails when a documented route is not served, when the API serves a `/v1` route the spec lacks, or when a response has no example.
- **The docs site is for developers.** ADRs and `CONTEXT.md` stay in the repo and off the site, and the docs build refuses a page with an ADR number, an em or en dash, or a filler word. This reverses the web-console spec's plan to make the decisions browsable on the site.

## Considered options

- **Keep a hand-written reference.** Rejected: nothing kept it true.
- **Generate the spec from route code.** Rejected: most request bodies are validated in route code, not Fastify schemas, so a generated spec would miss most of the contract, and the examples and explanations would still be written by hand.

## Consequences

- A new or changed `/v1` route needs its OpenAPI entry and examples in the same change, or CI fails.
- The examples run against the real routes, so they are correct by construction and double as test fixtures.
- CI's offline tier now covers the wire format.
