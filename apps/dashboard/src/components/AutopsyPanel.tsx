import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { apiGet, apiPost, type ApiError } from '@/lib/api';

interface Eligible { eligible: number; estimatedCost: number }
interface AutoTune {
  hypothesesOpened: number; hypothesesSkipped: number;
  backtested: number; backtestPassed: number; backtestRejected: number;
  oosPassed: number; oosFailed: number;
  promoted: number; deferredBootstrap: number;
  newConfigVersion: number | null;
  changes: { agentKey: string; delta: number; reason: string }[];
}
interface Job {
  state: 'running' | 'done' | 'failed';
  startedAt: string; finishedAt?: string;
  eligible: number;
  progress: { done: number; failed: number; total: number; dollarsSpent: number };
  autoTune?: AutoTune;
  error?: string;
}

/**
 * "Run Autopsy + Auto-Tune" — the §24 one-click flow.
 *
 *   1) Bulk autopsy: LLM tags every eligible closed real prediction with a root-cause
 *      (batches of 25, joined on prediction_id).
 *   2) Aggregate + propose: buckets tags into candidate weight deltas (effective-n ≥ 20).
 *   3) Backtest + OOS: proportional-window check against per-agent hit rates (Wilson-CI vs 50%).
 *   4) Promote: hypotheses that pass both windows write a new scoring_config version. Bootstrap
 *      guard defers if the domain isn't mature enough.
 *
 * Perp-only in MVP (§24 memecoin exclusion). Requires DEEPSEEK_API_KEY on the API.
 */
export function AutopsyPanel({ agentId, domain }: { agentId: string; domain: string }) {
  const qc = useQueryClient();
  const [showConfirm, setShowConfirm] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  const eligible = useQuery({
    enabled: domain === 'perp',
    queryKey: ['autopsy.eligible', agentId],
    queryFn: () => apiGet<Eligible>(`/../trading-agents/${agentId}/autopsy/eligible`),
  });
  const status = useQuery({
    enabled: domain === 'perp',
    queryKey: ['autopsy.status', agentId],
    queryFn: () => apiGet<{ job: Job | null }>(`/../trading-agents/${agentId}/autopsy/status`),
    refetchInterval: (q) => (q.state.data?.job?.state === 'running' ? 3_000 : false),
  });

  if (domain !== 'perp') {
    return (
      <Card>
        <CardHeader>Autopsy + Auto-Tune</CardHeader>
        <CardBody className="text-sm text-neutral-500">
          Perp only in MVP — memecoin autopsy unlocks when memecoin gets a backtest (§24).
        </CardBody>
      </Card>
    );
  }

  const job = status.data?.job;
  const running = job?.state === 'running';
  const eligibleN = eligible.data?.eligible ?? 0;
  const estCost = eligible.data?.estimatedCost ?? 0;

  return (
    <>
      <Card className="mb-4">
        <CardHeader className="flex items-center justify-between">
          <span>Autopsy + Auto-Tune (§24)</span>
          {job && (
            <Badge tone={job.state === 'running' ? 'info' : job.state === 'done' ? 'success' : 'danger'}>
              {job.state}
            </Badge>
          )}
        </CardHeader>
        <CardBody>
          {eligible.isLoading ? <Skeleton className="h-12" /> : (
            <>
              <p className="mb-3 text-sm text-neutral-300">
                <strong className="tabular-nums">{eligibleN}</strong> closed real predictions
                ready for autopsy · estimated cost{' '}
                <strong className="tabular-nums">${estCost.toFixed(4)}</strong> (DeepSeek V4-Flash)
              </p>
              {!running && (
                <button
                  disabled={eligibleN === 0 || starting}
                  onClick={() => setShowConfirm(true)}
                  className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-cyan-300 disabled:opacity-40">
                  {starting ? 'Starting…' : eligibleN === 0 ? 'Nothing to autopsy' : `Run Autopsy + Auto-Tune ($${estCost.toFixed(2)})`}
                </button>
              )}
              {running && job && (
                <div className="space-y-2 text-sm">
                  <p className="text-amber-300">
                    Autopsying {job.progress.done + job.progress.failed} / {job.progress.total}
                    {' '}(${job.progress.dollarsSpent.toFixed(4)} spent)
                  </p>
                  <div className="h-2 w-full overflow-hidden rounded-full bg-neutral-900">
                    <div className="h-full bg-accent transition-all"
                      style={{ width: `${Math.min(100, ((job.progress.done + job.progress.failed) / Math.max(1, job.progress.total)) * 100)}%` }} />
                  </div>
                </div>
              )}
              {error && <p className="mt-2 text-xs text-red-300">{error}</p>}
              {job?.error && <p className="mt-2 text-xs text-red-300">Last error: {job.error}</p>}
            </>
          )}
        </CardBody>
      </Card>

      {job?.state === 'done' && job.autoTune && <AutoTuneSummary tune={job.autoTune} />}

      {showConfirm && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
             onClick={() => setShowConfirm(false)}>
          <div className="max-w-lg rounded-lg border border-neutral-800 bg-neutral-950 p-6 text-sm"
               onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-2 text-base font-semibold">Run Autopsy + Auto-Tune?</h2>
            <p className="mb-3 text-neutral-300">
              {eligibleN} predictions · est. ${estCost.toFixed(4)}. This will:
            </p>
            <ol className="mb-3 space-y-1 pl-4 text-xs text-neutral-400 list-decimal">
              <li>LLM-tag each prediction's root cause (writes <code>trade_autopsy</code>).</li>
              <li>Cluster tags into weight-change hypotheses (effective-n ≥ 20).</li>
              <li>Backtest each on the last 15 days (proportional 11d train / 4d OOS).</li>
              <li>Promote hypotheses that pass BOTH windows to a new <code>scoring_config</code> version.</li>
            </ol>
            <p className="mb-3 text-xs text-amber-300">
              ⚠ New signals will score under the promoted config. Old versions stay in the version
              history — you can switch back on the Configuration tab.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setShowConfirm(false)}
                className="rounded-md border border-neutral-800 px-3 py-1 text-xs hover:border-neutral-600">
                Cancel
              </button>
              <button
                disabled={starting}
                onClick={() => {
                  setError(null); setStarting(true); setShowConfirm(false);
                  apiPost(`/../trading-agents/${agentId}/autopsy/run`, {})
                    .then(() => qc.invalidateQueries({ queryKey: ['autopsy.status', agentId] }))
                    .catch((e: ApiError) => setError(e.message))
                    .finally(() => setStarting(false));
                }}
                className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-neutral-950 hover:bg-cyan-300 disabled:opacity-50">
                Run — ${estCost.toFixed(4)}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function AutoTuneSummary({ tune }: { tune: AutoTune }) {
  const anyChange = tune.promoted > 0;
  return (
    <Card className="mb-4">
      <CardHeader className="flex items-center gap-2">
        <span>Auto-tune result</span>
        <Badge tone={anyChange ? 'success' : 'neutral'}>
          {anyChange ? `v${tune.newConfigVersion} promoted` : 'no changes'}
        </Badge>
      </CardHeader>
      <CardBody className="space-y-2 text-sm">
        <div className="grid grid-cols-2 gap-2 text-xs text-neutral-400 md:grid-cols-4">
          <div>Hypotheses opened: <span className="text-neutral-100 tabular-nums">{tune.hypothesesOpened}</span></div>
          <div>Backtested: <span className="text-neutral-100 tabular-nums">{tune.backtested}</span></div>
          <div>Passed: <span className="text-emerald-300 tabular-nums">{tune.backtestPassed}</span></div>
          <div>Rejected: <span className="text-red-300 tabular-nums">{tune.backtestRejected}</span></div>
          <div>OOS passed: <span className="text-emerald-300 tabular-nums">{tune.oosPassed}</span></div>
          <div>OOS failed: <span className="text-red-300 tabular-nums">{tune.oosFailed}</span></div>
          <div>Promoted: <span className="text-emerald-300 tabular-nums">{tune.promoted}</span></div>
          <div>Deferred (bootstrap): <span className="text-amber-300 tabular-nums">{tune.deferredBootstrap}</span></div>
        </div>
        {tune.changes.length > 0 && (
          <div className="mt-3 border-t border-neutral-800 pt-2">
            <div className="mb-1 text-xs uppercase tracking-wider text-neutral-500">Weight changes applied</div>
            <ul className="space-y-1 text-xs">
              {tune.changes.map((c, i) => (
                <li key={i} className="font-mono">
                  <span className="text-neutral-400">{c.agentKey}</span>{' '}
                  <span className={c.delta > 0 ? 'text-emerald-300' : 'text-red-300'}>{c.delta > 0 ? '+' : ''}{(c.delta * 100).toFixed(1)}%</span>{' '}
                  <span className="text-neutral-500">— {c.reason}</span>
                </li>
              ))}
            </ul>
          </div>
        )}
        {!anyChange && (
          <p className="text-xs text-neutral-500">
            Nothing promoted this run. Common reasons: no eligible autopsies clustered above
            effective-n 20, direction of change didn't match agent's per-agent hit rate, or the
            evaluation window was too thin (deferred). Autopsies are recorded regardless — see
            the LLM Review tab for full detail.
          </p>
        )}
      </CardBody>
    </Card>
  );
}
