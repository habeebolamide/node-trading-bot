/**
 * Perp Judge Agent (§18, §40.14). EVENT trigger on `signal.created` post-Risk approval. Emits
 * `judge.evaluation.completed` on success; the override gate (m7-override-gate) consumes that
 * event. On LLM failure emits NOTHING — the deterministic path already created its Signal and
 * the gate's default-by-absence rule (§18 LLM-failure paragraph) is what covers this.
 */
import { eq } from 'drizzle-orm';
import type { DomainEvent } from '@tip/domain';
import { ValidationError, createLogger } from '@tip/domain';
import { signalFeature, signalRisk, type Db } from '@tip/database';
import { EVENT_NAMES, type EventBus, QUEUE_NAMES } from '@tip/events';
import { callWithLog, type DeepSeekClient } from '@tip/llm';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';
import { buildJudgeEvidence } from './evidence.js';
import { JUDGE_VERSION_CURRENT, currentJudgePrompt } from './prompts.js';
import { JudgeOutput } from './schema.js';

const KEY = 'judge';
const log = createLogger('agents.judge');

export interface JudgeDeps {
  llm: DeepSeekClient;
  bus?: EventBus;
}

/**
 * The Judge is a normal `AnalysisAgent` for consistency with the M4 interface (same
 * `canHandle` / `analyze` contract), but it does NOT participate in the composite (§40.14 weight
 * N/A). It writes ONE `signal_feature` row of its own so §22 attribution reads a single row per
 * agent and M5 Agent Memory has a lean to score once outcomes accumulate.
 */
export function createJudgeAgent(deps: JudgeDeps): AnalysisAgent {
  return {
    key: KEY,
    version: JUDGE_VERSION_CURRENT,
    trigger: 'EVENT',
    canHandle(event: DomainEvent) {
      return event.type === EVENT_NAMES.SIGNAL_CREATED;
    },
    async analyze(event: DomainEvent, ctx: AgentContext): Promise<AgentOutput | null> {
      if (ctx.domain !== 'perp') {
        // §40.14 memecoin scoping: "registered but disabled; the calling code short-circuits
        // before invoking it, no cost incurred." A hard throw makes the mismatch visible in
        // review rather than degrading silently.
        throw new ValidationError('Judge is perp-only in MVP (§40.14 memecoin scope)');
      }
      const payload = event.payload as { signalId: string; domain: string };
      const signalId = payload?.signalId;
      if (!signalId) return null;

      // §40.14: "Risk INVALIDATED short-circuits — no Judge call on invalidated signals."
      const risk = (await ctx.db.select({ level: signalRisk.riskLevel })
        .from(signalRisk)
        .where(eq(signalRisk.signalId, signalId))
        .limit(1))[0];
      if (risk?.level === 'INVALIDATED') return null;

      const evidence = await buildJudgeEvidence(ctx.db, signalId);
      if (!evidence) return null;

      const prompt = currentJudgePrompt();
      const call = await callWithLog(ctx.db, deps.llm, {
        system: prompt.system,
        user: prompt.userTemplate(evidence),
        schema: JudgeOutput,
        maxTokens: 1500,
      }, { agent: KEY, agentVersion: JUDGE_VERSION_CURRENT, signalId });

      if (!call.ok) {
        // §18 LLM-failure paragraph: "the prediction must still be created, deterministic-only."
        // We emit no event; the gate defaults to DEFER by absence.
        log.warn('judge llm failure', { signalId, errorKind: call.errorKind, message: call.message });
        return null;
      }
      const j = call.value;

      // Write the Judge's row into signal_feature so §22 + M5 Agent Memory see it uniformly.
      // score is signed: direction × confidence. LONG +conf, SHORT -conf, NEUTRAL 0.
      const dirSign = j.direction === 'LONG' ? 1 : j.direction === 'SHORT' ? -1 : 0;
      const judgeScore = dirSign * j.confidence;
      await ctx.db.insert(signalFeature).values({
        signalId,
        agentKey: KEY,
        agentVersion: JUDGE_VERSION_CURRENT,
        score: String(judgeScore),
        confidence: String(j.confidence),
        features: {
          thesis: j.thesis,
          keyRisks: j.keyRisks,
          invalidators: j.invalidators,
          confidenceTag: j.confidenceTag,
          judgeDirection: j.direction,
          judgeAction: null, // m7-override-gate stamps this when it decides
          llmCallLogId: call.id,
        },
      });

      if (deps.bus) {
        await deps.bus.publish(QUEUE_NAMES.SIGNAL_PROCESSING, {
          type: EVENT_NAMES.JUDGE_EVALUATION_COMPLETED,
          eventTime: new Date().toISOString(),
          source: 'judge',
          payload: {
            signalId,
            judgeVersion: JUDGE_VERSION_CURRENT,
            judgeDirection: j.direction,
            judgeConfidence: j.confidence,
            confidenceTag: j.confidenceTag,
            llmCallLogId: call.id,
          },
        });
      }

      // Return an AgentOutput for callers who want to compose downstream, though the composite
      // itself never reads Judge output — the composite ran before Judge did.
      return {
        agent: KEY,
        agentVersion: JUDGE_VERSION_CURRENT,
        direction: j.direction,
        score: judgeScore,
        confidence: j.confidence,
        features: {
          thesis: j.thesis, keyRisks: j.keyRisks, invalidators: j.invalidators,
          confidenceTag: j.confidenceTag,
        },
      };
    },
  };
}

export { JUDGE_VERSION_CURRENT, currentJudgePrompt } from './prompts.js';
export { JudgeOutput } from './schema.js';
export { buildJudgeEvidence, type JudgeEvidence } from './evidence.js';
export const JUDGE_AGENT_KEY = KEY;
