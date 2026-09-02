/**
 * `@tip/brain` — the shared per-domain Brain (§15): one Memecoin Brain, one Perp Brain, NOT one
 * per TradingAgent. Wallet score, token score and setup-outcome history are facts about the
 * market, not opinions belonging to any one agent.
 *
 * Dependency direction is deliberate: this package depends on `@tip/database` and `@tip/domain`
 * and NOT on `@tip/agents` / `@tip/trading-agents`. Agents read the Brain; the Brain never
 * reads an agent.
 */
export * from './stats.js';
export * from './fingerprint.js';
export * from './setup-memory.js';
export * from './backoff.js';
export * from './historical-edge.js';
export * from './wallet-memory.js';
export * from './token-memory.js';
export * from './market-memory.js';
export * from './brain.js';
