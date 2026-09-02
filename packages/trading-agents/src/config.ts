/**
 * ScoringConfig schema (§8) — Zod-validated. Domain-specific validation enforces:
 *   - memecoin: maxConcurrentPositions is FIXED at 1 (§32 domain rule)
 *   - perp:     maxConcurrentPositions is FIXED at 1 (operator preference — one coin at a time)
 *   - profit ladder: cumulative sellFraction ≤ 1.0 (Part II §10 write-time check)
 *   - minRR ≥ 0; riskPercent ∈ (0, 1]; leverageMax perp-only
 *
 * The confidenceWeights defaults are Task 6 (0.30 / 0.30 / 0.25 / 0.15). agentWeights + all
 * memecoin-specific fields are optional here — validated presence is domain-checked in Zod
 * refinements below rather than declared upfront (so a perp config isn't forced to carry
 * memecoin fields).
 */
import { z } from 'zod';
import { ValidationError } from '@tip/domain';
import type { Domain } from './identity.js';

const percent01 = z.number().gt(0).lte(1);
const nonNegative = z.number().nonnegative();
const positiveInt = z.number().int().positive();

const ladderRung = z
  .object({
    at: z.number().gt(1),
    sellFraction: z.number().gt(0).lte(1),
    postTakeAction: z
      .union([z.literal('move_stop_to_breakeven'), z.string().startsWith('trail_stop_pct:'), z.null()])
      .default(null),
  })
  .strict();

export const ConfidenceWeightsSchema = z
  .object({
    signalStrength: nonNegative,
    agentAgreement: nonNegative,
    historicalEvidence: nonNegative,
    dataQuality: nonNegative,
  })
  .strict();

export const SignalThresholdsSchema = z
  .object({
    strongLong: z.number(),
    long: z.number(),
    weakLong: z.number(),
    weakShort: z.number().optional(),
    short: z.number().optional(),
    strongShort: z.number().optional(),
  })
  .strict();


/**
 * Override-gate thresholds (§18). Defaults per §18's four-rule table. Versioned like every
 * other scoring input via ScoringConfig — a tightening of the FLIP gate ships as a new
 * scoring_config row, not an in-place edit (rule 16).
 */
export const OverrideGateSchema = z
  .object({
    flipDetConfMax: z.number().gt(0).lte(1),        // §18: FLIP requires detConf < this
    flipGap: z.number().gt(0).lte(1),               // §18: |detConf − llmConf| >= this
    standAsideDetConfMin: z.number().gt(0).lte(1),  // §18: STAND ASIDE requires detConf >= this
    standAsideLlmConfMax: z.number().gt(0).lte(1),  // §18: llmConf < this
  })
  .strict();

/** Full config shape — validated per domain in `validateScoringConfig`. */
export const ScoringConfigInputSchema = z.object({
  riskPercent: percent01,
  minRR: nonNegative,
  maxConcurrentPositions: positiveInt,
  maxCorrelatedExposure: z.number().nonnegative().optional(),
  dailyLossLimit: nonNegative.optional(),
  leverageMax: positiveInt.optional(), // perp only
  agentWeights: z.record(z.string(), z.number().nonnegative()).default({}),
  confidenceWeights: ConfidenceWeightsSchema.default({
    signalStrength: 0.3,
    agentAgreement: 0.3,
    historicalEvidence: 0.25,
    dataQuality: 0.15,
  }),
  signalThresholds: SignalThresholdsSchema,
  overrideGate: OverrideGateSchema.default({
    // §18's worked examples: FLIP@detConf<0.7 gap>=0.2, STAND_ASIDE@detConf>=0.7 llmConf<0.7.
    flipDetConfMax: 0.7,
    flipGap: 0.2,
    standAsideDetConfMin: 0.7,
    standAsideLlmConfMax: 0.7,
  }),
  // Perp LIMIT-order support (m6-limit-orders-perp). Default MARKET preserves every
  // existing agent's behaviour. `limitPullbackAtr` is how far the LIMIT sits from the signal-time
  // close, in ATR units — 0.3 is a modest pullback, tuned to fill often on typical intraday
  // retrace without straying so far the trade rarely triggers.
  // §8 "paper trading balance" (audit-2: the field never existed; balance was hardcoded).
  // Used once, at portfolio creation; changing it later never rewrites an existing portfolio.
  startingBalance: z.number().positive().optional(),
  entryType: z.enum(['MARKET', 'LIMIT']).default('MARKET'),
  limitPullbackAtr: z.number().gt(0).default(0.3),
  // Memecoin-only:
  stopPct: z.number().gt(0).lt(1).optional(),
  takeProfitPct: z.number().gt(0).optional(),
  walletExitThreshold: z.number().gt(0).lte(1).optional(),
  maxPoolShare: z.number().gt(0).lte(1).optional(),
  batchingWindowMs: positiveInt.optional(),
  profitLadder: z.array(ladderRung).optional(),
});
export type ScoringConfig = z.infer<typeof ScoringConfigInputSchema>;

/** Domain-aware validation. Throws ValidationError with a clear message on any violation. */
export function validateScoringConfig(input: unknown, domain: Domain): ScoringConfig {
  const parsed = ScoringConfigInputSchema.safeParse(input);
  if (!parsed.success) {
    throw new ValidationError(`invalid ScoringConfig: ${parsed.error.issues.map((i) => `${i.path.join('.')}: ${i.message}`).join('; ')}`);
  }
  const cfg = parsed.data;

  if (domain === 'perp') {
    // Operator preference — one coin at a time per perp agent. Users wanting broader concurrent
    // exposure create additional TradingAgents (same discipline as §32 memecoin: "users wanting
    // more concurrent exposure create more TradingAgents; that keeps each agent's portfolio,
    // risk gates and track record cleanly separable").
    if (cfg.maxConcurrentPositions !== 1) {
      throw new ValidationError('perp: maxConcurrentPositions must be 1 — one coin at a time per agent; add more agents for broader concurrent exposure');
    }
  }
  if (domain === 'memecoin') {
    if (cfg.maxConcurrentPositions !== 1) {
      throw new ValidationError('memecoin: maxConcurrentPositions must be 1 (§32 domain rule — one position at a time)');
    }
    if (cfg.leverageMax !== undefined) {
      throw new ValidationError('memecoin: leverageMax is not applicable (spot, no leverage)');
    }
    if (cfg.entryType === 'LIMIT') {
      throw new ValidationError('memecoin: entryType must be MARKET (Part II §10 — no LIMIT, no PENDING_ENTRY on an AMM)');
    }
    if (cfg.profitLadder) {
      const cumulative = cfg.profitLadder.reduce((s, r) => s + r.sellFraction, 0);
      if (cumulative > 1.0 + 1e-9) {
        throw new ValidationError(`profitLadder cumulative sellFraction ${cumulative.toFixed(3)} exceeds 1.0 (Part II §10)`);
      }
      // Rungs must be strictly ascending on `at`.
      for (let i = 1; i < cfg.profitLadder.length; i++) {
        if (cfg.profitLadder[i]!.at <= cfg.profitLadder[i - 1]!.at) {
          throw new ValidationError('profitLadder rungs must be strictly ascending on `at`');
        }
      }
    }
  } else {
    // perp
    if (cfg.stopPct || cfg.takeProfitPct || cfg.walletExitThreshold || cfg.maxPoolShare || cfg.batchingWindowMs || cfg.profitLadder) {
      throw new ValidationError('perp: memecoin-specific fields (stopPct / takeProfitPct / walletExitThreshold / maxPoolShare / batchingWindowMs / profitLadder) are not applicable');
    }
  }

  return cfg;
}

/**
 * Plan-default composite weights (Part II §9 Opportunity Score / Part III §3 Signal Scoring
 * Engine), including the Feature rows that are not Agents (§40 "Features (not Agents)").
 *
 * §7: "Default: all agents contribute unless a user deliberately customizes their TradingAgent."
 * These are what a TradingAgent created without an explicit `agentWeights` should get. Weights
 * renormalize in `composeSignal`, so a roster subset stays comparable — but the defaults sum to
 * exactly 1.00, which `DEFAULT_AGENT_WEIGHTS_SUM_TO_ONE` asserts.
 *
 * `historical_edge` is a Feature reading BrainSetupMemory (§40.16 / §40.19). Before M6 resolves
 * outcomes it contributes exactly 0, so its presence here does not change composites yet.
 */
export const DEFAULT_AGENT_WEIGHTS: Record<Domain, Record<string, number>> = {
  perp: {
    'perp.momentum': 0.2,
    'perp.open_interest': 0.2,
    'perp.market_regime': 0.15,
    'perp.liquidation': 0.15,
    'perp.funding': 0.1,
    'perp.positioning': 0.1,
    volume: 0.05,
    historical_edge: 0.05,
  },
  memecoin: {
    'memecoin.smart_money': 0.25,
    'memecoin.convergence': 0.2,
    early_entry: 0.15,
    'memecoin.momentum': 0.15,
    'memecoin.token_quality': 0.1,
    'memecoin.market_regime': 0.05,
    freshness: 0.05,
    historical_edge: 0.05,
  },
};

/** LIMIT expiry (§8 table). Missed-fill window per style: 6 × primary-TF. Ignored for MARKET. */
export const LIMIT_EXPIRY_MS: Record<'scalp' | 'day' | 'swing', number> = {
  scalp: 30 * 60_000,      // 6 × 5m
  day:   6 * 60 * 60_000,  // 6 × 1h
  swing: 24 * 60 * 60_000, // 6 × 4h
};
