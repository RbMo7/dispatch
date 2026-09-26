# Issue tracker: GitHub Issues (spec stays local)

Specs for this repo live as markdown files in `.scratch/`. Implementation tickets are tracked as GitHub Issues on this repo (`RbMo7/dispatch`) — not as local files.

## Conventions

- One feature per directory: `.scratch/<feature-slug>/`
- The spec is `.scratch/<feature-slug>/spec.md` — this stays local, it's the feature-level design record
- Implementation tickets are GitHub Issues, one per ticket, opened in dependency order (blockers first) so each can reference its blockers by real issue number
- Each ticket's body follows: `## Parent` (a reference to the feature's `spec.md`), `## What to build`, `## Acceptance criteria`, `## Blocked by`
- Triage state is the issue's label (see `triage-labels.md` for the role strings) — apply `ready-for-agent` on publish unless instructed otherwise
- Comments and status changes happen as ordinary GitHub issue comments/labels, not a `## Comments` heading appended to a file

## When a skill says "publish to the issue tracker"

Open a new GitHub Issue on this repo (`gh issue create`), after creating the feature's `.scratch/<feature-slug>/spec.md` first if it doesn't exist yet, so the issue's `## Parent` section has something to link to.

## When a skill says "fetch the relevant ticket"

Fetch the referenced GitHub Issue (`gh issue view <number>`). The user will normally pass the issue number or URL directly.

## History

`core-engine-scaffold`, `solana-chain-handler`, `relay-dispatch`, and `base-chain-handler`'s first 14 tickets were opened before this convention and keep their local `.scratch/<feature-slug>/issues/*.md` files as a frozen historical record — not updated further, not migrated to GitHub. Every ticket from here on uses GitHub Issues.

## Wayfinding operations

Used by `/wayfinder`. Unaffected by the switch above — this is a separate claim/resolve research-question flow, not the ticket-execution tracker. The **map** is a file with one **child** file per ticket.

- **Map**: `.scratch/<effort>/map.md` (the Notes / Decisions-so-far / Fog body).
- **Child ticket**: `.scratch/<effort>/issues/NN-<slug>.md`, numbered from `01`, with the question in the body. A `Type:` line records the ticket type (`research`/`prototype`/`grilling`/`task`); a `Status:` line records `claimed`/`resolved`.
- **Blocking**: a `Blocked by: NN, NN` line near the top. A ticket is unblocked when every file it lists is `resolved`.
- **Frontier**: scan `.scratch/<effort>/issues/` for files that are open, unblocked, and unclaimed; first by number wins.
- **Claim**: set `Status: claimed` and save before any work.
- **Resolve**: append the answer under an `## Answer` heading, set `Status: resolved`, then append a context pointer (gist + link) to the map's Decisions-so-far in `map.md`.
