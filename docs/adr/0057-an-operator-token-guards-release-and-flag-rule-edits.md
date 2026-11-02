# An operator token guards release and Flag Rule edits

Accepted 2026-10-31. Amends ADR-0022.

Flag Rules (ADR-0058) hold a Dispatch until an operator releases it. If the token a client submits with could also release, a buggy or compromised client could release its own held Dispatch, or loosen the rules first, and the hold would catch nothing.

## Decision

- **A second, optional token, `OPERATOR_TOKEN`.** It can do everything `AUTH_TOKEN` can, plus release a Held Dispatch and create, edit or delete Flag Rules. `AUTH_TOKEN` keeps submit, read and cancel, and can do neither of those.
- **The web console signs in with `OPERATOR_TOKEN`** when one is set. With none set, it signs in with `AUTH_TOKEN`, is read-only plus cancel, and hides the Held queue and the rule editor. No Flag Rule can be created, so nothing is ever held.
- **Still plain shared secrets, not identities.** There is no user model; the audit record for an operator action carries a reason, not a name.

## Considered options

- **One token for everything (ADR-0022 unchanged).** Rejected: the hold would protect only against mistakes by a client that is also honest, which is most of the point lost.
- **Per-user operator accounts.** Rejected: a user model, sessions and password handling for a self-hosted engine with typically one operator. An operator who needs names can put the console behind their own SSO proxy (ADR-0022's layering still applies).

## Consequences

- An operator must keep the two tokens apart: `AUTH_TOKEN` in the client's environment, `OPERATOR_TOKEN` only with whoever reviews holds.
- Flag Rules remain a mistake-catcher (ADR-0058): whoever holds `OPERATOR_TOKEN` or the database can still change them. The Signer's policy is the control.
