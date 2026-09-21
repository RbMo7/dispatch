# Any behavior that can spend more money than authorized defaults off

Retry Policy (fee-bump replacement of a stuck transaction) defaults to **off**, even though enabling it by default would improve delivery reliability. This project's target user is explicitly someone new to this space — it's acceptable, even instructive, for a newcomer to see a batch of requests visibly fail and go discover the fee-bump feature themselves; it is not acceptable for the engine to silently spend more of their money than they asked for as a default behavior. This reverses this project's own earlier draft recommendation (default on, with a capped ceiling).

## Consequences

Because Retry Policy defaults off, a stuck EVM transaction has no automatic resolution path by default — see ADR-0004 for how that's surfaced without producing a false-confidence "it failed" signal. This is a general design principle for this project, not limited to fee-bumping: any future "should X be on by default" question involving cost should default to the cheaper/safer option and require explicit opt-in for the costlier, more-automated one.
