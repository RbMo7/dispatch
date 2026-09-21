Status: ready-for-agent

# Coordinator

Build the orchestration core (ADR-0009): claims queued Managed Dispatch work via the repository (issue 03), calls the registered Chain Handler for that Payment's Chain (issue 05 — still a stub at this point), and drives Retry Policy (defaulting off, per-request/global-default configurable, ADR-0003) and the chain-aware `ABANDONED`-timeout decision (ADR-0004) on the result. Holds no chain-specific knowledge at all — everything chain-specific stays behind the Chain Handler interface.

Test entirely against the fake repository (issue 03) and the trivial stub Chain Handler (issue 05) — no real database, no real chain, no network calls. This proves the orchestration logic (the hardest, most valuable part of the whole engine) works correctly in complete isolation before any real chain is plugged in.
