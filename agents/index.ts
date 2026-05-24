import { getEntrySignal, getManagementDecision } from "../claude/client";
import { buildEntryPrompt, buildManagementPrompt, buildSystemPrompt } from "../claude/prompts";
import { prisma } from "../lib/prisma";
import { getDrawdownState, validateEntrySignal, validateManagementDecision } from "../risk";
import {
  getActiveChallenge,
  evaluateChallenge,
  buildChallengeRiskContext,
  buildChallengePromptContext,
} from "../challenge";
import { Agent, AgentState, LearnedRule } from "../types/agent.types";
import { EntrySignal, ManagementDecision } from "../types/claude.types";
import { Candle, MultiTimeframeData, RegimeAnalysis } from "../types/market.types";
import { OpenTrade } from "../types/trade.types";
import logger from "../utils/logger";
import { getRelevantLessons } from '../learning';
import { notifications } from "../utils/notifications";
import { executionEngine } from "../execution";
import { getPortfolio, getChallengePortfolio } from "../capital";
import {
  calculateManagementTimeout,
  clampMinutes,
  entryExpiryMinutesForStyle,
  mapToOpenTrade,
  WATCH_TIMEOUT_DEFAULT_MINUTES,
} from "../utils/helper";
import { getCandleBuffer } from "../markets/websocket";

import {
  setTriggers,
  clearTriggers,
  clearTriggerMemory,
  checkTriggers,
  getPendingSignal,
  hasTriggers,
  updateTriggers,
  setTriggersMemory,
} from './triggers';


// ====================== RUNTIME AGENT CLASS ======================
export class AgentRuntime {
  public id: string;
  // public userId: string;
  public name: string;
  public pair: string;
  public allocationPercent: number;
  public riskPercent: number;
  public tradingStyle: 'scalp' | 'swing' | 'position' | 'auto';
  public mode: 'backtest' | 'paper' | 'live';
  public status: 'active' | 'paused' | 'stopped';
  public learnedRules: LearnedRule[] = [];
  public createdAt: Date;
  public updatedAt: Date;
  public leverage: number

  // Runtime-only
  public state: AgentState = 'IDLE';
  public currentTrade: OpenTrade | null = null;
  public cooldownUntil: Date | null = null;
  public consecutiveLosses: number = 0;

  private _needsReanalysis = false;
  private _needsManagementReanalysis = false;

  // Registered by index.ts — fires immediately when flag flips to true.
  // Flag is reset to false before the handler runs so the candle-close path
  // doesn't double-fire. Falls back to candle loop if handler not yet wired.
  public onNeedsReanalysis?: () => Promise<void>;
  public onNeedsManagementReanalysis?: () => Promise<void>;

  get needsReanalysis() { return this._needsReanalysis; }
  set needsReanalysis(val: boolean) {
    this._needsReanalysis = val;
    if (val && this.onNeedsReanalysis) {
      this._needsReanalysis = false;
      this.onNeedsReanalysis().catch(err =>
        logger.error(`[${this.name}] Reanalysis handler failed`, { error: err.message })
      );
    }
  }

  get needsManagementReanalysis() { return this._needsManagementReanalysis; }
  set needsManagementReanalysis(val: boolean) {
    this._needsManagementReanalysis = val;
    if (val && this.onNeedsManagementReanalysis) {
      this._needsManagementReanalysis = false;
      this.onNeedsManagementReanalysis().catch(err =>
        logger.error(`[${this.name}] Management reanalysis handler failed`, { error: err.message })
      );
    }
  }

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
    this.leverage = dbData.leverage ?? 10;

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
      leverage: this.leverage
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

  // async resumeOpenTrades(): Promise<void> {

  //   const openTrades = await prisma.trade.findMany({
  //     where: { status: 'open' },
  //   });

  //   logger.info(`Resuming ${openTrades.length} open trades from database`);

  //   for (const dbTrade of openTrades) {

  //     await this.loadAgents();


  //     const agent = this.agents.get(dbTrade.agentId);

  //     if (!agent) {
  //       logger.info(`No active agent found for open trade ${dbTrade.id} — skipping`);
  //       continue;
  //     };

  //     const openTrade: OpenTrade = {
  //       id: dbTrade.id,
  //       agentId: dbTrade.agentId,
  //       pair: dbTrade.pair,
  //       direction: dbTrade.direction as 'LONG' | 'SHORT',
  //       entryPrice: dbTrade.entryPrice,
  //       currentTp: dbTrade.takeProfit ?? 0,
  //       currentSl: dbTrade.stopLoss,
  //       positionSize: dbTrade.size,
  //       positionValue: 0,
  //       unrealisedPnl: 0,
  //       unrealisedPct: 0,
  //       openedAt: dbTrade.openedAt,
  //       entryReasoning: '',
  //       mode: agent.mode as 'paper' | 'live',
  //     };

  //     agent.attachTrade(openTrade);
  //     logger.info(`Resumed open trade for ${agent.name}`, { tradeId: dbTrade.id });
  //   }
  // }

  async restoreAgentState(agent: AgentRuntime): Promise<void> {

    // 1. Check open trade (highest priority)
    const openTrade = await prisma.trade.findFirst({
      where: { agentId: agent.id, status: 'open' },
    });

    if (openTrade) {
      agent.attachTrade(mapToOpenTrade(openTrade));
      logger.info(`[${agent.name}] Restored → IN_TRADE`, { tradeId: openTrade.id });
      return;
    }

    // 2. Get latest active signal
    const activeSignal = await prisma.signal.findFirst({
      where: { agentId: agent.id, status: 'active' },
      orderBy: { createdAt: 'desc' },
    });

    // 2a. Cancel any older active signals — defends against prior-crash residue
    // where the realtime layer would otherwise process them as still-pending.
    if (activeSignal) {
      const stale = await prisma.signal.updateMany({
        where: {
          agentId: agent.id,
          status:  'active',
          id:      { not: activeSignal.id },
        },
        data: {
          status:      'cancelled',
          triggeredBy: 'STALE_ON_RESTART',
          triggeredAt: new Date(),
        },
      });
      if (stale.count > 0) {
        logger.warn(`[${agent.name}] Cancelled ${stale.count} stale active signal(s) on restart`);
      }
    } else {
      // No surviving active signal at all — sweep any leftovers too.
      await prisma.signal.updateMany({
        where:  { agentId: agent.id, status: 'active' },
        data:   { status: 'cancelled', triggeredBy: 'STALE_ON_RESTART', triggeredAt: new Date() },
      });
    }

    if (!activeSignal) {
      agent.setState('IDLE');
      logger.info(`[${agent.name}] Restored → IDLE`);
      return;
    }

    const triggers = activeSignal.triggers as any;
    const now = Date.now();

    // 3. Expiry checks
    const timeoutExpired = triggers?.timeout
      && now > new Date(triggers.timeout).getTime();

    const entryExpired = activeSignal.entryExpiry
      && now > new Date(activeSignal.entryExpiry).getTime();

    if (timeoutExpired || entryExpired) {
      await prisma.signal.update({
        where: { id: activeSignal.id },
        data: {
          status: 'expired',
          triggeredBy: timeoutExpired ? 'TIMEOUT' : 'EXPIRY',
          triggeredAt: new Date(),
        },
      });

      agent.setState('IDLE');
      logger.info(`[${agent.name}] Signal expired during downtime → IDLE`);
      return;
    }

    // 🔥 4. RESTORE TRIGGERS INTO MEMORY
    setTriggersMemory(
      agent.id,
      triggers,
      activeSignal.action === 'NO_TRADE'
        ? null
        : {
          action: activeSignal.action as any,
          entry: activeSignal.entry,
          tp: activeSignal.tp,
          sl: activeSignal.sl,
          confidence: activeSignal.confidence,
          reasoning: activeSignal.reasoning,
        } as any,
      activeSignal.entryExpiry
        ? activeSignal.entryExpiry.toISOString()
        : null
    );

    if (activeSignal.action === 'NO_TRADE') {
      agent.setState('WATCHING');
      logger.info(`[${agent.name}] Restored → WATCHING`);
    } else {
      agent.setState('PENDING_ENTRY');
      logger.info(`[${agent.name}] Restored → PENDING_ENTRY`);
    }
  }

  // ====================== DOWNTIME CATCH-UP ======================
  // Run AFTER seedCandleBuffers — uses the 5m buffer (~16h of history) to detect
  // entry hits that happened while the bot was offline. Realtime ticker can only
  // see crossings going forward; candle-close only fires on the NEXT candle to
  // close. Without this, a hit during downtime is lost forever.
  async catchUpMissedEntries(): Promise<void> {
    for (const agent of this.agents.values()) {
      if (agent.state !== 'PENDING_ENTRY') continue;

      const signal = await prisma.signal.findFirst({
        where:   { agentId: agent.id, status: 'active' },
        orderBy: { createdAt: 'desc' },
      });

      if (!signal || signal.entry === null || signal.action === 'NO_TRADE') continue;

      const buffer  = getCandleBuffer(agent.pair, '5');
      const setAtMs = signal.createdAt.getTime();
      const entry   = signal.entry;

      const hitCandle = buffer.find(c =>
        c.openTime >= setAtMs &&
        c.low <= entry &&
        c.high >= entry,
      );

      if (!hitCandle) {
        logger.info(`[${agent.name}] No missed entry hits during downtime`);
        continue;
      }

      logger.warn(`[${agent.name}] Entry hit during downtime — running catch-up`, {
        entry,
        hitCandleOpen: new Date(hitCandle.openTime).toISOString(),
        hitHigh:       hitCandle.high,
        hitLow:        hitCandle.low,
      });

      // Re-validate risk — drawdown / circuit-breaker state may have shifted
      // during downtime; do not blindly fire a trade that current risk would reject.
      const rawSignal = signal.rawSignal as unknown as EntrySignal;
      const portfolio = await getPortfolio();
      const validation = await validateEntrySignal(
        rawSignal,
        agent.toPromptAgent(),
        { cooldownUntil: agent.cooldownUntil } as any,
        portfolio,
      );

      if (!validation.approved) {
        logger.warn(`[${agent.name}] Catch-up blocked by risk`, {
          reason: validation.blockReason,
        });
        await clearTriggers(agent.id, { status: 'cancelled', triggeredBy: 'CATCH_UP_BLOCKED' });
        agent.setState('IDLE');
        continue;
      }

      // Fill at the intended entry price — for paper this is the "limit got hit"
      // semantic; for live, Bybit will fill at market when the order submits.
      const execResult = await executionEngine.executeEntry(
        agent,
        rawSignal,
        validation.positionSize!,
        entry,
      );

      if (execResult.success) {
        // Update only this specific signal — using clearTriggers' updateMany
        // here would clobber any other active signals for the agent with the
        // wrong reason. Memory cleanup only.
        await prisma.signal.update({
          where: { id: signal.id },
          data:  {
            status:      'executed',
            triggeredBy: 'ENTRY_HIT_CATCHUP',
            triggeredAt: new Date(),
          },
        });
        clearTriggerMemory(agent.id);
        logger.info(`[${agent.name}] Catch-up trade opened`, {
          tradeId: execResult.orderId,
        });
      } else {
        logger.error(`[${agent.name}] Catch-up execution failed`, {
          error: execResult.error,
        });
      }
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
      try {
        // ── Cooldown check — pure in-memory ──
        agent.checkCooldown();

        if (agent.status !== 'active') continue;

        const activeChallenge = await getActiveChallenge(agent.id);
        if (activeChallenge) {
          const challengeStatus = await evaluateChallenge(activeChallenge);
          if (challengeStatus !== 'active') continue;
        }

        if (agent.state === 'BLOCKED' || agent.state === 'COOLDOWN') continue;

        logger.info(`[${agent.name}] Processing in state: ${agent.state}`);

        // ── Reanalysis flags set by realtime ticker ──
        if (agent.needsManagementReanalysis && agent.currentTrade) {
          agent.needsManagementReanalysis = false;
          await this.runManagementCycle(agent, mtfData, newsContext);
          continue;
        }

        if (agent.needsReanalysis) {
          agent.needsReanalysis = false;
          agent.setState('IDLE');
          await this.runEntryCycle(agent, mtfData, regime, newsContext);
          continue;
        }

        // ── Check in-memory triggers ──
        if (hasTriggers(agent.id)) {
          const result = checkTriggers(agent.id, candle);

          if (result.hit) {
            await this.handleTriggerHit(
              agent, result.reason, candle, mtfData, regime, newsContext
            );
            continue;
          }

          // Trigger exists but not hit yet — handle by state
          switch (agent.state) {

            case 'PENDING_ENTRY':
              // Entry price not hit yet — realtime ticker handles this
              // Candle close only checks expiry via checkTriggers above
              logger.info(`[${agent.name}] Pending entry — waiting`, {
                entry: getPendingSignal(agent.id)?.entry,
                currentPrice: candle.close,
              });
              break;

            case 'WATCHING':
              // NO_TRADE triggers set — waiting for price level or timeout
              // checkTriggers above already checked — nothing hit yet
              logger.info(`[${agent.name}] Watching triggers`, {
                currentPrice: candle.close,
              });
              break;

            case 'IN_TRADE':
              // Trade open — triggers set by last management cycle
              // Run management regardless — triggers just add realtime urgency
              // await this.runManagementCycle(agent, mtfData, newsContext);
              logger.info(`[${agent.name}] TimeOut Not Reached`, {
                currentPrice: candle.close,
              });
              break;

            default:
              break;
          }

          continue;
        }

        // ── No triggers — normal state flow ──
        switch (agent.state) {

          case 'IDLE':
            await this.runEntryCycle(agent, mtfData, regime, newsContext);
            break;

          case 'IN_TRADE':
            if (agent.currentTrade) {
              await this.runManagementCycle(agent, mtfData, newsContext);
            }
            break;

          case 'PENDING_ENTRY':
            // Pending entry with no triggers — lost on restart
            // Re-analyse to get a fresh signal
            logger.warn(`[${agent.name}] PENDING_ENTRY with no triggers — re-analysing`);
            agent.setState('IDLE');
            await this.runEntryCycle(agent, mtfData, regime, newsContext);
            break;

          case 'WATCHING':
            // WATCHING with no triggers — also lost on restart
            // Go back to IDLE and re-analyse
            logger.warn(`[${agent.name}] WATCHING with no triggers — re-analysing`);
            agent.setState('IDLE');
            await this.runEntryCycle(agent, mtfData, regime, newsContext);
            break;

          default:
            break;
        }

      } catch (err: any) {
        logger.error(`Error processing agent ${agent.name}`, { error: err.message });
      }
    }
  }

  // ====================== decides what to do based on which trigger fired and agent state ======================

  async handleTriggerHit(
    agent: any,
    reason: string,
    candle: any,
    mtfData: any,
    regime: any,
    newsContext: string,
  ): Promise<void> {
    logger.info('Handling trigger hit', { agentId: agent.id, reason, state: agent.state });

    switch (reason) {

      // ── Entry expired — signal no longer valid ──
      // Note: ENTRY_HIT is handled exclusively by the realtime ticker path in
      // websocket.ts so entries fire on the first qualifying tick instead of
      // waiting for a 5m candle close. No case for it here.
      case 'EXPIRY': {
        const expiredSignal = getPendingSignal(agent.id);
        await clearTriggers(agent.id, { status: 'expired', triggeredBy: 'EXPIRY' });
        agent.setState('IDLE');

        logger.info('Signal expired — back to IDLE', { agentId: agent.id });
        if (expiredSignal) {
          await notifications.sendExpiryAlert(agent, expiredSignal);
        }
        break;
      }

      // ── Price moved to trigger level or timeout ──
      // In all cases — re-analyse the market
      case 'PRICE_UP':
      case 'PRICE_DOWN':
      case 'TIMEOUT': {

        if (agent.state == 'IN_TRADE') {
          logger.info('Management Timeout Reached — re-analysing', {
            agentId: agent.id,
            reason,
          });

          await this.runManagementCycle(agent, mtfData, newsContext)
          break;
        }
        // Clear old triggers before re-analysis. WATCHING signals end as
        // 'triggered' (a level fired and we're now re-analysing); pending
        // entries hijacked by an unexpected price-trigger end as 'cancelled'.
        await clearTriggers(agent.id, {
          status:      agent.state === 'PENDING_ENTRY' ? 'cancelled' : 'triggered',
          triggeredBy: reason,
        });

        // If there was a pending entry — cancel it
        if (agent.state === 'PENDING_ENTRY') {
          agent.setState('IDLE');
          logger.info('Pending entry cancelled — re-analysing', {
            agentId: agent.id,
            reason,
          });
        }

        // Re-run entry cycle with fresh market data
        await this.runEntryCycle(agent, mtfData, regime, newsContext);
        break;
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

    const challengeSession = await getActiveChallenge(agent.id);
    const challengeRisk    = challengeSession
      ? await buildChallengeRiskContext(challengeSession)
      : null;
    const challengePrompt  = challengeSession
      ? await buildChallengePromptContext(challengeSession)
      : null;

    const drawdown = await getDrawdownState(agent.id, challengeRisk);
    const performanceMode = drawdown.performanceMode;
    const systemPrompt = buildSystemPrompt(agent.toPromptAgent());

    console.log("Performance Mode:", performanceMode);

    const lessons = await getRelevantLessons(
      agent.id,
      regime.regime,
      'UNKNOWN',                                   // direction unknown before signal
      mtfData.tf1h.indicators?.rsi ?? 50,
      mtfData.tf1h.indicators?.volume?.ratio ?? 1,
      agent.pair,
      new Date().getDay(),
    );

    const riskAgent = challengeSession
      ? {
          ...agent.toPromptAgent(),
          allocationPercent: 100,
          riskPercent:       challengeSession.riskPercent ?? agent.riskPercent,
          leverage:          challengeSession.leverage ?? agent.leverage,
        }
      : agent.toPromptAgent();

    const entryPrompt = buildEntryPrompt(
      riskAgent,
      mtfData,
      regime,
      newsContext,
      lessons,
      drawdown.monthlyPnlPct * 100,
      performanceMode,
      challengePrompt,
    );

    const claudeResult = await getEntrySignal(systemPrompt, entryPrompt, agent.id);
    if (!claudeResult.success || !claudeResult.data) return;

    const signal = claudeResult.data as EntrySignal;
    const triggers = (signal as any).triggers ?? {};

    // ── NO_TRADE — watch for opportunity ──
    if (signal.action === 'NO_TRADE') {
      // LLM emits timeout_minutes (a duration it can actually reason about).
      // Server clamps and converts to an absolute deadline — LLMs cannot
      // reliably emit absolute timestamps because they have no clock.
      const watchMinutes = clampMinutes(
        triggers.timeout_minutes,
        WATCH_TIMEOUT_DEFAULT_MINUTES,
        { min: 5, maxMultiplier: 4 },   // up to ~2h
      );
      const watchTimeout = new Date(Date.now() + watchMinutes * 60_000).toISOString();

      const watchTriggers = {
        price_up: triggers.price_up ?? null,
        price_down: triggers.price_down ?? null,
        timeout: watchTimeout,
      };

      setTriggers(agent.id, watchTriggers, null, null,claudeResult.data, null);
      agent.setState('WATCHING');                  // ← WATCHING not IDLE

      logger.info(`[${agent.name}] NO_TRADE — watching`, {
        price_up: watchTriggers.price_up,
        price_down: watchTriggers.price_down,
        timeout: watchTimeout,
        timeout_minutes: watchMinutes,
      });

      notifications.sendNoTradeSignal(
        agent.name,
        agent.pair,
        signal.reasoning,
        watchTriggers,
      );
      return;
    }

    // ── LONG or SHORT — validate risk ──
    const portfolio = challengeSession
      ? await getChallengePortfolio(challengeSession)
      : await getPortfolio();
    const riskResult = await validateEntrySignal(
      signal,
      riskAgent,
      { cooldownUntil: agent.cooldownUntil } as any,
      portfolio,
      challengeRisk,
    );

    if (!riskResult.approved) {
      logger.info(`[${agent.name}] Signal blocked`, { reason: riskResult.blockReason });
      return;
    }

    // ── Set pending entry triggers — entry_expiry only ──
    // price_up/price_down not relevant here — we already decided to trade
    const pendingTriggers = {
      price_up: null,                            // ← null for pending entry
      price_down: null,                            // ← null for pending entry
      timeout: null,                            // ← timeout via entry_expiry instead
    };

    // LLM emits entry_expiry_minutes (a duration). Server clamps to safe bounds
    // based on tradeStyle and converts to an absolute deadline. LLMs have no
    // clock, so we never trust an absolute timestamp from them.
    const signalStyle = (signal as any).tradeStyle ?? agent.tradingStyle;
    const styleDefault = entryExpiryMinutesForStyle(signalStyle);
    const expiryMinutes = clampMinutes(
      (signal as any).entry_expiry_minutes,
      styleDefault,
    );
    const entryExpiry = new Date(Date.now() + expiryMinutes * 60_000).toISOString();

    // Populate the server-computed timestamp on the signal so downstream
    // consumers (e.g. notifications) that read signal.entry_expiry get the
    // real deadline, not the absent LLM field.
    (signal as any).entry_expiry = entryExpiry;

    setTriggers(agent.id, pendingTriggers, signal, entryExpiry, claudeResult.data, riskResult.positionSize);
    agent.setState('PENDING_ENTRY');               // ← PENDING_ENTRY not IN_TRADE

    await notifications.sendSignalAlert(agent, signal, riskResult.positionSize!);

    logger.info(`[${agent.name}] Signal pending`, {
      action: signal.action,
      entry: signal.entry,
      tp: signal.tp,
      sl: signal.sl,
      confidence: signal.confidence,
      expiry: entryExpiry,
      expiry_minutes: expiryMinutes,
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

    // ── AI provides price triggers — system provides timeout ──
    const aiTriggers = (decision as any).triggers ?? {};
    const systemTimeout = calculateManagementTimeout(agent.tradingStyle);

    // Update the SAME signal record — never create a new one
    await updateTriggers(agent.id, {
      price_up: aiTriggers.price_up ?? null,
      price_down: aiTriggers.price_down ?? null,
      timeout: systemTimeout,                   // system always controls this
    });

    logger.info(`[${agent.name}] Management cycle`, {
      action: decision.action,
      urgency: decision.urgency,
      price_up: aiTriggers.price_up,
      price_down: aiTriggers.price_down,
      timeout: systemTimeout,
    });

    if (decision.action === 'HOLD') return;

    // Validate the decision
    const validation = validateManagementDecision(
      decision,
      agent.currentTrade.currentSl,
      decision.newSl,
      agent.currentTrade.direction,
    );

    if (!validation.approved) {
      logger.info(`[${agent.name}] Management decision rejected`, {
        reason: validation.message,
      });
      return;
    }

    await executionEngine.executeManagement(agent, decision, agent.currentTrade);
  }
}

// Export singleton
export const agentManager = new AgentManager();