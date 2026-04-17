// src/infra/notifications.ts
import TelegramBot from 'node-telegram-bot-api';
import { Agent } from '../types/agent.types';
import { ClosedTrade, OpenTrade } from '../types/trade.types';
import { EntrySignal } from '../types/claude.types';

const bot = new TelegramBot(process.env.TELEGRAM_BOT_TOKEN!, { polling: false });
const CHAT_ID = process.env.TELEGRAM_CHAT_ID!;

export const notifications = {

  async sendTradeAlert(
    agent: Agent,
    type: 'PAPER_OPEN' | 'LIVE_OPEN' | 'CLOSE' | 'PARTIAL_CLOSE' | 'ADJUST',
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

  async sendNoTradeSignal(agentName: string, pair: string, reason: string): Promise<void> {
    const message = `⚠️ No trade signal from ${agentName} for ${pair} at this time.\n\n` +
      `Reason: <b>${reason}</b>`;
    try {
      await bot.sendMessage(CHAT_ID, message, { parse_mode: 'HTML' });
      console.log('📨 Telegram no-signal alert sent');
    } catch (error) {
      console.error('Failed to send Telegram message:', error);
    }
  },

  async sendSignalAlert(agent: Agent, signal: EntrySignal): Promise<void> {
    const directionEmoji = signal.action === 'LONG' ? '🟢' : '🔴';

    const expiryText = signal.entry_expiry
      ? new Date(signal.entry_expiry).toUTCString()
      : 'N/A';

    const message = `${directionEmoji} <b>SIGNAL GENERATED</b>

    <b>Agent:</b> ${agent.name}
    <b>Pair:</b> ${agent.pair}
    <b>Direction:</b> ${signal.action}

    <b>Entry:</b> ${signal.entry}
    <b>SL:</b> ${signal.sl}
    <b>TP:</b> ${signal.tp}

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

  // Extra helper methods
  async sendError(message: string): Promise<void> {
    await bot.sendMessage(CHAT_ID, `❌ ERROR: ${message}`);
  },

  async sendSystem(message: string): Promise<void> {
    await bot.sendMessage(CHAT_ID, `ℹ️ ${message}`);
  }
};