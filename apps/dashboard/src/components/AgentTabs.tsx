import { useState } from 'react';
import { Link } from 'react-router-dom';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { Tabs } from '@/components/ui/Tabs';
import type { AgentRow } from '@/hooks/useAgents';
import { useSignals } from '@/hooks/useSignals';
import { usePredictions } from '@/hooks/usePredictions';
import { usePortfolios, usePositions } from '@/hooks/usePortfolios';
import { useHeadline } from '@/hooks/useMetrics';
import { PredictionOutcome } from '@/components/PredictionOutcome';

const PREDICTIONS_PAGE_SIZE = 50;

/** Tabs per §26 Agent detail: Overview / Signals / Predictions / Paper Portfolio / Performance
 *  / Configuration. Each tab reads from an existing /api endpoint. */
export function AgentTabs({ agent }: { agent: AgentRow }) {
  const tabs = [
    { key: 'overview',    label: 'Overview',     content: <AgentOverview agent={agent} /> },
    { key: 'signals',     label: 'Signals',      content: <AgentSignals agentId={agent.id} /> },
    { key: 'predictions', label: 'Predictions',  content: <AgentPredictions agentId={agent.id} domain={agent.domain} /> },
    { key: 'portfolio',   label: 'Paper Portfolio', content: <AgentPortfolio agentId={agent.id} /> },
    { key: 'performance', label: 'Performance',  content: <AgentPerformance agent={agent} /> },
    { key: 'config',      label: 'Configuration', content: <AgentConfig agent={agent} /> },
  ];
  return <Tabs tabs={tabs} />;
}

function AgentOverview({ agent }: { agent: AgentRow }) {
  return (
    <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
      <Card><CardHeader>Domain</CardHeader><CardBody>{agent.domain}</CardBody></Card>
      <Card><CardHeader>Style</CardHeader><CardBody>{agent.tradingStyle}</CardBody></Card>
      <Card><CardHeader>Active config</CardHeader><CardBody>v{agent.activeConfigVersion}</CardBody></Card>
      <Card><CardHeader>Universe</CardHeader><CardBody className="text-sm">{agent.universe.join(', ')}</CardBody></Card>
    </div>
  );
}

function AgentSignals({ agentId }: { agentId: string }) {
  const q = useSignals({ agentId, limit: 100 });
  if (q.isLoading) return <Skeleton className="h-40" />;
  return (
    <Card>
      <Table>
        <Thead><Tr><Th>Symbol</Th><Th>Direction</Th><Th>Score</Th><Th>Conf</Th><Th>State</Th><Th>Created</Th></Tr></Thead>
        <Tbody>
          {(q.data?.rows ?? []).map((s) => (
            <Tr key={s.id}>
              <Td>{s.symbol}</Td>
              <Td>{s.direction}</Td>
              <Td className="tabular-nums">{Number(s.compositeScore).toFixed(2)}</Td>
              <Td className="tabular-nums">{Number(s.confidence).toFixed(2)}</Td>
              <Td><StateBadge state={s.state} /></Td>
              <Td className="text-neutral-400">{new Date(s.createdAt).toISOString()}</Td>
            </Tr>
          ))}
          {(q.data?.rows ?? []).length === 0 && <Tr><Td colSpan={6} className="text-neutral-500">No signals yet.</Td></Tr>}
        </Tbody>
      </Table>
    </Card>
  );
}

function AgentPredictions({ agentId, domain }: { agentId: string; domain: string }) {
  const [offset, setOffset] = useState(0);
  const q = usePredictions({ agentId, domain, limit: PREDICTIONS_PAGE_SIZE, offset });
  const total = q.data?.total ?? 0;
  const shown = q.data?.rows.length ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const hasPrev = offset > 0;
  const hasNext = offset + shown < total;

  if (q.isLoading && !q.data) return <Skeleton className="h-40" />;
  return (
    <Card>
      <Table>
        <Thead><Tr>
          <Th>Symbol</Th><Th>Direction</Th><Th>Entry</Th><Th>SL</Th><Th>TP</Th><Th>R:R</Th>
          <Th>Outcome</Th><Th>Real?</Th><Th>Created</Th>
        </Tr></Thead>
        <Tbody>
          {(q.data?.rows ?? []).map((p) => (
            <Tr key={p.id}>
              <Td><Link className="text-accent hover:underline" to={`/predictions/${p.id}`}>{p.symbol}</Link></Td>
              <Td>{p.direction}</Td>
              <Td className="tabular-nums">{Number(p.entry).toFixed(2)}</Td>
              <Td className="tabular-nums">{Number(p.stopLoss).toFixed(2)}</Td>
              <Td className="tabular-nums">{p.takeProfit ? Number(p.takeProfit).toFixed(2) : '—'}</Td>
              <Td className="tabular-nums">{Number(p.riskReward).toFixed(2)}</Td>
              <Td><PredictionOutcome p={p} /></Td>
              <Td>{p.isShadow ? <Badge tone="warn">shadow</Badge> : <Badge tone="success">real</Badge>}</Td>
              <Td className="text-neutral-400 text-xs">{new Date(p.createdAt).toISOString().slice(0, 19).replace('T', ' ')}</Td>
            </Tr>
          ))}
          {shown === 0 && !q.isLoading && (
            <Tr><Td colSpan={9} className="text-neutral-500">No predictions yet.</Td></Tr>
          )}
        </Tbody>
      </Table>
      <CardBody className="flex items-center justify-between border-t border-neutral-900 py-2 text-xs text-neutral-400">
        <span>{total > 0 ? `${from}–${to} of ${total.toLocaleString()}` : '—'}</span>
        <div className="flex items-center gap-2">
          <button
            disabled={!hasPrev || q.isFetching}
            onClick={() => setOffset(Math.max(0, offset - PREDICTIONS_PAGE_SIZE))}
            className="rounded-md border border-neutral-800 px-3 py-1 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400"
          >← Prev</button>
          <button
            disabled={!hasNext || q.isFetching}
            onClick={() => setOffset(offset + PREDICTIONS_PAGE_SIZE)}
            className="rounded-md border border-neutral-800 px-3 py-1 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400"
          >Next →</button>
        </div>
      </CardBody>
    </Card>
  );
}

function AgentPortfolio({ agentId }: { agentId: string }) {
  const q = usePortfolios(agentId);
  const first = q.data?.rows[0];
  const positions = usePositions(first?.id, 'OPEN');
  if (q.isLoading || positions.isLoading) return <Skeleton className="h-40" />;
  if (!first) return <p className="text-neutral-500">No paper portfolio yet.</p>;
  return (
    <div className="space-y-4">
      <div className="grid grid-cols-2 gap-4 md:grid-cols-4">
        <Card><CardHeader>Cash</CardHeader><CardBody className="tabular-nums">${Number(first.cash).toFixed(2)}</CardBody></Card>
        <Card><CardHeader>Equity</CardHeader><CardBody className="tabular-nums">${Number(first.equity).toFixed(2)}</CardBody></Card>
        <Card><CardHeader>Realized P&L</CardHeader><CardBody className="tabular-nums">${Number(first.realizedPnl).toFixed(2)}</CardBody></Card>
        <Card><CardHeader>Max drawdown</CardHeader><CardBody className="tabular-nums">{(Number(first.maxDrawdown) * 100).toFixed(2)}%</CardBody></Card>
      </div>
      <Card>
        <CardHeader>Open positions</CardHeader>
        <Table>
          <Thead><Tr><Th>Symbol</Th><Th>Direction</Th><Th>Entry</Th><Th>Stop</Th><Th>Size</Th><Th>Remaining</Th><Th>Shadow?</Th></Tr></Thead>
          <Tbody>
            {(positions.data?.rows ?? []).map((pos) => (
              <Tr key={pos.id}>
                <Td>{pos.symbol}</Td>
                <Td>{pos.direction}</Td>
                <Td className="tabular-nums">{Number(pos.entryPrice).toFixed(2)}</Td>
                <Td className="tabular-nums">{Number(pos.currentStop).toFixed(2)}</Td>
                <Td className="tabular-nums">{Number(pos.size).toFixed(4)}</Td>
                <Td className="tabular-nums">{Number(pos.remainingSize).toFixed(4)}</Td>
                <Td>{pos.isShadow ? <Badge tone="warn">shadow</Badge> : <Badge tone="success">real</Badge>}</Td>
              </Tr>
            ))}
            {(positions.data?.rows ?? []).length === 0 && <Tr><Td colSpan={7} className="text-neutral-500">No open positions.</Td></Tr>}
          </Tbody>
        </Table>
      </Card>
    </div>
  );
}

function AgentPerformance({ agent }: { agent: AgentRow }) {
  const horizons = agent.tradingStyle === 'day' ? ['1h', '4h', 'EOD'] : agent.tradingStyle === 'scalp' ? ['5m', '15m', '30m'] : ['1d', '3d', '1w'];
  return (
    <div className="space-y-3">
      {horizons.map((h) => (
        <HeadlineRow key={h} domain={agent.domain} configVersion={agent.activeConfigVersion} horizon={h} />
      ))}
    </div>
  );
}
function HeadlineRow({ domain, configVersion, horizon }: { domain: string; configVersion: number; horizon: string }) {
  const q = useHeadline({ domain, configVersion, horizon });
  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span>Horizon {horizon}</span>
        {q.data ? <Badge tone="neutral">n={q.data.n}</Badge> : null}
      </CardHeader>
      <CardBody>
        {q.isLoading ? <Skeleton className="h-8" />
         : !q.data ? <span className="text-neutral-500">no data yet at this horizon</span>
         : (
          <div className="grid grid-cols-2 gap-4 text-sm md:grid-cols-5">
            <div><div className="text-neutral-400">Accuracy</div><div className="tabular-nums">{q.data.accuracy === null ? '—' : (q.data.accuracy * 100).toFixed(1) + '%'}</div></div>
            <div><div className="text-neutral-400">Wilson</div><div className="tabular-nums">
              {q.data.wilsonLower === null ? '—' : `${(q.data.wilsonLower * 100).toFixed(1)}–${(q.data.wilsonUpper! * 100).toFixed(1)}%`}
            </div></div>
            <div><div className="text-neutral-400">Median return</div><div className="tabular-nums">{q.data.medianReturn === null ? '—' : (q.data.medianReturn * 100).toFixed(2) + '%'}</div></div>
            <div><div className="text-neutral-400">Mean alpha</div><div className="tabular-nums">{q.data.meanAlpha === null ? '—' : (q.data.meanAlpha * 100).toFixed(2) + '%'}</div></div>
            <div><div className="text-neutral-400">Max drawdown</div><div className="tabular-nums">{q.data.maxDrawdown === null ? '—' : (q.data.maxDrawdown * 100).toFixed(2) + '%'}</div></div>
          </div>
         )}
      </CardBody>
    </Card>
  );
}

function AgentConfig({ agent }: { agent: AgentRow }) {
  const weights = Object.entries(agent.config.agentWeights ?? {}).sort((a, b) => b[1] - a[1]);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>Agent weights (active config v{agent.activeConfigVersion})</CardHeader>
        <Table>
          <Thead><Tr><Th>Agent</Th><Th>Weight</Th></Tr></Thead>
          <Tbody>
            {weights.map(([k, v]) => (
              <Tr key={k}>
                <Td>{k}</Td>
                <Td className="tabular-nums">{(v * 100).toFixed(1)}%</Td>
              </Tr>
            ))}
          </Tbody>
        </Table>
      </Card>
      <Card>
        <CardHeader>Raw config JSON</CardHeader>
        <CardBody>
          <pre className="max-h-64 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-300">
{JSON.stringify(agent.config, null, 2)}
          </pre>
          <p className="mt-2 text-xs text-neutral-500">
            Config is versioned (rule 16). Edits are CLI-only via <code>PATCH /trading-agents/:id</code>
            — the UI displays the current version, never writes.
          </p>
        </CardBody>
      </Card>
    </div>
  );
}

function StateBadge({ state }: { state: string }) {
  const tone = state === 'ACTIVE' ? 'success' : state === 'CONSUMED' ? 'info' : state === 'INVALIDATED' ? 'danger' : 'neutral';
  return <Badge tone={tone as Parameters<typeof Badge>[0]['tone']}>{state}</Badge>;
}
