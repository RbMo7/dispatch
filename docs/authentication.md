# Authentication

Every `/v1` route needs the engine's API token, sent as a bearer token. There is one token per engine, set by the operator in `AUTH_TOKEN`. It has no users, scopes or expiry, so treat it like a database password.

## Send the token

Put the token in the `Authorization` header of every request:

```sh
curl -s "$DISPATCH_URL/v1/senders" -H "Authorization: Bearer $DISPATCH_TOKEN"
```

`GET /health` and the docs at `/docs` need no token. The web console signs in with the same token and sends it on every request it makes.

## A wrong or missing token

The API checks the token before it reads anything else in the request, so a request with a wrong token gets `401` even when its body is invalid:

```sh
curl -s "$DISPATCH_URL/v1/senders" -H "Authorization: Bearer wrong-token"
```

```json
{ "error": "unauthorized" }
```

The header must be exactly `Bearer `, one space, then the token.

## The operator token

The operator can set a second token, `OPERATOR_TOKEN`. It does everything `AUTH_TOKEN` does, and it is the only token the operator-only routes accept:

- [Release a held Dispatch](./openapi.yaml#release-a-held-dispatch).
- Create, edit, delete and preview [Flag Rules](./guides/flag-rules.md).
- Preview, add, disable and enable Known Assets (`POST /v1/assets`). Either token can list them.
- [List operator actions](./openapi.yaml#list-operator-actions), the activity record.

`AUTH_TOKEN` gets `403` on those routes, so a client that holds only the API token cannot release its own Dispatch:

```json
{ "error": "this route needs OPERATOR_TOKEN, not AUTH_TOKEN" }
```

When `OPERATOR_TOKEN` is unset, the operator-only routes answer `403` to everyone, and everything else works as before. The engine refuses to start when `OPERATOR_TOKEN` is set but empty, or equal to `AUTH_TOKEN`.

Both tokens are shared secrets, not identities. The activity record says which token acted, never which person. Give the operator token only to the people who approve held payments and set the rules.

## Choose and rotate the token

The engine starts with `AUTH_TOKEN=dev-secret` if you set nothing. Always set your own. Generate a long random one:

```sh
openssl rand -hex 32
```

To rotate it, set the new value in `AUTH_TOKEN` and restart the API. Requests with the old token get `401` from then on, and the console returns to its sign-in page and says so.

Anyone who holds the token can submit and cancel Dispatches. Keep it on your servers, never in a browser bundle or a mobile app, and serve the API and the console over TLS to the people who may hold it.

## The Signer token is a different token

The worker and the Signer share a second token, `SIGNER_AUTH_TOKEN`, so that only the worker can ask for a signature. Your application never sends it, and the API never uses it. [Set up a Signer](./self-hosting/signer.md#5-create-the-bearer-token) explains it.
