# License: MIT

The architecture throughout (self-hosted, bring-your-own-keys, fork-first, a Signer boundary designed so operators can freely swap in their own custody backend) assumes operators embed and extend this freely, including inside their own closed products. MIT was chosen over AGPL-3.0 (OpenZeppelin Relayer's choice, per the earlier competitive-landscape research) specifically because AGPL's copyleft would work against that exact adoption pattern.
