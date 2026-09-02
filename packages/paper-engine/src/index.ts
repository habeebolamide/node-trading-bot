/**
 * @tip/paper-engine — the answer to "what would have happened if we took it?"
 *
 * Domain-split fill model (§20): perp flat bps, memecoin depth-aware AMM against actual
 * reserves — or NO FILL. Never a last-price fallback (rule 25). The five-condition exit
 * precedence (Part II §10) closes positions honestly, with detection-lag pricing on
 * webhook-driven closes (§20).
 *
 * NO REAL-MONEY EXECUTION PATHS EXIST HERE. Rule 20 is absolute for MVP.
 */
export * from './exit.js';
export * from './fills/memecoin.js';
export * from './fills/perp.js';
export * from './portfolio.js';
export * from './position.js';
export * from './types.js';
