import { Badge } from '@/components/ui/Badge';
import type { PredictionRow } from '@/hooks/usePredictions';

/**
 * Outcome badge for the predictions list — tone-coded exit + realized P&L. Two data sources
 * feed it, in priority order:
 *
 *   1. LIVE — a paper_position row exists (the entry orchestrator opened one). Reads
 *      positionState + closeReason + realizedPnl. Handles OPEN / PENDING_ENTRY / EXPIRED /
 *      CLOSED with the specific closeReason (SL / TP / horizon / wallet exit / limit expiry).
 *
 *   2. SEEDED — no position (npm run seed-brain / the Seed Brain button never opens paper
 *      positions per §25; it resolves the counterfactual against 1m candles). Reads
 *      prediction_outcome (primary horizon): won + hitTarget + returnPct. Tone-coded so a
 *      seeded WIN with hitTarget looks like a live TP hit, a WIN via horizon looks like a
 *      horizon expiry, and a LOSS looks like a stop.
 *
 * Everything else — the prediction has no position AND no resolved outcome — shows a neutral
 * "no outcome" hint. Rarely legitimate: an in-flight LIVE entry between prediction insert and
 * position open, or a seed run whose outcome sweep hasn't caught up.
 */
export function PredictionOutcome({ p }: { p: PredictionRow }) {
  // 1) LIVE — paper_position exists.
  if (p.positionState !== null) {
    if (p.positionState === 'PENDING_ENTRY') return <Badge tone="warn">pending limit</Badge>;
    if (p.positionState === 'OPEN') return <Badge tone="info">open</Badge>;
    if (p.positionState === 'EXPIRED') return <Badge tone="neutral">limit expired</Badge>;
    const reason = p.closeReason;
    const tone = reason === 'TAKE_PROFIT' ? 'success'
               : reason === 'STOP_LOSS' ? 'danger'
               : reason === 'WALLET_EXIT' ? 'warn'
               : 'neutral';
    const label = reason === 'TAKE_PROFIT' ? 'TP hit'
               : reason === 'STOP_LOSS' ? 'SL hit'
               : reason === 'HORIZON_EXPIRY' ? 'horizon'
               : reason === 'WALLET_EXIT' ? 'wallet exit'
               : reason === 'LIMIT_EXPIRY' ? 'limit expired'
               : (reason ?? 'closed');
    const pnl = p.realizedPnl !== null ? Number(p.realizedPnl) : null;
    return (
      <span className="flex items-center gap-2">
        <Badge tone={tone}>{label}</Badge>
        {pnl !== null && (
          <span className={`tabular-nums text-xs ${pnl > 0 ? 'text-emerald-300' : pnl < 0 ? 'text-red-300' : 'text-neutral-400'}`}>
            {pnl > 0 ? '+' : ''}{pnl.toFixed(2)}
          </span>
        )}
      </span>
    );
  }
  // 2) SEEDED — prediction_outcome at the primary horizon.
  if (p.outcomeWon !== null) {
    const ret = p.outcomeReturnPct !== null ? Number(p.outcomeReturnPct) : null;
    const label = p.outcomeWon
      ? (p.outcomeHitTarget ? 'TP hit (seed)' : 'win (seed)')
      : 'loss (seed)';
    const tone = p.outcomeWon ? 'success' : 'danger';
    return (
      <span className="flex items-center gap-2" title="Seeded: resolved against historical 1m candles (§25). No paper position was opened.">
        <Badge tone={tone}>{label}</Badge>
        {ret !== null && (
          <span className={`tabular-nums text-xs ${ret > 0 ? 'text-emerald-300' : ret < 0 ? 'text-red-300' : 'text-neutral-400'}`}>
            {ret > 0 ? '+' : ''}{(ret * 100).toFixed(2)}%
          </span>
        )}
      </span>
    );
  }
  return <span className="text-neutral-500 text-xs">no outcome</span>;
}
