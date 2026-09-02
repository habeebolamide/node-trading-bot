/**
 * Judge evidence assembly (§18, §40.14). The Judge sees ONLY what the deterministic pipeline
 * saw, in structured form. NO raw OHLCV / orderbook / funding rates in the prompt (§33 rule 14
 * — the LLM cannot invent market facts, so it reasons only over facts we hand it as summaries).
 * Bounded and structured input means a thesis mentioning a specific price level not in the
 * evidence is hallucination the caller can safely ignore.
 */
import { and, eq } from 'drizzle-orm';
import { signal, signalFeature, signalRisk, type Db } from '@tip/database';
import { createBrain, type Domain, type FeatureTuple } from '@tip/brain';
import { featureTupleFor } from '@tip/evaluation';

export interface JudgeAgentSummary {
  readonly key: string;
  readonly agentVersion: number;
  readonly score: number;
  readonly confidence: number;
}

export interface JudgeEvidence {
  readonly symbol: string;
  readonly domain: Domain;
  readonly deterministic: { direction: string; compositeScore: number; confidence: number };
  readonly agents: readonly JudgeAgentSummary[];
  readonly historicalEdge: {
    readonly evidence: 'SUFFICIENT' | 'INSUFFICIENT';
    readonly winRate: number | null;
    readonly wilsonWidth: number | null;
    readonly backoffDepth: number;
  };
  readonly risk: { level: string; flags: readonly string[] };
}

/**
 * Build the evidence a Judge call sees for `signalId`. Reads signal + signal_feature +
 * signal_risk + brain.historicalEdge. Pure output; the caller passes it through `callWithLog`.
 *
 * Fails soft on missing pieces (a signal without a risk row shouldn't stop the Judge from
 * running — the deterministic engine already made its call). Returns null only when the signal
 * itself is missing, which is a caller bug.
 */
export async function buildJudgeEvidence(db: Db, signalId: string): Promise<JudgeEvidence | null> {
  const s = (await db.select().from(signal).where(eq(signal.id, signalId)).limit(1))[0];
  if (!s) return null;
  const domain = s.domain as Domain;

  const featureRows = await db.select().from(signalFeature).where(eq(signalFeature.signalId, signalId));
  const agents: JudgeAgentSummary[] = featureRows.map((r) => ({
    key: r.agentKey, agentVersion: r.agentVersion,
    score: Number(r.score), confidence: Number(r.confidence),
  }));

  const riskRow = (await db.select().from(signalRisk).where(and(eq(signalRisk.signalId, signalId))).limit(1))[0];
  const risk = { level: riskRow?.riskLevel ?? 'LOW', flags: (riskRow?.riskFlags ?? []) as readonly string[] };

  // Historical edge from the shared per-domain Brain — read at signal creation time (rule 21:
  // the Judge is scoring the signal, so the same asOf applies).
  const brain = createBrain(db, domain);
  const features = await featureTupleFor(db, signalId, domain) as FeatureTuple;
  const edge = await brain.setup(features, s.createdAt);
  const historicalEdge = {
    evidence: edge.evidence, winRate: edge.observedWinRate, wilsonWidth: edge.ciWidth, backoffDepth: edge.backoffDepth,
  };

  return {
    symbol: s.symbol, domain,
    deterministic: { direction: s.direction, compositeScore: Number(s.compositeScore), confidence: Number(s.confidence) },
    agents, historicalEdge, risk,
  };
}
