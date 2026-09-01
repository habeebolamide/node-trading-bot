/**
 * Trigger router. An extremely small dispatcher: given a DomainEvent, find every registered
 * AnalysisAgent whose `canHandle(event)` returns true, call each `analyze(event, ctx)`, and
 * hand the outputs to a sink. Sinks include the FeatureAggregator (which composes signals in
 * change 2) and can be swapped for tests.
 *
 * This isn't a full scheduler — CADENCE agents are just AnalysisAgents that answer canHandle=true
 * only for their timeframe's candle-close event. The trigger enum on each agent is metadata for
 * observability + the runner; canHandle is the actual guard.
 */
import type { DomainEvent } from '@tip/domain';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

export type AgentOutputSink = (output: AgentOutput, ctx: AgentContext, event: DomainEvent) => void | Promise<void>;

export class TriggerRouter {
  private readonly agents: AnalysisAgent[] = [];
  constructor(private readonly sink: AgentOutputSink) {}

  register(agent: AnalysisAgent): void {
    if (this.agents.some((a) => a.key === agent.key && a.version === agent.version)) {
      throw new Error(`agent already registered: ${agent.key}@v${agent.version}`);
    }
    this.agents.push(agent);
  }

  /** Present-tense: which registered agents will fire for this event. */
  matching(event: DomainEvent): AnalysisAgent[] {
    return this.agents.filter((a) => a.canHandle(event));
  }

  /** Route one event through every matching agent; hand each output to the sink. */
  async route(event: DomainEvent, ctx: AgentContext): Promise<void> {
    for (const agent of this.matching(event)) {
      const out = await agent.analyze(event, ctx);
      if (out && !out.skipped) await this.sink(out, ctx, event);
    }
  }

  /** Test/observability: number of registered agents. */
  size(): number {
    return this.agents.length;
  }
}
