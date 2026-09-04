/**
 * Telegram fast-lane alerts (§11 — audit #12). The env keys were reserved since M1
 * (`TELEGRAM_BOT_TOKEN` / `TELEGRAM_CHAT_ID`, both optional); this is the sender that was
 * never built.
 *
 * §11's rules, all load-bearing here:
 *   • Ordering is detection → paper fill → telegram. The alert is a RECEIPT of a recorded
 *     event — this handler only consumes events published AFTER the fill/close committed,
 *     so the ordering holds by construction.
 *   • Fire-and-forget: the send is the plan's ONE documented fire-and-forget exception. A
 *     Telegram outage never blocks or fails anything — errors are logged and dropped.
 *   • Clean feed: only REAL fills and closes hit Telegram. Signals, observations,
 *     watch-state chatter stay on the dashboard. Concretely that is: entry OPENS (perp +
 *     memecoin), SL hits, TP hits, and wallet-exit closes.
 *
 * Every I/O call has a timeout (CLAUDE.md async rules): 5s AbortController on the Bot API call.
 */
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';

export type FetchLike = (url: string, init?: { method?: string; headers?: Record<string, string>; body?: string; signal?: AbortSignal }) => Promise<{ ok: boolean; status: number }>;

export interface TelegramDeps {
  botToken: string;
  chatId: string;
  /** Injectable for tests; defaults to global fetch (Node 18+). */
  fetchImpl?: FetchLike;
  timeoutMs?: number;
  log?: (msg: string, meta?: unknown) => void;
}

const DEFAULT_TIMEOUT_MS = 5_000;

/** Send one message. Resolves false on any failure — never throws (§11 fire-and-forget). */
export async function sendTelegram(deps: TelegramDeps, text: string): Promise<boolean> {
  const log = deps.log ?? (() => {});
  const fetchImpl = deps.fetchImpl ?? (fetch as unknown as FetchLike);
  const controller = new AbortController();
  const timer = setTimeout(() => controller.abort(), deps.timeoutMs ?? DEFAULT_TIMEOUT_MS);
  try {
    const res = await fetchImpl(`https://api.telegram.org/bot${deps.botToken}/sendMessage`, {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ chat_id: deps.chatId, text, parse_mode: 'HTML' }),
      signal: controller.signal,
    });
    if (!res.ok) log('telegram send rejected', { status: res.status });
    return res.ok;
  } catch (e) {
    log('telegram send failed', { err: String(e) });
    return false;
  } finally {
    clearTimeout(timer);
  }
}

interface SlTpPayload { positionId: string; price: number }
interface OpenedPayload {
  positionId: string; predictionId: string; symbol: string;
  direction: string; price: number; size: number;
}
interface WalletExitPayload {
  positionId: string; mint: string; accumulator: number; threshold: number;
  closePrice: number | null; triggeringWallet: string;
}

/** Shorten a long identifier for the alert (e.g. Solana mint) — first 4 · last 4 with ellipsis. */
function shortSymbol(s: string): string {
  return s.length > 12 ? `${s.slice(0, 4)}…${s.slice(-4)}` : s;
}

/** Format one §11-eligible event into a message, or null for everything else (clean feed). */
export function formatAlert(event: DomainEvent): string | null {
  switch (event.type) {
    case EVENT_NAMES.PAPER_TRADE_OPENED: {
      const p = event.payload as OpenedPayload;
      // §11 clean-feed exception: entry receipts DO reach Telegram — an open is a real fill,
      // same category as an SL/TP hit. Perp shows BTCUSDT-style symbols; memecoin shows a
      // shortened mint. Direction is LONG/SHORT (perp) or LONG (memecoin, always long).
      const arrow = p.direction === 'LONG' ? '🟢' : '🔴';
      return `${arrow} <b>${p.direction} OPENED</b>\n<code>${shortSymbol(p.symbol)}</code> @ ${p.price} · size ${p.size}\nposition <code>${p.positionId}</code>`;
    }
    case EVENT_NAMES.PAPER_TRADE_SL_HIT: {
      const p = event.payload as SlTpPayload;
      return `🛑 <b>STOP LOSS</b>\nposition <code>${p.positionId}</code> closed @ ${p.price}`;
    }
    case EVENT_NAMES.PAPER_TRADE_TP_HIT: {
      const p = event.payload as SlTpPayload;
      return `🎯 <b>TAKE PROFIT</b>\nposition <code>${p.positionId}</code> closed @ ${p.price}`;
    }
    case EVENT_NAMES.MEMECOIN_WALLET_EXIT_DETECTED: {
      const p = event.payload as WalletExitPayload;
      return `🐋 <b>WALLET EXIT</b>\n<code>${shortSymbol(p.mint)}</code> — cluster ${(p.accumulator * 100).toFixed(0)}% exited (threshold ${(p.threshold * 100).toFixed(0)}%)\nposition <code>${p.positionId}</code> closed @ ${p.closePrice ?? '?'}`;
    }
    default:
      return null;
  }
}

/**
 * Handler for the shared signal-processing dispatcher. Fire-and-forget by design: the send is
 * intentionally NOT awaited, so a slow/down Telegram never delays the queue (§11). The returned
 * promise resolves immediately.
 */
export function createTelegramAlertHandler(deps: TelegramDeps): (event: DomainEvent) => Promise<void> {
  return async (event: DomainEvent): Promise<void> => {
    const text = formatAlert(event);
    if (text === null) return;
    void sendTelegram(deps, text); // documented fire-and-forget exception (§11)
  };
}
