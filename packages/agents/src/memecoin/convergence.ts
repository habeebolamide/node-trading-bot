/**
 * Memecoin Convergence Agent (§40.8). EVENT trigger on `memecoin.wallet.convergence.detected`
 * (emitted by m3-convergence). The heavy math already ran in the M3 emitter (funder-cluster
 * dedup, per-cluster quality, time compression) — this agent packages the result as an
 * `{score, confidence, features}` output for the composite.
 *
 * Weight 20% of the memecoin composite (§Part II §9). Long-only. Confidence scales with
 * independent-cluster count + time compression (tighter = higher).
 */
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

const KEY = 'memecoin.convergence';
const VERSION = 1;

interface Payload {
  mint: string;
  batchOpenedAt: string;
  batchClosedAt: string;
  batchingWindowMs: number;
  buys: Array<{ wallet: string; walletScore: number; amountSol: string; signature: string }>;
  convergenceScore: number; // sum-of-clusters × timeCompression (§40.8 formula)
  independentClusterCount: number;
  timeCompression: number;
  perCluster: Array<{ clusterId: string; wallets: string[]; clusterQuality: number; independenceWeight: number }>;
}

export const memecoinConvergenceAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'EVENT',
  canHandle(event) {
    return event.type === EVENT_NAMES.MEMECOIN_WALLET_CONVERGENCE_DETECTED;
  },
  async analyze(event: DomainEvent, _ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as Payload;
    if (!p || typeof p.convergenceScore !== 'number') return null;

    // Normalize the raw convergence score to [0, 1]. The emitter's score is Σ (clusterQuality[0..100]
    // × independenceWeight) × timeCompression, so with a cap of ~100 per cluster and typical
    // aggregation of 1-5 clusters, /200 saturates gracefully for MVP.
    const score = Math.max(0, Math.min(1, p.convergenceScore / 200));

    // Confidence: single cluster ≈ 0.3 (thin), scales with independent count and time compression
    // (§40.8: "single cluster → confidence ~0.3; five independent clusters in 2s → ~0.95").
    const countBonus = Math.min(1, p.independentClusterCount / 5);
    const confidence = Math.max(0.3, 0.3 + 0.4 * countBonus + 0.3 * p.timeCompression);

    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: 'LONG',
      score,
      confidence: Math.min(1, confidence),
      features: {
        mint: p.mint,
        convergenceScore: p.convergenceScore,
        independentClusterCount: p.independentClusterCount,
        timeCompression: p.timeCompression,
        buyCount: p.buys?.length ?? 0,
        clusters: p.perCluster?.length ?? 0,
      },
    };
  },
};
