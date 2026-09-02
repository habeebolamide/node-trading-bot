import { useMemo, useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { useAgents } from '@/hooks/useAgents';
import { apiGet } from '@/lib/api';

interface TertileStats { effectiveN: number; effectiveWins: number; winRate: number | null; wilsonLower: number | null; wilsonUpper: number | null }
interface FactorPV {
  agentKey: string; evidence: string; measurableDifference: boolean; summary: string;
  byTertile: Record<'LOW' | 'MED' | 'HIGH', TertileStats>;
}

const PERP_FACTORS = ['perp.momentum', 'perp.open_interest', 'perp.market_regime', 'perp.liquidation', 'perp.funding', 'perp.positioning'];
const HORIZON_BY_STYLE: Record<string, string> = { scalp: '15m', day: '4h', swing: '3d' };

/**
 * Attribution page (§22 / §26 — audit #16). "Which factors actually had predictive value" — the
 * conditional win rate of each contributing agent by contribution tertile, version-scoped
 * (rule 16, never blended). measurableDifference is the reporting bar: an overlap of the HIGH
 * and LOW Wilson intervals means "no measurable difference", not a small one.
 */
export function Attribution() {
  const agents = useAgents();
  const [agentId, setAgentId] = useState('');
  const agent = useMemo(() => (agents.data ?? []).find((a) => a.id === agentId), [agents.data, agentId]);
  const horizon = agent ? HORIZON_BY_STYLE[agent.tradingStyle] ?? '4h' : '4h';

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Attribution</h1>
      <Card className="mb-4">
        <CardHeader>Factor predictive value, by contribution tertile (version-scoped)</CardHeader>
        <CardBody>
          {agents.isLoading ? <Skeleton className="h-8 w-72" /> : (
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)}
              className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm">
              <option value="">— select agent —</option>
              {(agents.data ?? []).filter((a) => a.domain === 'perp').map((a) => (
                <option key={a.id} value={a.id}>{a.name} · v{a.activeConfigVersion}</option>
              ))}
            </select>
          )}
        </CardBody>
      </Card>
      {agent && (
        <div className="space-y-4">
          {PERP_FACTORS.map((k) => (
            <FactorPanel key={k} agentKey={k} domain={agent.domain} configVersion={agent.activeConfigVersion} horizon={horizon} />
          ))}
        </div>
      )}
    </div>
  );
}

function FactorPanel({ agentKey, domain, configVersion, horizon }: { agentKey: string; domain: string; configVersion: number; horizon: string }) {
  const q = useQuery({
    queryKey: ['factor', agentKey, domain, configVersion, horizon],
    queryFn: () => apiGet<FactorPV>(`/metrics/factor?domain=${domain}&agentKey=${encodeURIComponent(agentKey)}&configVersion=${configVersion}&horizon=${encodeURIComponent(horizon)}`),
  });
  if (q.isLoading) return <Skeleton className="h-28" />;
  const d = q.data;
  if (!d) return null;
  const pct = (v: number | null) => (v === null ? '—' : (v * 100).toFixed(1) + '%');
  return (
    <Card>
      <CardHeader className="flex items-center gap-2">
        <span className="font-mono text-sm">{agentKey}</span>
        <Badge tone={d.measurableDifference ? 'success' : 'neutral'}>
          {d.measurableDifference ? 'measurable difference' : 'no measurable difference'}
        </Badge>
        <Badge tone={d.evidence === 'SUFFICIENT' ? 'success' : 'warn'}>{d.evidence}</Badge>
      </CardHeader>
      <CardBody className="mb-1 text-xs text-neutral-400">{d.summary}</CardBody>
      <Table>
        <Thead><Tr><Th>Tertile</Th><Th>effective-n</Th><Th>Win rate</Th><Th>Wilson 95%</Th></Tr></Thead>
        <Tbody>
          {(['HIGH', 'MED', 'LOW'] as const).map((t) => {
            const s = d.byTertile[t];
            return (
              <Tr key={t}>
                <Td>{t}</Td>
                <Td className="tabular-nums">{s.effectiveN.toFixed(1)}</Td>
                <Td className="tabular-nums">{pct(s.winRate)}</Td>
                <Td className="tabular-nums">{s.wilsonLower === null ? '—' : `${pct(s.wilsonLower)} – ${pct(s.wilsonUpper)}`}</Td>
              </Tr>
            );
          })}
        </Tbody>
      </Table>
    </Card>
  );
}
