import { Badge } from '@/components/ui/Badge';
import type { PredictionRow } from '@/hooks/usePredictions';

/**
 * Outcome badge for the predictions list — tone-coded close reason + realized P&L. Rendered on
 * both the top-level Predictions page and the per-agent Predictions tab in AgentTabs.
 *
 * States:
 *   - no position          — the entry orchestrator didn't open one (unusual)
 *   - PENDING_ENTRY        — LIMIT order still waiting
 *   - OPEN                 — position is live
 *   - EXPIRED              — LIMIT window elapsed unfilled
 *   - CLOSED / closeReason — the specific exit that fired (SL / TP / horizon / wallet exit /
 *                            limit expiry)
 */
export function PredictionOutcome({ p }: { p: PredictionRow }) {
  if (p.positionState === null) return <span className="text-neutral-500 text-xs">no position</span>;
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
