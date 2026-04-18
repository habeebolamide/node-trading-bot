import { getEntrySignal, getManagementDecision } from "../claude/client";
import { buildEntryPrompt, buildManagementPrompt, buildSystemPrompt } from "../claude/prompts";
import { prisma } from "../lib/prisma";
import { getDrawdownState, resolvePerformanceMode, validateEntrySignal, validateManagementDecision } from "../risk";
import { Agent, AgentState, LearnedRule } from "../types/agent.types";
import { EntrySignal, ManagementDecision } from "../types/claude.types";
import { Candle, MultiTimeframeData, RegimeAnalysis } from "../types/market.types";
import { OpenTrade } from "../types/trade.types";
import logger from "../utils/logger";
import { getRelevantLessons } from '../learning';
import { notifications } from "../utils/notifications";
import { executionEngine } from "../execution";
import { getPortfolio } from "../capital";


// ====================== RUNTIME AGENT CLASS ======================
export class AgentRuntime {
  public id: string;
  // public userId: string;
  public name: string;
  public pair: string;
  public allocationPercent: number;
  public riskPercent: number;
  public tradingStyle: 'scalp' | 'swing' | 'auto';
  public mode: 'backtest' | 'paper' | 'live';
  public status: 'active' | 'paused' | 'stopped';
  public learnedRules: LearnedRule[] = [];
  public createdAt: Date;
  public updatedAt: Date;

  // Runtime-only
  public state: AgentState = 'IDLE';
  public currentTrade: OpenTrade | null = null;
  public cooldownUntil: Date | null = null;
  public consecutiveLosses: number = 0;

  constructor(dbData: any) {
    this.id = dbData.id;
    // this.userId            = dbData.userId;
    this.name = dbData.name;
    this.pair = dbData.pair;
    this.allocationPercent = dbData.allocationPercent ?? 10;
    this.riskPercent = dbData.riskPercent ?? 1.0;
    this.tradingStyle = dbData.tradingStyle ?? 'swing';
    this.mode = dbData.mode ?? 'paper';
    this.status = dbData.status ?? 'active';
    this.createdAt = dbData.createdAt;
    this.updatedAt = dbData.updatedAt;

    this.learnedRules = dbData.learnedRules
      ? (typeof dbData.learnedRules === 'string'
        ? JSON.parse(dbData.learnedRules)
        : dbData.learnedRules)
      : [];
  }

  toPromptAgent(): Agent {
    return {
      id: this.id,
      // userId:            this.userId,
      name: this.name,
      pair: this.pair,
      allocationPercent: this.allocationPercent,
      riskPercent: this.riskPercent,
      tradingStyle: this.tradingStyle,
      mode: this.mode,
      status: this.status,
      learnedRules: this.learnedRules,
      createdAt: this.createdAt,
      updatedAt: this.updatedAt,
    };
  }

  setState(newState: AgentState): void {
    logger.info(`[${this.name}] State: ${this.state} → ${newState}`);
    this.state = newState;
  }

  attachTrade(trade: OpenTrade): void {
    this.currentTrade = trade;
    this.setState('IN_TRADE');
  }

  clearTrade(): void {
    this.currentTrade = null;
    this.setState('IDLE');
  }

  startCooldown(candles: number = 2): void {
    // Approximate cooldown — 2 candles on the 1h timeframe = 2 hours
    this.cooldownUntil = new Date(Date.now() + candles * 60 * 60 * 1000);
    this.setState('COOLDOWN');
    logger.info(`[${this.name}] Cooldown until ${this.cooldownUntil.toISOString()}`);
  }

  checkCooldown(): void {
    if (this.state === 'COOLDOWN' && this.cooldownUntil && new Date() > this.cooldownUntil) {
      this.cooldownUntil = null;
      this.setState('IDLE');
      logger.info(`[${this.name}] Cooldown ended — back to IDLE`);
    }
  }
}

// ====================== AGENT MANAGER ======================
export class AgentManager {
  private agents = new Map<string, AgentRuntime>();

  // Called by WebSocket to get pairs for subscription
  async loadAgents(): Promise<AgentRuntime[]> {
    return this.loadActiveAgents();
  }

  async loadActiveAgents(): Promise<AgentRuntime[]> {
    const dbAgents = await prisma.agent.findMany({ where: { status: 'active' } });

    for (const data of dbAgents) {
      if (!this.agents.has(data.id)) {
        this.agents.set(data.id, new AgentRuntime(data));
      }
    }
    return Array.from(this.agents.values());
  }

  getAgentsForPair(pair: string): AgentRuntime[] {
    return Array.from(this.agents.values()).filter(a => a.pair === pair);
  }

  getSingleAgent(agentId: string): AgentRuntime | null {
    return this.agents.get(agentId) || null;
  }

  getAllAgents(): AgentRuntime[] {
    return Array.from(this.agents.values());
  }

  async resumeOpenTrades(): Promise<void> {

    const openTrades = await prisma.trade.findMany({
      where: { status: 'open' },
    });

    logger.info(`Resuming ${openTrades.length} open trades from database`);

    for (const dbTrade of openTrades) {

      await this.loadAgents();

      const agent = this.agents.get(dbTrade.agentId);

      if (!agent) {
        logger.info(`No active agent found for open trade ${dbTrade.id} — skipping`);
        continue;
      };

      const openTrade: OpenTrade = {
        id: dbTrade.id,
        agentId: dbTrade.agentId,
        pair: dbTrade.pair,
        direction: dbTrade.direction as 'LONG' | 'SHORT',
        entryPrice: dbTrade.entryPrice,
        currentTp: dbTrade.takeProfit ?? 0,
        currentSl: dbTrade.stopLoss,
        positionSize: dbTrade.size,
        positionValue: 0,
        unrealisedPnl: 0,
        unrealisedPct: 0,
        openedAt: dbTrade.openedAt,
        entryReasoning: '',
        mode: agent.mode as 'paper' | 'live',
      };

      agent.attachTrade(openTrade);
      logger.info(`Resumed open trade for ${agent.name}`, { tradeId: dbTrade.id });
    }
  }

  // ====================== MAIN CANDLE PROCESSOR ======================
  async processSignificantCandle(
    candle: Candle,
    mtfData: MultiTimeframeData,
    regime: RegimeAnalysis,
    newsContext: string = 'No major news detected.',
  ): Promise<void> {
    const agents = this.getAgentsForPair(candle.pair);

    for (const agent of agents) {

      logger.info(`Processing agent ${agent.name} in state ${agent.state}`);

      try {
        agent.checkCooldown();

        if (agent.state === 'BLOCKED' || agent.state === 'COOLDOWN') continue;

        const pending = await prisma.pendingSignal.findFirst({
          where: {
            agentId: agent.id,
            status: 'PENDING',
          },
        });

        if (pending && pending.expiresAt < new Date()) {
          await prisma.pendingSignal.update({
            where: { id: pending.id },
            data: { status: 'EXPIRED' },
          });

          agent.setState('COOLDOWN');

          logger.info(`Pending signal expired for ${agent.name}`);
          continue;
        }

        // 👇 NORMAL STATE FLOW
        if (agent.state === 'PENDING_ENTRY') {
          continue;
        }

        if (agent.state === 'IN_TRADE' && agent.currentTrade) {
          await this.runManagementCycle(agent, mtfData, newsContext);
        } else if (agent.state === 'IDLE') {
          await this.runEntryCycle(agent, mtfData, regime, newsContext);
        }

      } catch (err: any) {
        logger.error(`Error processing agent ${agent.name}`, { error: err.message });
      }
    }
  }

  // ====================== ENTRY CYCLE ======================
  private async runEntryCycle(
    agent: AgentRuntime,
    mtfData: MultiTimeframeData,
    regime: RegimeAnalysis,
    newsContext: string,
  ): Promise<void> {
    // Get real monthly P&L from risk module
    const drawdown = await getDrawdownState(agent.id);
    const performanceMode = resolvePerformanceMode(drawdown.monthlyPnlPct);

    const systemPrompt = buildSystemPrompt(agent.toPromptAgent());

    const lessons = await getRelevantLessons(
      agent.id,
      regime.regime,
      'LONG',                                        // placeholder — Claude decides direction
      mtfData.tf1h.indicators?.rsi ?? 50,
      mtfData.tf1h.indicators?.volume?.ratio ?? 1,
      agent.pair,
      new Date().getDay(),
    );

    const entryPrompt = buildEntryPrompt(
      agent.toPromptAgent(),
      mtfData,
      regime,
      newsContext,
      lessons,            // TODO: wire up lesson retriever in learning module
      drawdown.monthlyPnlPct * 100,
      performanceMode,
    );

    const claudeResult = await getEntrySignal(systemPrompt, entryPrompt, agent.id);

    if (!claudeResult.success || !claudeResult.data) return;

    const signal = claudeResult.data as EntrySignal;

    if (signal.action === 'NO_TRADE') {
      notifications.sendNoTradeSignal(agent.name, agent.pair, signal.reasoning);
      return;
    };

    // Portfolio value from env for now — capital module will improve this
    const portfolio = await getPortfolio();

    logger.info("Portfolio Data", portfolio)

    const riskResult = await validateEntrySignal(
      signal,
      agent.toPromptAgent(),
      { cooldownUntil: agent.cooldownUntil } as any,
      portfolio,
    );

    if (!riskResult.approved) {
      logger.info(`Signal blocked for ${agent.name}`, { reason: riskResult.blockReason });
      return;
    }

    // TODO: wire up execution engine
    await executionEngine.triggerPendingSignal(agent, signal, riskResult.positionSize!, portfolio.totalValue);
    // const execResult = await executionEngine.executeEntry(agent, signal, riskResult.positionSize!, portfolio.totalValue);

    logger.info(`Signal approved for ${agent.name}`, {
      action: signal.action,
      entry: signal.entry,
      tp: signal.tp,
      sl: signal.sl,
      confidence: signal.confidence,
    });
  }

  // ====================== MANAGEMENT CYCLE ======================
  private async runManagementCycle(
    agent: AgentRuntime,
    mtfData: MultiTimeframeData,
    newsContext: string,
  ): Promise<void> {
    if (!agent.currentTrade) return;

    const systemPrompt = buildSystemPrompt(agent.toPromptAgent());
    const managementPrompt = buildManagementPrompt(
      agent.toPromptAgent(),
      agent.currentTrade,
      mtfData,
      newsContext,
    );

    const result = await getManagementDecision(systemPrompt, managementPrompt, agent.id);
    if (!result.success || !result.data) return;

    const decision = result.data as ManagementDecision;
    if (decision.action === 'HOLD') return;

    const validation = validateManagementDecision(
      decision,
      agent.currentTrade.currentSl,
      decision.newSl,
      agent.currentTrade.direction,
    );

    if (!validation.approved) return;

    // TODO: wire up execution engine
    await executionEngine.executeManagement(agent, decision, agent.currentTrade);
    logger.info(`Management decision for ${agent.name}`, {
      action: decision.action,
      newTp: decision.newTp,
      newSl: decision.newSl,
      reasoning: decision.reasoning,
    });
  }
}

// Export singleton
export const agentManager = new AgentManager();