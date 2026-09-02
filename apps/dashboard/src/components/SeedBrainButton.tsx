import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { apiGet, apiPost, type ApiError } from '@/lib/api';

interface SeedJob {
  state: 'running' | 'done' | 'failed';
  dryRun: boolean;
  error?: string;
  report?: { totals: { predictionsCreated: number; stepsWalked: number }; trustFraction: number; warnings: string[] };
}
export interface SeedingStatuses {
  statuses: Record<string, { seeded: boolean; running: boolean; job: SeedJob | null }>;
}

/** One status call feeds every row's button; poll while any run is live. */
export function useSeedingStatuses(enabled = true) {
  return useQuery({
    enabled,
    queryKey: ['seeding.status'],
    queryFn: () => apiGet<SeedingStatuses>('/../trading-agents/seeding/status'),
    refetchInterval: (q) =>
      Object.values(q.state.data?.statuses ?? {}).some((s) => s.running) ? 4_000 : false,
  });
}

/**
 * §25 one-button Brain seeding for one agent's own coin. Renders ONLY while un-seeded (operator
 * spec): seeded agents show a small check, running ones a progress note, and a POST rejected
 * for missing candles surfaces the API's exact message — `No backfill for this token`.
 */
export function SeedBrainButton({ agentId, domain, status }: {
  agentId: string;
  domain: string;
  status: { seeded: boolean; running: boolean; job: SeedJob | null } | undefined;
}) {
  const qc = useQueryClient();
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);

  if (domain !== 'perp') return <span className="text-neutral-600">—</span>; // §25: perp only

  if (status?.running) return <span className="text-xs text-amber-300">Seeding…</span>;
  if (status?.job?.state === 'failed') {
    return <span className="text-xs text-red-300" title={status.job.error}>seed failed — retry below</span>;
  }
  if (status?.seeded) {
    const t = status.job?.report?.trustFraction;
    return (
      <span className="text-xs text-emerald-300">
        Seeded ✓{t !== undefined ? ` · trust ${(t * 100).toFixed(0)}%` : ''}
      </span>
    );
  }

  return (
    <span className="flex flex-col gap-1">
      <button
        disabled={starting}
        onClick={() => {
          setError(null);
          setStarting(true);
          apiPost(`/../trading-agents/${agentId}/seed`, {})
            .then(() => qc.invalidateQueries({ queryKey: ['seeding.status'] }))
            .catch((e: ApiError) => setError(e.message))
            .finally(() => setStarting(false));
        }}
        className="rounded-md border border-accent/60 px-2 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50"
      >
        {starting ? 'Starting…' : 'Seed Brain'}
      </button>
      {error && <span className="text-xs text-red-300">{error}</span>}
    </span>
  );
}
