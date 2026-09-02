/**
 * @tip/predictions — the immutable record of "we said this would happen." §19, rule 10.
 *
 * INSERT-only, enforced by a Postgres trigger in migration 0012. The module exposes only
 * `createPrediction`, `getPrediction`, `listPredictions`, and `recordNoTrade` — there is no
 * update or delete function. If a caller wants to change a prediction, they are modelling
 * something wrong (rule 10 verbatim).
 */
export * from './create.js';
export * from './read.js';
export * from './no-trade.js';
export * from './types.js';
export * from './shadow.js';
