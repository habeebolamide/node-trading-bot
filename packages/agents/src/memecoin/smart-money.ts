/**
 * Memecoin Smart Money Agent (§40.7). EVENT trigger on `memecoin.wallet.buy.detected`. Scores
 * the buy by the historical quality of the buying wallet(s) — using the point-in-time score
 * (§4 rule 21). Long-only (memecoin is spot; §18 memecoin note).
 *
 * MVP: single-buy events already carry the `walletScore` in the payload (m3-watchlist BuyDetector
 * looked it up at blockTime), so this agent just normalizes vs the universe. When multiple buys
 * land in one batching window, the M3 convergence layer aggregates first — this agent runs per
 * raw buy and the aggregator dedups upstream. Direction is always LONG or NEUTRAL.
 */
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

const KEY = 'memecoin.smart_money';
const VERSION = 1;

/** MVP normalization: universe percentile stub — treat 0..100 wallet score as ~normalized 0..1. */
function normalize(walletScore: number): number {
  return Math.max(0, Math.min(1, walletScore / 100));
}

/**
 * Confidence proxy for a single-buy event: bigger notional and higher wallet score → more
 * confident. Kept simple — the aggregator + Convergence Agent (§40.8) handle multi-wallet
 * cases; this agent's job is the per-buy signal.
 */
function confidence(walletScore: number, amountSol: number): number {
  const sizeContribution = Math.min(1, amountSol / 5); // 5+ SOL saturates
  const scoreContribution = normalize(walletScore);
  return 0.5 * sizeContribution + 0.5 * scoreContribution;
}

interface Payload {
  wallet: string;
  walletScore: number;
  mint: string;
  amountSol: string;
  tokenAmount: string;
  blockTime: string;
  signature: string;
}

export const memecoinSmartMoneyAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'EVENT',
  canHandle(event) {
    return event.type === EVENT_NAMES.MEMECOIN_WALLET_BUY_DETECTED;
  },
  async analyze(event: DomainEvent, _ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as Payload;
    if (typeof p.walletScore !== 'number' || p.walletScore <= 0) return null; // unrated at T
    const score = normalize(p.walletScore);
    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: 'LONG',
      score,
      confidence: confidence(p.walletScore, Number(p.amountSol)),
      features: {
        wallet: p.wallet,
        walletScore: p.walletScore,
        mint: p.mint,
        amountSol: p.amountSol,
        signature: p.signature,
      },
    };
  },
};
