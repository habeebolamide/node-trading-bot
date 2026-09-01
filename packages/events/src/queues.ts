/**
 * Queue topology (§11) and the fast-lane priority split (§11 "Fast-path priority
 * lane"). The reaction path (detection → paper fill → telegram) must not wait
 * behind heavy analysis/Brain/attribution jobs, so it rides a higher BullMQ
 * priority. In BullMQ a LOWER priority number is served FIRST.
 */
export const QUEUE_NAMES = {
  BLOCKCHAIN_INGESTION: 'blockchain-ingestion',
  MARKET_INGESTION: 'market-ingestion',
  WALLET_ANALYSIS: 'wallet-analysis',
  TOKEN_ANALYSIS: 'token-analysis',
  SIGNAL_PROCESSING: 'signal-processing',
  AGENT_ANALYSIS: 'agent-analysis',
  BRAIN_PROCESSING: 'brain-processing',
  PREDICTION_EVALUATION: 'prediction-evaluation',
  PAPER_PORTFOLIO: 'paper-portfolio',
  ANALYTICS: 'analytics',
} as const;

export type QueueName = (typeof QUEUE_NAMES)[keyof typeof QUEUE_NAMES];

export const ALL_QUEUE_NAMES: readonly QueueName[] = Object.values(QUEUE_NAMES);

/**
 * BullMQ job priorities. FAST = the §11 reaction lane, served ahead of NORMAL.
 * Lower number = higher priority in BullMQ.
 */
export const PRIORITY = {
  FAST: 1,
  NORMAL: 50,
} as const;

export type Priority = (typeof PRIORITY)[keyof typeof PRIORITY];
