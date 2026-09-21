Status: blocked-by-core-scaffold

# Account resolution

Solana account details, handled once, as their own piece of infrastructure everything else depends on: deriving a recipient's Associated Token Account (ATA) address for a given mint, checking whether it already exists, and the idempotent-create-if-missing pattern (an ATA-creation instruction costs nothing extra if the account already exists, so it's always safe to include rather than doing a separate existence check per recipient first). This is pure derivation/lookup logic — no transfer instructions, no signing, no broadcast.

Every later issue that builds a transfer (02, 03) calls into this rather than deriving/checking ATAs itself.
