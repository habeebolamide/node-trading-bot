// src/infra/notifications.ts
import TelegramBot from 'node-telegram-bot-api';
import type { Agent } from '../types/agent.types.js';
import type { ClosedTrade, OpenTrade } from '../types/trade.types.js';
import type { EntrySignal } from '../types/claude.types.js';
import logger from './logger.js';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

// ─────────────────────────────────────────────
// safeSend — the ONLY place we actually hit Telegram.
// Catches BOTH async send errors AND any sync error thrown while building
// the message (e.g. `.toFixed()` on undefined). Never rejects, never throws,
// never blocks the caller. If Telegram is down or the message is malformed,
// the bot keeps trading and the failure is logged.
// ─────────────────────────────────────────────

async function safeSend(
  build: () => { text: string; options?: TelegramBot.SendMessageOptions },
  context: string,
): Promise<void> {
  let text: string;
  let options: TelegramBot.SendMessageOptions | undefined;
  try {
    const built = build();
    text = built.text;
    options = built.options;
  } catch (buildErr: any) {
    logger.error('Telegram message build failed', {
      context,
      error: buildErr?.message ?? buildErr,
    });
    return;
  }

  try {
    await bot.sendMessage(CHAT_ID, text, options);
  } catch (sendErr: any) {
    // Common cases: 400 (HTML parse error / message too long), 403 (chat
    // blocked the bot), 429 (rate limit). None of these should block trading.
    logger.error('Telegram send failed', {
      context,
      error: sendErr?.message ?? sendErr,
      code:  sendErr?.code ?? null,
    });
  }
}

// ─────────────────────────────────────────────
// Public notification surface. Every method returns a resolved Promise
// — callers can `await` them safely without risking a throw blocking
// trade-close paths, etc.
// ─────────────────────────────────────────────

export const notifications = {

  async sendTradeAlert(
    agent: Agent,
    type: 'PAPER_OPEN' | 'LIVE_OPEN' | 'CLOSE' | 'PARTIAL_CLOSE' | 'ADJUST' | 'TP_HIT' | 'SL_HIT',
    trade: OpenTrade | ClosedTrade,
  ): Promise<void> {
    await safeSend(() => {
      let text = '';

      if (type === 'PAPER_OPEN' || type === 'LIVE_OPEN') {
        const isPaper = type === 'PAPER_OPEN';
        const openTrade = trade as OpenTrade;
        text =
          `${isPaper ? '🧪' : '🚀'} [${isPaper ? 'PAPER' : 'LIVE'} TRADE OPENED]\n\n` +
          `Agent: <b>${agent.name}</b>\n` +
          `Pair: <b>${openTrade.pair}</b>\n` +
          `Direction: <b>${openTrade.direction}</b>\n` +
          `Entry: <b>${openTrade.entryPrice}</b>\n` +
          `SL: <b>${openTrade.currentSl}</b>\n` +
          `TP: <b>${openTrade.currentTp}</b>\n` +
          `Size: <b>${openTrade.positionSize}</b>\n` +
          `Value: <b>$${(openTrade.positionValue ?? 0).toFixed(2)}</b>\n` +
          `Mode: ${isPaper ? 'PAPER' : 'LIVE'}`;
      } else if (type === 'CLOSE') {
        const closedTrade = trade as ClosedTrade;
        const emoji = closedTrade.outcome === 'win' ? '✅' : '❌';
        // Only show the partial / final breakdown when there were actual
        // partials — keeps the notification clean for the common case where
        // total PnL == final exit PnL.
        const prior = (closedTrade as any).priorPartialPnl ?? 0;
        const final = (closedTrade as any).finalExitPnl ?? closedTrade.realisedPnl ?? 0;
        const hasPartials = Math.abs(prior) > 0.005;
        const breakdownLine = hasPartials
          ? `  ↳ Banked from partials: <b>${prior >= 0 ? '+' : ''}${prior.toFixed(2)}</b> · Final exit: <b>${final >= 0 ? '+' : ''}${final.toFixed(2)}</b>\n`
          : '';
        text =
          `${emoji} TRADE CLOSED\n\n` +
          `Agent: <b>${agent.name}</b>\n` +
          `Pair: <b>${closedTrade.pair}</b>\n` +
          `Direction: ${closedTrade.direction}\n` +
          `Entry: ${closedTrade.entryPrice} → Exit: ${closedTrade.exitPrice}\n` +
          `PnL: <b>${(closedTrade.realisedPnl ?? 0).toFixed(2)} USDT</b> (${(closedTrade.realisedPct ?? 0).toFixed(2)}%)\n` +
          breakdownLine +
          `Outcome: <b>${(closedTrade.outcome ?? 'unknown').toString().toUpperCase()}</b>\n` +
          `Reason: ${closedTrade.closeReason}`;
      } else if (type === 'ADJUST') {
        text =
          `🔄 TP/SL ADJUSTED\n\n` +
          `Agent: <b>${agent.name}</b>\n` +
          `Pair: ${trade.pair}\n` +
          `New SL: <b>${trade.currentSl}</b>\n` +
          `New TP: <b>${trade.currentTp}</b>`;
      } else {
        // PARTIAL_CLOSE / TP_HIT / SL_HIT — fallback formatting so we still
        // get *something* to Telegram instead of an empty message that fails.
        text =
          `📊 ${type}\n\n` +
          `Agent: <b>${agent.name}</b>\n` +
          `Pair: <b>${trade.pair}</b>\n` +
          `Direction: ${trade.direction}\n` +
          `Entry: ${trade.entryPrice}`;
      }

      return { text, options: { parse_mode: 'HTML' } };
    }, `sendTradeAlert:${type}`);
  },

  // Dedicated partial-close alert — separate from sendTradeAlert because it
  // needs values that don't exist on the trade row after mutation (the % and
  // closed-size are local to partialCloseTrade). Called from there directly.
  async sendPartialCloseAlert(
    agent: Agent,
    trade: OpenTrade,
    info: {
      percent:     number;
      closedSize:  number;
      remainSize:  number;
      exitPrice:   number;
      partialPnl:  number;
    },
  ): Promise<void> {
    await safeSend(() => {
      const pnlSign = info.partialPnl >= 0 ? '+' : '';
      const text =
        `📊 <b>PARTIAL CLOSE</b>\n\n` +
        `Agent: <b>${agent.name}</b>\n` +
        `Pair: <b>${trade.pair}</b>\n` +
        `Direction: ${trade.direction}\n` +
        `Closed: <b>${info.percent}%</b> (${info.closedSize} ${trade.pair.replace('USDT', '')})\n` +
        `Remaining: <b>${info.remainSize} ${trade.pair.replace('USDT', '')}</b>\n` +
        `Exit: ${info.exitPrice}\n` +
        `Banked PnL: <b>${pnlSign}${info.partialPnl.toFixed(2)} USDT</b>\n` +
        `New SL: ${trade.currentSl}\n` +
        `TP: ${trade.currentTp}`;
      return { text, options: { parse_mode: 'HTML' } };
    }, `sendPartialCloseAlert:${agent.name}`);
  },

  async sendNoTradeSignal(
    agentName: string,
    pair: string,
    reason: string,
    triggers: any,
  ): Promise<void> {
    await safeSend(() => ({
      text:
        `⚠️ No trade signal from ${agentName} for ${pair} at this time.\n\n` +
        `Reason: <b>${reason}</b>.\n\n` +
        `Triggers:\n` +
        `  Price Up: ${triggers?.price_up ?? 'null'}\n` +
        `  Price Down: ${triggers?.price_down ?? 'null'}`,
      options: { parse_mode: 'HTML' },
    }), 'sendNoTradeSignal');
  },

  async sendSignalAlert(
    agent: Agent,
    signal: EntrySignal,
    positionSize: number,
  ): Promise<void> {
    await safeSend(() => {
      const directionEmoji = signal.action === 'LONG' ? '🟢' : '🔴';
      const expiryText = signal.entry_expiry
        ? new Date(signal.entry_expiry).toUTCString()
        : 'N/A';
      const entryPrice = signal.entry ?? 0;
      const value      = positionSize * entryPrice;

      const text = `${directionEmoji} <b>SIGNAL GENERATED</b>

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
      return { text, options: { parse_mode: 'HTML' } };
    }, `sendSignalAlert:${agent.name}`);
  },

  async sendExpiryAlert(agent: Agent, signal: any): Promise<void> {
    await safeSend(() => ({
      text: `⌛ <b>SIGNAL EXPIRED</b>

    <b>Agent:</b> ${agent.name}
    <b>Pair:</b> ${agent.pair}
    <b>Direction:</b> ${signal?.action}
    <b>Entry:</b> ${signal?.entry}

    Price never reached entry before the deadline — agent back to IDLE.
    `,
      options: { parse_mode: 'HTML' },
    }), `sendExpiryAlert:${agent.name}`);
  },

  async sendError(message: string): Promise<void> {
    await safeSend(() => ({ text: `❌ ERROR: ${message}` }), 'sendError');
  },

  async sendSystem(message: string): Promise<void> {
    await safeSend(() => ({ text: `ℹ️ ${message}` }), 'sendSystem');
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
    await safeSend(() => {
      const multiplier = session.targetCapital / session.startingCapital;
      const daysLeft = Math.max(
        0,
        Math.ceil((session.endsAt.getTime() - Date.now()) / 86_400_000),
      );
      const text = `🎯 <b>CHALLENGE STARTED</b>

    <b>Agent:</b> ${agent.name}
    <b>Pair:</b> ${agent.pair}
    <b>Mode:</b> ${(session.executionMode ?? '').toUpperCase()}

    <b>Start:</b> $${session.startingCapital.toFixed(2)}
    <b>Target:</b> $${session.targetCapital.toFixed(2)} (${multiplier.toFixed(1)}×)
    <b>Duration:</b> ${daysLeft} days
    <b>Leverage:</b> ${session.leverage}× | <b>Risk:</b> ${session.riskPercent}%/trade

    ⏳ Ends: ${session.endsAt.toUTCString()}
    `;
      return { text, options: { parse_mode: 'HTML' } };
    }, `sendChallengeStarted:${agent.name}`);
  },

  async sendChallengeStartFailed(
    agent: { name: string },
    reason: string,
    detail: string,
  ): Promise<void> {
    await safeSend(() => ({
      text: `🚫 <b>CHALLENGE START FAILED</b>

    <b>Agent:</b> ${agent.name}
    <b>Reason:</b> <code>${reason}</code>
    <b>Detail:</b> ${detail}

    challengeMode has been toggled back to false. Fix the issue and toggle again.
    `,
      options: { parse_mode: 'HTML' },
    }), `sendChallengeStartFailed:${agent.name}`);
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
    await safeSend(() => {
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

      const text = `${emoji} <b>CHALLENGE ${session.status.toUpperCase()}</b>

    <b>Agent:</b> ${agent.name}
    <b>Pair:</b> ${agent.pair}

    <b>Start:</b> $${session.startingCapital.toFixed(2)} → <b>End:</b> ${finalEquityStr}
    <b>Target:</b> $${session.targetCapital.toFixed(2)}
    <b>Return:</b> ${finalReturnStr}
    ${session.failReason ? `\n    <b>Reason:</b> ${session.failReason}` : ''}

    Agent has been paused. Toggle challengeMode again to start a new run.
    `;
      return { text, options: { parse_mode: 'HTML' } };
    }, `sendChallengeEnded:${agent.name}`);
  },
};
