export * from './identity.js';
export * from './config.js';
export * from './store.js';
export * from './agent-interface.js';

// Signal engine (m4-signal-engine)
export * from './scoring.js';
export * from './confidence.js';
export * from './fingerprint.js';
export * from './feature-aggregator.js';
export {
  createSignal,
  transitionSignal,
  type CreateSignalInput,
  type CreateSignalResult,
} from './signal-store.js';
export { canTransition, assertTransition, type SignalState } from './signal-lifecycle.js';
export * from './signal-engine.js';
export * from './agent-lifecycle.js';
export * from './feed-block.js';
