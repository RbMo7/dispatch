# Issue status labels

Every open issue carries exactly one status label, in plain words. When an issue's state changes, swap its label in the same step (remove the old one, add the new one).

| Label | Meaning | When to set it |
|---|---|---|
| `needs-triage` | Not looked at yet | A new issue whose scope or priority nobody has decided |
| `ready-to-go` | Fully specified, nothing in the way | The spec and acceptance criteria are written and every blocker is closed |
| `blocked` | Waiting on another issue | Its `## Blocked by` list still has an open issue |
| `in-progress` | Being built | Someone (a person or an agent) has started work on a branch |
| `in-review` | A pull request is open | The PR that closes it is open, not yet merged |
| `waiting` | Waiting on a person or outside input | It needs a human check, an answer, credentials or a decision from outside the work |
| `wont-do` | Will not be done | Decided against; close the issue with a comment saying why |

A merged PR closes its issues; a closed issue needs no status label.

Some skills speak in older role names. Map them like this:

| Skill role | Label here |
|---|---|
| `needs-triage` | `needs-triage` |
| `needs-info` | `waiting` |
| `ready-for-agent`, `ready-for-human` | `ready-to-go` (or `blocked` if a blocker is still open) |
| `wontfix` | `wont-do` |
