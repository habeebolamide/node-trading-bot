// src/infra/notifications.ts
import TelegramBot from 'node-telegram-bot-api';
import type { Agent } from '../types/agent.types.js';
import type { ClosedTrade, OpenTrade } from '../types/trade.types.js';
import type { EntrySignal } from '../types/claude.types.js';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

export const notifications = {

  async sendTradeAlert(
    agent: Agent,
    type: 'PAPER_OPEN' | 'LIVE_OPEN' | 'CLOSE' | 'PARTIAL_CLOSE' | 'ADJUST'| 'TP_HIT'| 'SL_HIT',
    trade: OpenTrade | ClosedTrade
  ): Promise<void> {

    let message = '';

    if (type === 'PAPER_OPEN' || type === 'LIVE_OPEN') {
      const isPaper = type === 'PAPER_OPEN';
      const openTrade = trade as OpenTrade;

      message = `${isPaper ? '🧪' : '🚀'} [${isPaper ? 'PAPER' : 'LIVE'} TRADE OPENED]\n\n` +
        `Agent: <b>${agent.name}</b>\n` +
        `Pair: <b>${openTrade.pair}</b>\n` +
        `Direction: <b>${openTrade.direction}</b>\n` +
        `Entry: <b>${openTrade.entryPrice}</b>\n` +
        `SL: <b>${openTrade.currentSl}</b>\n` +
        `TP: <b>${openTrade.currentTp}</b>\n` +
        `Size: <b>${openTrade.positionSize}</b>\n` +
        `Value: <b>$${openTrade.positionValue.toFixed(2)}</b>\n` +
        `Mode: ${isPaper ? 'PAPER' : 'LIVE'}`;
    }
    else if (type === 'CLOSE') {
      const closedTrade = trade as ClosedTrade;

      const emoji = closedTrade.outcome === 'win' ? '✅' : '❌';

      message = `${emoji} TRADE CLOSED\n\n` +
        `Agent: <b>${agent.name}</b>\n` +
        `Pair: <b>${closedTrade.pair}</b>\n` +
        `Direction: ${closedTrade.direction}\n` +
        `Entry: ${closedTrade.entryPrice} → Exit: ${closedTrade.exitPrice}\n` +
        `PnL: <b>${closedTrade.realisedPnl.toFixed(2)} USDT</b> (${closedTrade.realisedPct.toFixed(2)}%)\n` +
        `Outcome: <b>${closedTrade.outcome.toUpperCase()}</b>\n` +
        `Reason: ${closedTrade.closeReason}`;
    }
    else if (type === 'ADJUST') {
      message = `🔄 TP/SL ADJUSTED\n\n` +
        `Agent: <b>${agent.name}</b>\n` +
        `Pair: ${trade.pair} \n` +
        `New SL: <b>${trade.currentSl}</b>\n` +
        `New TP: <b>${trade.currentTp}</b>`;
    }

    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
      console.log(`📨 Telegram alert sent: ${type}`);
    } catch (error) {
      console.error('Failed to send Telegram message:', error);
    }
  },

  async sendNoTradeSignal(agentName: string, pair: string, reason: string, triggers:any): Promise<void> {
    const message = `⚠️ No trade signal from ${agentName} for ${pair} at this time.\n\n` +
      `Reason: <b>${reason}</b>.\n\n
      Triggers:\n
        Price Up: ${triggers.price_up}
        Price Down: ${triggers.price_down}
      `;
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
      console.log('📨 Telegram no-signal alert sent');
    } catch (error) {
      console.error('Failed to send Telegram message:', error);
    }
  },

  async sendSignalAlert(agent: Agent, signal: EntrySignal, positionSize: number): Promise<void> {
    const directionEmoji = signal.action === 'LONG' ? '🟢' : '🔴';

    const expiryText = signal.entry_expiry
      ? new Date(signal.entry_expiry).toUTCString()
      : 'N/A';

    // Value = notional USDT exposure at the intended entry. Mirrors how Bybit
    // displays open positions (size in base units, value in quote).
    const entryPrice = signal.entry ?? 0;
    const value      = positionSize * entryPrice;

    const message = `${directionEmoji} <b>SIGNAL GENERATED</b>

    <b>Agent:</b> ${agent.name}
    <b>Pair:</b> ${agent.pair}
    <b>Direction:</b> ${signal.action}

    <b>Entry:</b> ${signal.entry}
    <b>SL:</b> ${signal.sl}
    <b>TP:</b> ${signal.tp}

    <b>Size:</b> ${positionSize}
    <b>Value:</b> ${value.toFixed(2)} USDT

    <b>Confidence:</b> ${signal.confidence}/10

    ⏳ <b>Expires:</b> ${expiryText}

    🧠 <b>Reason:</b>
    ${signal.reasoning || 'No reasoning provided'}
    `;

    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
      console.log(`📨 Signal alert sent for ${agent.name} → ${signal.action} ${agent.pair}`);
    } catch (error) {
      console.error('Failed to send signal alert:', error);
    }
  },

  async sendExpiryAlert(agent: Agent, signal: any): Promise<void> {
    const message = `⌛ <b>SIGNAL EXPIRED</b>

    <b>Agent:</b> ${agent.name}
    <b>Pair:</b> ${agent.pair}
    <b>Direction:</b> ${signal.action}
    <b>Entry:</b> ${signal.entry}

    Price never reached entry before the deadline — agent back to IDLE.
    `;

    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
      console.log(`📨 Expiry alert sent for ${agent.name} → ${signal.action} ${agent.pair}`);
    } catch (error) {
      console.error('Failed to send expiry alert:', error);
    }
  },

  // Extra helper methods
  async sendError(message: string): Promise<void> {
    await bot.sendMessage(CHAT_ID, `❌ ERROR: ${message}`);
  },

  async sendSystem(message: string): Promise<void> {
    await bot.sendMessage(CHAT_ID, `ℹ️ ${message}`);
  },

  // ─── Challenge mode notifications ───

  async sendChallengeStarted(
    agent: { name: string; pair: string },
    session: {
      startingCapital: number;
      targetCapital:   number;
      endsAt:          Date;
      leverage:        number;
      riskPercent:     number;
      executionMode:   string;
    },
  ): Promise<void> {
    const multiplier = session.targetCapital / session.startingCapital;
    const daysLeft   = Math.max(0, Math.ceil((session.endsAt.getTime() - Date.now()) / 86_400_000));
    const message = `🎯 <b>CHALLENGE STARTED</b>

    <b>Agent:</b> ${agent.name}
    <b>Pair:</b> ${agent.pair}
    <b>Mode:</b> ${session.executionMode.toUpperCase()}

    <b>Start:</b> $${session.startingCapital.toFixed(2)}
    <b>Target:</b> $${session.targetCapital.toFixed(2)} (${multiplier.toFixed(1)}×)
    <b>Duration:</b> ${daysLeft} days
    <b>Leverage:</b> ${session.leverage}× | <b>Risk:</b> ${session.riskPercent}%/trade

    ⏳ Ends: ${session.endsAt.toUTCString()}
    `;
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
      console.log(`📨 Challenge start alert sent for ${agent.name}`);
    } catch (error) {
      console.error('Failed to send challenge-started alert:', error);
    }
  },

  async sendChallengeStartFailed(
    agent: { name: string },
    reason: string,
    detail: string,
  ): Promise<void> {
    const message = `🚫 <b>CHALLENGE START FAILED</b>

    <b>Agent:</b> ${agent.name}
    <b>Reason:</b> <code>${reason}</code>
    <b>Detail:</b> ${detail}

    challengeMode has been toggled back to false. Fix the issue and toggle again.
    `;
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
      console.log(`📨 Challenge start-failed alert sent: ${reason}`);
    } catch (error) {
      console.error('Failed to send challenge-start-failed alert:', error);
    }
  },

  async sendChallengeEnded(
    agent: { name: string; pair: string },
    session: {
      status:          'passed' | 'failed' | 'expired' | 'cancelled';
      startingCapital: number;
      targetCapital:   number;
      finalEquity:     number | null;
      finalReturnPct:  number | null;
      failReason:      string | null;
    },
  ): Promise<void> {
    const emoji =
      session.status === 'passed'    ? '🏆' :
      session.status === 'failed'    ? '💀' :
      session.status === 'expired'   ? '⌛' :
      /* cancelled */                  '🛑';

    const finalEquityStr = session.finalEquity !== null
      ? `$${session.finalEquity.toFixed(2)}`
      : 'unknown';
    const finalReturnStr = session.finalReturnPct !== null
      ? `${session.finalReturnPct >= 0 ? '+' : ''}${session.finalReturnPct.toFixed(2)}%`
      : 'unknown';

    const message = `${emoji} <b>CHALLENGE ${session.status.toUpperCase()}</b>

    <b>Agent:</b> ${agent.name}
    <b>Pair:</b> ${agent.pair}

    <b>Start:</b> $${session.startingCapital.toFixed(2)} → <b>End:</b> ${finalEquityStr}
    <b>Target:</b> $${session.targetCapital.toFixed(2)}
    <b>Return:</b> ${finalReturnStr}
    ${session.failReason ? `\n    <b>Reason:</b> ${session.failReason}` : ''}

    Agent has been paused. Toggle challengeMode again to start a new run.
    `;
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
      console.log(`📨 Challenge end alert sent for ${agent.name} (${session.status})`);
    } catch (error) {
      console.error('Failed to send challenge-ended alert:', error);
    }
  },
};