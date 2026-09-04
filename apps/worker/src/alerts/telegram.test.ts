import { describe, it, expect, vi } from 'vitest';
import { EVENT_NAMES } from '@tip/events';
import type { DomainEvent } from '@tip/domain';
import { createTelegramAlertHandler, formatAlert, sendTelegram, type FetchLike } from './telegram.js';

function event(type: string, payload: unknown): DomainEvent {
  return { id: 'e', type, version: 1, eventTime: 't', processingTime: 't', source: 's', payload };
}

describe('telegram alerts (§11 — audit #12)', () => {
  it('formats SL / TP / OPEN / wallet-exit; everything else is null (clean-feed rule)', () => {
    expect(formatAlert(event(EVENT_NAMES.PAPER_TRADE_SL_HIT, { positionId: 'p1', price: 99 }))).toContain('STOP LOSS');
    expect(formatAlert(event(EVENT_NAMES.PAPER_TRADE_TP_HIT, { positionId: 'p1', price: 120 }))).toContain('TAKE PROFIT');
    expect(formatAlert(event(EVENT_NAMES.MEMECOIN_WALLET_EXIT_DETECTED, {
      positionId: 'p1', mint: 'M', accumulator: 0.95, threshold: 0.9, closePrice: 0.0008, triggeringWallet: 'w',
    }))).toContain('WALLET EXIT');
    // Signals, observations, judge chatter never reach Telegram (§11 clean feed).
    expect(formatAlert(event(EVENT_NAMES.SIGNAL_CREATED, {}))).toBeNull();
    expect(formatAlert(event(EVENT_NAMES.JUDGE_EVALUATION_COMPLETED, {}))).toBeNull();
  });

  it('OPENED alert: perp LONG (green) shows the full symbol', () => {
    const msg = formatAlert(event(EVENT_NAMES.PAPER_TRADE_OPENED, {
      positionId: 'pos-1', predictionId: 'pred-1', symbol: 'BTCUSDT',
      direction: 'LONG', price: 100_000, size: 0.01,
    }))!;
    expect(msg).toContain('LONG OPENED');
    expect(msg).toContain('🟢');
    expect(msg).toContain('BTCUSDT');
    expect(msg).toContain('100000');
    expect(msg).toContain('pos-1');
  });

  it('OPENED alert: perp SHORT is red', () => {
    const msg = formatAlert(event(EVENT_NAMES.PAPER_TRADE_OPENED, {
      positionId: 'pos-2', predictionId: 'pred-2', symbol: 'ETHUSDT',
      direction: 'SHORT', price: 3500, size: 0.1,
    }))!;
    expect(msg).toContain('SHORT OPENED');
    expect(msg).toContain('🔴');
  });

  it('OPENED alert: memecoin mints get truncated as first4…last4', () => {
    const msg = formatAlert(event(EVENT_NAMES.PAPER_TRADE_OPENED, {
      positionId: 'pos-3', predictionId: 'pred-3',
      symbol: 'So11111111111111111111111111111111111111112', // Wrapped SOL mint
      direction: 'LONG', price: 0.00005, size: 1_000_000,
    }))!;
    expect(msg).toContain('So11…1112');
    expect(msg).not.toContain('So1111111111111111');
  });

  it('sendTelegram never throws — §11 fire-and-forget: outage returns false', async () => {
    const failing: FetchLike = async () => { throw new Error('network down'); };
    const ok = await sendTelegram({ botToken: 't', chatId: 'c', fetchImpl: failing }, 'x');
    expect(ok).toBe(false);

    const rejected: FetchLike = async () => ({ ok: false, status: 429 });
    expect(await sendTelegram({ botToken: 't', chatId: 'c', fetchImpl: rejected }, 'x')).toBe(false);
  });

  it('handler resolves immediately without awaiting the send (queue never blocked)', async () => {
    let resolveSend: (() => void) | undefined;
    const slow: FetchLike = () => new Promise((res) => { resolveSend = () => res({ ok: true, status: 200 }); });
    const spy = vi.fn(slow);
    const handler = createTelegramAlertHandler({ botToken: 't', chatId: 'c', fetchImpl: spy });
    await handler(event(EVENT_NAMES.PAPER_TRADE_SL_HIT, { positionId: 'p1', price: 99 })); // resolves while fetch pending
    expect(spy).toHaveBeenCalledOnce();
    resolveSend!();
  });

  it('handler sends nothing for non-alert events', async () => {
    const spy = vi.fn<FetchLike>(async () => ({ ok: true, status: 200 }));
    const handler = createTelegramAlertHandler({ botToken: 't', chatId: 'c', fetchImpl: spy });
    await handler(event(EVENT_NAMES.SIGNAL_CREATED, {}));
    expect(spy).not.toHaveBeenCalled();
  });
});
