import { useMemo, useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { useAgents } from '@/hooks/useAgents';
import { useByHorizon, useCalibration } from '@/hooks/useMetrics';
import { BootstrapBanner } from '@/components/BootstrapBanner';

/** Performance page — pick an agent → per-horizon metrics + a Brier + reliability diagram. */
export function Performance() {
  const agents = useAgents();
  const [agentId, setAgentId] = useState<string>('');
  const agent = useMemo(() => (agents.data ?? []).find((a) => a.id === agentId), [agents.data, agentId]);
  const horizons = agent ? (agent.tradingStyle === 'day' ? '1h,4h,EOD' : agent.tradingStyle === 'scalp' ? '5m,15m,30m' : '1d,3d,1w') : '';

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Performance</h1>
      <Card className="mb-4">
        <CardHeader>Pick an agent</CardHeader>
        <CardBody>
          {agents.isLoading ? <Skeleton className="h-8 w-72" /> : (
            <select
              value={agentId}
              onChange={(e) => setAgentId(e.target.value)}
              className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm"
            >
              <option value="">— select —</option>
              {(agents.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name} · {a.domain} · v{a.activeConfigVersion}</option>
              ))}
            </select>
          )}
        </CardBody>
      </Card>
      {agent && (
        <div className="space-y-4">
          <BootstrapBanner domain={agent.domain} configVersion={agent.activeConfigVersion}
            horizon={agent.tradingStyle === 'day' ? '4h' : agent.tradingStyle === 'scalp' ? '15m' : '3d'} />
          <HorizonPanel domain={agent.domain} configVersion={agent.activeConfigVersion} horizons={horizons} />
          <CalibrationPanel domain={agent.domain} configVersion={agent.activeConfigVersion} horizon={agent.tradingStyle === 'day' ? '4h' : agent.tradingStyle === 'scalp' ? '15m' : '3d'} />
        </div>
      )}
    </div>
  );
}

function HorizonPanel({ domain, configVersion, horizons }: { domain: string; configVersion: number; horizons: string }) {
  const q = useByHorizon({ domain, configVersion, horizons });
  if (q.isLoading) return <Skeleton className="h-40" />;
  const rows = q.data?.rows ?? [];
  return (
    <Card>
      <CardHeader>Metrics by horizon</CardHeader>
      <Table>
        <Thead><Tr><Th>Horizon</Th><Th>n</Th><Th>Accuracy</Th><Th>Median return</Th><Th>Mean alpha</Th><Th>Max drawdown</Th></Tr></Thead>
        <Tbody>
          {rows.map((m) => (
            <Tr key={m.horizon}>
              <Td>{m.horizon}</Td>
              <Td className="tabular-nums">{m.n}</Td>
              <Td className="tabular-nums">{m.accuracy === null ? '—' : (m.accuracy * 100).toFixed(1) + '%'}</Td>
              <Td className="tabular-nums">{m.medianReturn === null ? '—' : (m.medianReturn * 100).toFixed(2) + '%'}</Td>
              <Td className="tabular-nums">{m.meanAlpha === null ? '—' : (m.meanAlpha * 100).toFixed(2) + '%'}</Td>
              <Td className="tabular-nums">{m.maxDrawdown === null ? '—' : (m.maxDrawdown * 100).toFixed(2) + '%'}</Td>
            </Tr>
          ))}
          {rows.length === 0 && <Tr><Td colSpan={6} className="text-neutral-500">No resolved predictions yet at these horizons.</Td></Tr>}
        </Tbody>
      </Table>
    </Card>
  );
}

function CalibrationPanel({ domain, configVersion, horizon }: { domain: string; configVersion: number; horizon: string }) {
  const q = useCalibration({ domain, configVersion, horizon, bins: 10 });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data) return null;
  const width = 400; const height = 220; const pad = 24;
  const scaleX = (x: number) => pad + x * (width - pad * 2);
  const scaleY = (y: number) => height - pad - y * (height - pad * 2);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span>Calibration (planning horizon {horizon})</span>
        <span className="text-xs text-neutral-400">
          Brier {q.data.brier === null ? '—' : q.data.brier.toFixed(3)} · ECE {q.data.ece === null ? '—' : q.data.ece.toFixed(3)} · n {q.data.n}
        </span>
      </CardHeader>
      <CardBody>
        <svg viewBox={`0 0 ${width} ${height}`} className="w-full">
          {/* Diagonal (perfect calibration reference). */}
          <line x1={scaleX(0)} y1={scaleY(0)} x2={scaleX(1)} y2={scaleY(1)} stroke="#374151" strokeDasharray="4 4" />
          <rect x={pad} y={pad} width={width - pad * 2} height={height - pad * 2} fill="none" stroke="#1f2937" />
          {q.data.bins.filter((b) => b.winRate !== null).map((b) => (
            <g key={b.binIndex}>
              {b.wilsonLower !== null && b.wilsonUpper !== null && (
                <line
                  x1={scaleX(b.midpoint)} x2={scaleX(b.midpoint)}
                  y1={scaleY(b.wilsonLower)} y2={scaleY(b.wilsonUpper)}
                  stroke="#22d3ee" strokeWidth={1}
                />
              )}
              <circle cx={scaleX(b.midpoint)} cy={scaleY(b.winRate!)} r={Math.max(2, Math.min(6, Math.sqrt(b.n)))} fill="#22d3ee" />
            </g>
          ))}
          {/* Axis labels */}
          <text x={width / 2} y={height - 4} textAnchor="middle" className="text-[10px]" fill="#9ca3af">stated confidence</text>
          <text x={8} y={height / 2} textAnchor="middle" transform={`rotate(-90 8 ${height / 2})`} className="text-[10px]" fill="#9ca3af">observed win rate</text>
        </svg>
        <p className="mt-2 text-xs text-neutral-500">
          Dot size scales with bin n. Vertical lines are 95% Wilson intervals on each bin's observed win rate.
          A well-calibrated model tracks the dashed diagonal.
        </p>
      </CardBody>
    </Card>
  );
}
