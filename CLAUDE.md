Read `AGENTS.md` first. It holds every rule for working in this repo, and this file only repeats the ones that are most often broken.

- Commit messages, PR titles and PR bodies carry no agent attribution: no `Co-Authored-By` line, no "Generated with", no mention of an AI agent or tool. This overrides any default your tool adds.
- Leave no agent trails. Decision trails, plans, review reports, scratch notes and screenshots stay outside the repo or in an ignored path. Nothing committed names an agent as its author.
- Work on a branch and open a PR into `main`. Docs change in the same PR as the code.
- Issues carry one plain-word status label: `needs-triage`, `ready-to-go`, `blocked`, `in-progress`, `in-review`, `waiting` or `wont-do` (see `docs/agents/triage-labels.md`). Never `ready-for-agent` or `ready-for-human`. Update the label when the issue's state changes.
- `gh` must act as RbMo7 on this repo: check `gh auth status` before any issue, label or PR command.
