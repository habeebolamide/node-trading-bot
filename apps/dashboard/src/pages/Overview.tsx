import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { useOverview } from '@/hooks/useOverview';

function Kpi({ label, value }: { label: string; value: string | number }) {
  return (
    <Card>
      <CardHeader className="text-neutral-400">{label}</CardHeader>
      <CardBody className="text-2xl font-semibold tabular-nums">{value}</CardBody>
    </Card>
  );
}

/** Landing dashboard — four KPI cards over /api/overview. Not a real analytical page; the
 *  real analysis lives on Performance + LLM Review. */
export function Overview() {
  const q = useOverview();
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Overview</h1>
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        {q.isLoading ? (
          Array.from({ length: 4 }).map((_, i) => <Skeleton key={i} className="h-24" />)
        ) : q.isError ? (
          <div className="col-span-4 text-sm text-red-300">API error: {(q.error as { message?: string }).message ?? 'unknown'}</div>
        ) : q.data ? (
          <>
            <Kpi label="Open signals" value={q.data.openSignals} />
            <Kpi label="Signals last 24h" value={q.data.signalsLast24h} />
            <Kpi label="Predictions last 7d" value={q.data.predictionsLast7d} />
            <Kpi label="Total paper equity" value={`$${q.data.totalEquity.toFixed(2)}`} />
          </>
        ) : null}
      </div>
      <p className="mt-8 text-sm text-neutral-500">
        The dashboard reads what M1–M7 built. Nothing here writes — every button that looks
        like an action is a filter, a link, or a copy for an operator command.
      </p>
    </div>
  );
}
