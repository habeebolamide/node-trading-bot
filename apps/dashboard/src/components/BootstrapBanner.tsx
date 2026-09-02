import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

interface BootstrapStatus { n: number; bootstrapping: boolean; message: string }

/**
 * §32 truth-in-labeling (audit #18): metrics rendered during the bootstrap window must SAY so —
 * an operator reading a 70% win rate off n=6 without this banner is the failure mode. Rendered
 * wherever version-scoped metrics are shown (Performance, Backtests).
 */
export function BootstrapBanner({ domain, configVersion, horizon }: { domain: string; configVersion: number; horizon: string }) {
  const q = useQuery({
    queryKey: ['bootstrap', domain, configVersion, horizon],
    queryFn: () => apiGet<BootstrapStatus>(`/metrics/bootstrap?domain=${domain}&configVersion=${configVersion}&horizon=${encodeURIComponent(horizon)}`),
  });
  if (!q.data?.bootstrapping) return null;
  return (
    <div className="mb-4 rounded-md border border-amber-700/50 bg-amber-950/40 px-3 py-2 text-sm text-amber-300">
      <span className="font-semibold">Bootstrap window:</span> only {q.data.n} resolved prediction{q.data.n === 1 ? '' : 's'} for
      config v{configVersion} @ {horizon} — every number below is a small-sample read. {q.data.message}
    </div>
  );
}
