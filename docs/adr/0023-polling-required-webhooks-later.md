# Polling is the required baseline; webhooks are a later, opt-in addition

`GET /v1/dispatch/:id` (status polling) ships with the first working version. Webhooks are real, separate scope — delivery retries, signing the payload, an endpoint-registration story — and are deliberately not part of the first milestone, so they don't block Solana's Managed Dispatch path from shipping.
