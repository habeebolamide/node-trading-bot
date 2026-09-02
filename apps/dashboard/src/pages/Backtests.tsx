import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { BootstrapBanner } from '@/components/BootstrapBanner';
import { useAgents } from '@/hooks/useAgents';
import { apiGet } from '@/lib/api';

interface FoldRow {
  fold: { index: number; trainStart: string; trainEnd: string; testStart: string; testEnd: string };
  metrics: {
    n: number; accuracy: number | null; medianReturn: number | null;
    meanAlpha: number | null; maxDrawdown: number | null;
  } | null;
}
interface WalkForwardResponse { folds: FoldRow[]; configVersion: number; horizon: string }

const HORIZON_BY_STYLE: Record<string, string> = { scalp: '15m', day: '4h', swing: '3d' };

/**
 * Backtesting page (§26 — audit #15). Read-only walk-forward report over resolved predictions:
 * train 60d / test 20d rolling folds (Task 7), metrics computed on TEST windows only. Perp only —
 * memecoin has no historical backtest in MVP (§25), which the API surfaces as a 400.
 */
export function Backtests() {
  const agents = useAgents();
  const [agentId, setAgentId] = useState('');
  const [days, setDays] = useState(180);
  const agent = useMemo(() => (agents.data ?? []).find((a) => a.id === agentId), [agents.data, agentId]);
  const horizon = agent ? HORIZON_BY_STYLE[agent.tradingStyle] ?? '4h' : '4h';

  const q = useQuery({
    enabled: !!agent && agent.domain === 'perp',
    queryKey: ['walk-forward', agentId, days],
    queryFn: () => apiGet<WalkForwardResponse>(
      `/backtest/walk-forward?configVersion=${agent!.activeConfigVersion}&horizon=${encodeURIComponent(horizon)}&from=${new Date(Date.now() - days * 864e5).toISOString()}`,
    ),
  });

  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%');
  const day = (s: string) => s.slice(0, 10);

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Backtests</h1>
      <Card className="mb-4">
        <CardHeader>Walk-forward report (train 60d / test 20d, metrics on test windows only)</CardHeader>
        <CardBody className="flex flex-wrap items-center gap-3">
          {agents.isLoading ? <Skeleton className="h-8 w-72" /> : (
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}
              className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm">
              <option value="">— select agent —</option>
              {(agents.data ?? []).filter((a) => a.domain === 'perp').map((a) => (
                <option key={a.id} value={a.id}>{a.name} · v{a.activeConfigVersion}</option>
              ))}
            </select>
          )}
          <select value={days} onChange={(e) => setDays(Number(e.target.value))}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm">
            <option value={120}>last 120 days</option>
            <option value={180}>last 180 days</option>
            <option value={365}>last 365 days</option>
          </select>
          <span className="text-xs text-neutral-500">horizon {horizon} · perp only (§25 — memecoin has no historical backtest)</span>
        </CardBody>
      </Card>

      {agent && <BootstrapBanner domain={agent.domain} configVersion={agent.activeConfigVersion} horizon={horizon} />}

      {q.isLoading && <Skeleton className="h-48" />}
      {q.data && (
        <Card>
          <CardHeader>{q.data.folds.length} fold{q.data.folds.length === 1 ? '' : 's'}</CardHeader>
          {q.data.folds.length === 0 ? (
            <CardBody className="text-sm text-neutral-500">
              Window too short for a single 80-day fold — widen the range, or wait for more history.
            </CardBody>
          ) : (
            <Table>
              <Thead><Tr><Th>#</Th><Th>Train</Th><Th>Test</Th><Th>n</Th><Th>Accuracy</Th><Th>Median return</Th><Th>Mean alpha</Th><Th>Max drawdown</Th></Tr></Thead>
              <Tbody>
                {q.data.folds.map((f) => (
                  <Tr key={f.fold.index}>
                    <Td className="tabular-nums">{f.fold.index}</Td>
                    <Td className="tabular-nums text-xs">{day(f.fold.trainStart)} → {day(f.fold.trainEnd)}</Td>
                    <Td className="tabular-nums text-xs">{day(f.fold.testStart)} → {day(f.fold.testEnd)}</Td>
                    <Td className="tabular-nums">{f.metrics?.n ?? 0}</Td>
                    <Td className="tabular-nums">{pct(f.metrics?.accuracy)}</Td>
                    <Td className="tabular-nums">{pct(f.metrics?.medianReturn)}</Td>
                    <Td className="tabular-nums">{pct(f.metrics?.meanAlpha)}</Td>
                    <Td className="tabular-nums">{pct(f.metrics?.maxDrawdown)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>
      )}
    </div>
  );
}
