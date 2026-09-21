# A single configured bearer token secures the API — no per-tenant key management

There is no Tenant concept in this project (that was SaaS-specific scaffolding, dropped along with the rest of the old repo's multi-tenancy). `POST /v1/dispatch` and `GET /v1/dispatch/:id` are protected by one operator-configured shared secret, checked as a plain bearer token on every request — not a multi-tenant key-issuance/rotation system, since there's no tenant to issue keys to.

## Consequences

An operator wanting IP allowlisting, mTLS, or multiple distinct credentials layers that at their own reverse-proxy/infra level; the engine itself only ever needs the one shared-secret check.
