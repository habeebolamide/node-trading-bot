import { useMemo, useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { Tabs } from '@/components/ui/Tabs';
import { useBrainAgents, useBrainSetup, useMarketMemory } from '@/hooks/useBrain';

/** Per-domain Brain page — Historical Edge lookup, Agent Memory, Market Memory. */
export function Brain() {
  const [domain, setDomain] = useState<'perp' | 'memecoin'>('perp');
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <h1 className="text-lg font-semibold">Brain</h1>
        <div className="flex gap-1 rounded-md border border-neutral-800 p-0.5 text-xs">
          {(['perp', 'memecoin'] as const).map((d) => (
            <button
              key={d}
              onClick={() => setDomain(d)}
              className={`rounded px-2 py-1 ${d === domain ? 'bg-accent text-neutral-950' : 'text-neutral-400 hover:text-neutral-100'}`}
            >
              {d}
            </button>
          ))}
        </div>
      </div>
      <Tabs
        tabs={[
          { key: 'edge',   label: 'Historical Edge',   content: <HistoricalEdgeLookup domain={domain} /> },
          { key: 'agents', label: 'Agent Memory',      content: <AgentMemoryTable domain={domain} /> },
          { key: 'market', label: 'Market Memory',     content: <MarketMemoryTable domain={domain} /> },
        ]}
      />
    </div>
  );
}

const PERP_DIMS = ['momentum', 'open_interest', 'market_regime', 'liquidation', 'funding', 'positioning', 'volume', 'volatility'] as const;
const MEME_DIMS = ['smart_money', 'convergence', 'momentum', 'token_quality', 'market_regime'] as const;

function HistoricalEdgeLookup({ domain }: { domain: 'perp' | 'memecoin' }) {
  const dims = domain === 'perp' ? PERP_DIMS : MEME_DIMS;
  const [values, setValues] = useState<Record<string, number>>(() => Object.fromEntries(dims.map((d) => [d, 0])));
  const featuresJson = useMemo(() => JSON.stringify(values), [values]);
  const q = useBrainSetup({ domain, features: featuresJson });

  return (
    <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
      <Card>
        <CardHeader>Feature tuple</CardHeader>
        <CardBody>
          <p className="mb-3 text-xs text-neutral-400">
            Slide each dimension between −1 and +1. The Brain buckets by ∓1/3; boundary lands MED.
            Zero (MED) is the neutral fallback for a missing dimension.
          </p>
          <div className="space-y-2">
            {dims.map((d) => (
              <div key={d} className="grid grid-cols-[9rem_1fr_3rem] items-center gap-2 text-xs">
                <div>{d}</div>
                <input
                  type="range" min={-1} max={1} step={0.1}
                  value={values[d] ?? 0}
                  onChange={(e) => setValues((v) => ({ ...v, [d]: Number(e.target.value) }))}
                  className="w-full accent-cyan-500"
                />
                <div className="text-right tabular-nums">{(values[d] ?? 0).toFixed(1)}</div>
              </div>
            ))}
          </div>
        </CardBody>
      </Card>
      <Card>
        <CardHeader>Historical Edge</CardHeader>
        <CardBody>
          {q.isLoading ? <Skeleton className="h-24" />
           : q.isError ? <div className="text-red-300 text-sm">API error: {(q.error as { message?: string }).message}</div>
           : q.data ? (
            <div className="space-y-2 text-sm">
              <div>Evidence: <Badge tone={q.data.evidence === 'SUFFICIENT' ? 'success' : 'warn'}>{q.data.evidence}</Badge></div>
              <div>Backoff depth: <span className="tabular-nums">{q.data.backoffDepth}</span> {q.data.fallback ? <span className="text-neutral-400">— {q.data.fallback}</span> : null}</div>
              <div>Effective-n: <span className="tabular-nums">{q.data.effectiveN.toFixed(2)}</span></div>
              <div>Observed win rate (rung 0): <span className="tabular-nums">{q.data.observedWinRate === null ? '—' : (q.data.observedWinRate * 100).toFixed(1) + '%'}</span></div>
              <div>Answering win rate: <span className="tabular-nums">{q.data.fallbackWinRate === null ? (q.data.observedWinRate === null ? '—' : (q.data.observedWinRate * 100).toFixed(1) + '%') : (q.data.fallbackWinRate * 100).toFixed(1) + '%'}</span></div>
              <div>CI width: <span className="tabular-nums">{q.data.ciWidth === null ? '—' : q.data.ciWidth.toFixed(3)}</span></div>
              <div className="border-t border-neutral-800 pt-2">Contribution to composite: <span className="tabular-nums">{q.data.score.toFixed(3)}</span></div>
              <div>Confidence sub-metric (historicalEvidence): <span className="tabular-nums">{q.data.historicalEvidence.toFixed(3)}</span></div>
            </div>
           ) : null}
        </CardBody>
      </Card>
    </div>
  );
}

function AgentMemoryTable({ domain }: { domain: 'perp' | 'memecoin' }) {
  const q = useBrainAgents(domain);
  if (q.isLoading) return <Skeleton className="h-40" />;
  const rows = q.data?.rows ?? [];
  return (
    <Card>
      <CardHeader>Agent Memory — standalone counterfactual accuracy per (agent, version)</CardHeader>
      <Table>
        <Thead><Tr><Th>Agent</Th><Th>v.</Th><Th>Standalone accuracy</Th><Th>Wilson</Th><Th>Effective-n</Th><Th>Evidence</Th></Tr></Thead>
        <Tbody>
          {rows.map((r) => (
            <Tr key={r.id}>
              <Td>{r.agentKey}</Td>
              <Td>v{r.agentVersion}</Td>
              <Td className="tabular-nums">{r.standaloneAccuracy === null ? '—' : (Number(r.standaloneAccuracy) * 100).toFixed(1) + '%'}</Td>
              <Td className="tabular-nums">
                {r.wilsonLower && r.wilsonUpper ? `${(Number(r.wilsonLower) * 100).toFixed(1)}–${(Number(r.wilsonUpper) * 100).toFixed(1)}%` : '—'}
              </Td>
              <Td className="tabular-nums">{Number(r.effectiveN).toFixed(2)}</Td>
              <Td><Badge tone={r.evidence === 'SUFFICIENT' ? 'success' : 'warn'}>{r.evidence}</Badge></Td>
            </Tr>
          ))}
          {rows.length === 0 && <Tr><Td colSpan={6} className="text-neutral-500">Empty — the Brain fills once M6 resolves outcomes.</Td></Tr>}
        </Tbody>
      </Table>
    </Card>
  );
}

function MarketMemoryTable({ domain }: { domain: 'perp' | 'memecoin' }) {
  const q = useMarketMemory(domain);
  if (q.isLoading) return <Skeleton className="h-40" />;
  const rows = q.data?.byRegime ?? [];
  return (
    <Card>
      <CardHeader>Market Memory — regime breakdown (§16)</CardHeader>
      <Table>
        <Thead><Tr><Th>Regime</Th><Th>Effective-n</Th><Th>Win rate</Th><Th>Wilson</Th><Th>Median return</Th><Th>Evidence</Th></Tr></Thead>
        <Tbody>
          {rows.map((r) => (
            <Tr key={r.regime}>
              <Td>{r.regime}</Td>
              <Td className="tabular-nums">{r.effectiveN.toFixed(2)}</Td>
              <Td className="tabular-nums">{r.winRate === null ? '—' : (r.winRate * 100).toFixed(1) + '%'}</Td>
              <Td className="tabular-nums">
                {r.wilsonLower !== null && r.wilsonUpper !== null ? `${(r.wilsonLower * 100).toFixed(1)}–${(r.wilsonUpper * 100).toFixed(1)}%` : '—'}
              </Td>
              <Td className="tabular-nums">{r.medianReturn === null ? '—' : (r.medianReturn * 100).toFixed(2) + '%'}</Td>
              <Td><Badge tone={r.evidence === 'SUFFICIENT' ? 'success' : 'warn'}>{r.evidence}</Badge></Td>
            </Tr>
          ))}
        </Tbody>
      </Table>
    </Card>
  );
}
