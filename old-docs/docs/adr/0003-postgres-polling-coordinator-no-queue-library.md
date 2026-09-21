# Execution Coordinator polls Postgres directly, no queue library

Considered BullMQ or pg-boss for dispatching queued Payments to workers, which is the default reach for background job processing in Node.

Decided against a queue library. The Execution Coordinator and Chain Executors instead run as a plain polling loop over Postgres (`SELECT ... WHERE status = 'QUEUED' FOR UPDATE SKIP LOCKED` on an interval). This avoids standing up Redis (BullMQ's dependency) for a 72-hour build, and keeps "Postgres is the source of truth" literally true — the payments table *is* the queue, with no second system that could disagree with it about what's pending.

Consequence: no built-in job scheduling, delayed jobs, or dashboard that a queue library would provide — acceptable since retry is manual (see the grilling session) and there's a single demo-scale workload, not a production job volume.
