# Attempt and Transaction are separate entities

Considered collapsing "Attempt" into "Transaction" for simplicity — modeling a retry as just creating a fresh Transaction row every time.

Decided to keep them separate. Resubmitting a Transaction's exact signed bytes (e.g. after an RPC timeout with no chain state change) creates a new Attempt against the same Transaction and hash. Changing the signed bytes (an EVM gas-bump replacement, a Solana blockhash refresh) creates a new Transaction under the same Execution Plan instead, with the prior Transaction marked superseded. This preserves the real distinction between "we resent the same envelope" and "we sent a different envelope" — which matters for reconciliation, since a nominally "replaced" Transaction can still land on-chain after the fact.

Consequence: the schema needs an `attempts` record (table or embedded list) under Transaction, and a `superseded_by` pointer from an old Transaction to its replacement within the same Execution Plan.
