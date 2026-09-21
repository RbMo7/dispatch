# Node.js/TypeScript monolith over Go or a hybrid split

The concept doc left the implementation language open, weighing Node.js/TypeScript against Go and a Node+Go hybrid, and asked for a decision based on delivery speed, SDK maturity, concurrency needs, and operational simplicity.

Decided on a single Node.js/TypeScript service. At this MVP's demo scale (~500 payments, a few hundred on-chain transactions across two chains), nothing needs Go's concurrency primitives — a simple worker loop over Postgres is enough. The TypeScript blockchain SDK ecosystem (viem/ethers, @solana/web3.js, Turnkey SDK) is more mature and faster to integrate against a 72-hour deadline than the Go equivalents. A hybrid split was rejected outright: it would add an inter-service protocol and a second SDK stack to debug, with no payoff at this scale.

The `ChainExecutor` interface is still defined as a clean abstraction specifically so a future Go rewrite of one executor (if concurrency needs ever grow) remains possible without redesigning the Execution Coordinator.
