import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { Tabs } from '@/components/ui/Tabs';
import { useAgents } from '@/hooks/useAgents';
import { useAutopsies } from '@/hooks/useAutopsies';
import { useHypotheses } from '@/hooks/useHypotheses';
import { useShadowVsBaseline, useShadowVsReal, type ShadowGroupStats } from '@/hooks/useShadow';
import { apiGet } from '@/lib/api';
import { fmtDate, fmtWhen } from '@/lib/format';

/** M7 payoff pages. Read-only — every row is what an operator would use to DECIDE to promote
 *  or tighten a gate; the decision itself stays a CLI action (rule 16 + rule 20). */
export function LlmReview() {
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">LLM Review</h1>
      <Tabs
        tabs={[
          { key: 'autopsies',  label: 'Autopsies',         content: <Autopsies /> },
          { key: 'hypotheses', label: 'Hypotheses',        content: <Hypotheses /> },
          { key: 'shadow',     label: 'Shadow Evaluation', content: <ShadowPanel /> },
          { key: 'costs',      label: 'Costs',             content: <CostsPanel /> },
        ]}
      />
    </div>
  );
}

function Autopsies() {
  const [status, setStatus] = useState<string>('SUCCESS');
  const [outcome, setOutcome] = useState<string>('');
  const q = useAutopsies({ ...(status ? { status } : {}), ...(outcome ? { outcome } : {}), limit: 200 });
  return (
    <div>
      <div className="mb-3 flex gap-2 text-xs">
        <label>Status:
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="ml-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1">
            <option value="">any</option><option value="SUCCESS">SUCCESS</option><option value="FAILED_LLM">FAILED_LLM</option>
          </select>
        </label>
        <label>Outcome:
          <select value={outcome} onChange={(e) => setOutcome(e.target.value)} className="ml-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1">
            <option value="">any</option><option value="WIN">WIN</option><option value="LOSS">LOSS</option>
          </select>
        </label>
      </div>
      {q.isLoading ? <Skeleton className="h-40" /> : (
        <Card>
          <Table>
            <Thead><Tr><Th>Outcome</Th><Th>Category</Th><Th>Root cause</Th><Th>Setup</Th><Th>Status</Th><Th>When</Th></Tr></Thead>
            <Tbody>
              {(q.data?.rows ?? []).map((a) => (
                <Tr key={a.id}>
                  <Td><Badge tone={a.outcome === 'WIN' ? 'success' : 'danger'}>{a.outcome}</Badge></Td>
                  <Td className="text-xs">{a.failureCategory ?? a.successFactor ?? '—'}</Td>
                  <Td className="text-xs">{a.rootCause ?? <span className="text-neutral-500">(failed LLM)</span>}</Td>
                  <Td className="font-mono text-xs">{a.setupId.slice(0, 12)}…</Td>
                  <Td><Badge tone={a.status === 'SUCCESS' ? 'success' : 'warn'}>{a.status}</Badge></Td>
                  <Td className="text-neutral-400 text-xs tabular-nums">{fmtWhen(a.createdAt)}</Td>
                </Tr>
              ))}
              {(q.data?.rows ?? []).length === 0 && (
                <Tr><Td colSpan={6} className="text-neutral-500">No autopsies yet — the M6 outcome sweep hasn't resolved anything, or memecoin (autopsy-deferred).</Td></Tr>
              )}
            </Tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function Hypotheses() {
  const [status, setStatus] = useState<string>('');
  const q = useHypotheses({ ...(status ? { status } : {}), limit: 200 });
  return (
    <div>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <label>Status:
          <select value={status} onChange={(e) => setStatus(e.target.value)} className="ml-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1">
            <option value="">any</option>
            {['PROPOSED', 'BACKTEST_PASSED', 'OOS_PENDING', 'OOS_PASSED', 'PROMOTED', 'REJECTED', 'DEFERRED_BOOTSTRAP'].map((s) => (
              <option key={s} value={s}>{s}</option>
            ))}
          </select>
        </label>
        <span className="text-neutral-500">
          Promoted by the Agent → Predictions → <em>Run Autopsy + Auto-Tune</em> button; this page is the audit trail. Old versions stay switchable on each agent's Configuration tab.
        </span>
      </div>
      {q.isLoading ? <Skeleton className="h-40" /> : (
        <Card>
          <Table>
            <Thead><Tr><Th>Status</Th><Th>Setup</Th><Th>Category</Th><Th>Kind</Th><Th>Effective-n</Th><Th>Change</Th><Th>Versions</Th><Th>Created</Th></Tr></Thead>
            <Tbody>
              {(q.data?.rows ?? []).map((h) => (
                <Tr key={h.id}>
                  <Td><HypBadge status={h.status} /></Td>
                  <Td className="font-mono text-xs">{h.setupId.slice(0, 12)}…</Td>
                  <Td className="text-xs">{h.category}</Td>
                  <Td><Badge tone={h.categoryKind === 'SUCCESS' ? 'success' : 'danger'}>{h.categoryKind}</Badge></Td>
                  <Td className="tabular-nums">{Number(h.evidenceCount).toFixed(1)}</Td>
                  <Td className="text-xs">
                    {'agentKey' in h.proposedChange && typeof h.proposedChange.agentKey === 'string'
                      ? <><span className="font-mono">{h.proposedChange.agentKey}</span> Δ{(Number(h.proposedChange.delta) * 100).toFixed(1)}%</>
                      : '—'}
                  </Td>
                  <Td className="text-xs">{h.fromConfigVersion !== null ? `v${h.fromConfigVersion} → v${h.toConfigVersion ?? '?'}` : '—'}</Td>
                  <Td className="text-neutral-400 text-xs tabular-nums">{fmtWhen(h.createdAt)}</Td>
                </Tr>
              ))}
              {(q.data?.rows ?? []).length === 0 && (
                <Tr><Td colSpan={8} className="text-neutral-500">No hypotheses yet — the pipeline runs when enough autopsies cluster on a category above effective-n 20.</Td></Tr>
              )}
            </Tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function HypBadge({ status }: { status: string }) {
  const tone = status === 'PROMOTED' ? 'success' :
               status === 'REJECTED' ? 'danger'  :
               status === 'BACKTEST_PASSED' || status === 'OOS_PENDING' ? 'info' :
               status === 'DEFERRED_BOOTSTRAP' ? 'warn' : 'neutral';
  return <Badge tone={tone}>{status}</Badge>;
}

function ShadowPanel() {
  const agents = useAgents();
  const [agentId, setAgentId] = useState<string>('');
  const agent = (agents.data ?? []).find((a) => a.id === agentId);
  return (
    <div className="space-y-4">
      <Card>
        <CardHeader>Pick an agent</CardHeader>
        <CardBody>
          {agents.isLoading ? <Skeleton className="h-8 w-72" /> : (
            <select value={agentId} onChange={(e) => setAgentId(e.target.value)} className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm">
              <option value="">— select —</option>
              {(agents.data ?? []).map((a) => (
                <option key={a.id} value={a.id}>{a.name} · {a.domain} · v{a.activeConfigVersion}</option>
              ))}
            </select>
          )}
        </CardBody>
      </Card>
      {agent && (
        <div className="grid grid-cols-1 gap-4 md:grid-cols-2">
          <FlipPanel configVersion={agent.activeConfigVersion} horizon={agent.tradingStyle === 'day' ? '4h' : agent.tradingStyle === 'scalp' ? '15m' : '3d'} />
          <StandAsidePanel domain={agent.domain} configVersion={agent.activeConfigVersion} horizon={agent.tradingStyle === 'day' ? '4h' : agent.tradingStyle === 'scalp' ? '15m' : '3d'} />
        </div>
      )}
    </div>
  );
}

function GroupCard({ title, s }: { title: string; s: ShadowGroupStats }) {
  return (
    <Card>
      <CardHeader>{title}</CardHeader>
      <CardBody className="grid grid-cols-2 gap-2 text-sm">
        <div className="text-neutral-400">n</div><div className="tabular-nums text-right">{s.n}</div>
        <div className="text-neutral-400">wins</div><div className="tabular-nums text-right">{s.wins}</div>
        <div className="text-neutral-400">win rate</div><div className="tabular-nums text-right">{s.winRate === null ? '—' : (s.winRate * 100).toFixed(1) + '%'}</div>
        <div className="text-neutral-400">Wilson</div><div className="tabular-nums text-right">
          {s.wilsonLower !== null && s.wilsonUpper !== null ? `${(s.wilsonLower * 100).toFixed(1)}–${(s.wilsonUpper * 100).toFixed(1)}%` : '—'}
        </div>
        <div className="text-neutral-400">median return</div><div className="tabular-nums text-right">{s.medianReturn === null ? '—' : (s.medianReturn * 100).toFixed(2) + '%'}</div>
        <div className="text-neutral-400">mean return</div><div className="tabular-nums text-right">{s.meanReturn === null ? '—' : (s.meanReturn * 100).toFixed(2) + '%'}</div>
        <div className="text-neutral-400">max drawdown</div><div className="tabular-nums text-right">{s.maxDrawdown === null ? '—' : (s.maxDrawdown * 100).toFixed(2) + '%'}</div>
      </CardBody>
    </Card>
  );
}

function FlipPanel({ configVersion, horizon }: { configVersion: number; horizon: string }) {
  const q = useShadowVsReal({ configVersion, horizon });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data) return null;
  return (
    <div className="grid gap-3">
      <div className="text-xs font-medium uppercase tracking-wider text-neutral-400">FLIP — real (Judge dir) vs shadow (deterministic dir)</div>
      <GroupCard title="Real (Judge direction)"  s={q.data.flipRealGroup} />
      <GroupCard title="Shadow (deterministic)" s={q.data.flipShadowGroup} />
    </div>
  );
}
function StandAsidePanel({ domain, configVersion, horizon }: { domain: string; configVersion: number; horizon: string }) {
  const q = useShadowVsBaseline({ domain, configVersion, horizon });
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data) return null;
  return (
    <div className="grid gap-3">
      <div className="text-xs font-medium uppercase tracking-wider text-neutral-400">STAND_ASIDE — shadow (deterministic dir) vs baseline (AGREE/DEFER)</div>
      <GroupCard title="Shadow (what the trade would have been)" s={q.data.standAsideShadowGroup} />
      <GroupCard title="Baseline (agree/defer real predictions)" s={q.data.baseline} />
    </div>
  );
}

// ── Costs (§23 — audit #17): "is the LLM worth it" needs the llm_call_log ledger visible ──
interface LlmCosts {
  days: number;
  totals: { calls: number; cost: string };
  byAgent: { agent: string; calls: number; cost: string; promptTokens: string; completionTokens: string; failures: string; avgLatencyMs: string }[];
  byDay: { day: string; calls: number; cost: string }[];
}

function CostsPanel() {
  const [days, setDays] = useState(30);
  const q = useQuery({
    queryKey: ['llm.costs', days],
    queryFn: () => apiGet<LlmCosts>(`/llm/costs?days=${days}`),
  });
  if (q.isLoading) return <Skeleton className="h-48" />;
  const d = q.data;
  if (!d) return null;
  const usd = (v: string | number) => `$${Number(v).toFixed(4)}`;
  return (
    <div className="space-y-4">
      <div className="flex items-center gap-3">
        <select value={days} onChange={(e) => setDays(Number(e.target.value))}
          className="rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm">
          <option value={7}>last 7 days</option>
          <option value={30}>last 30 days</option>
          <option value={90}>last 90 days</option>
        </select>
        <span className="text-sm text-neutral-300">
          {d.totals.calls} calls · <span className="font-semibold text-neutral-100">{usd(d.totals.cost)}</span> total
        </span>
      </div>
      <Card>
        <CardHeader>By caller</CardHeader>
        {d.byAgent.length === 0 ? (
          <CardBody className="text-sm text-neutral-500">No LLM calls in this window — the ledger fills once the Judge tier runs with a DeepSeek key.</CardBody>
        ) : (
          <Table>
            <Thead><Tr><Th>Caller</Th><Th>Calls</Th><Th>Cost</Th><Th>Prompt tok</Th><Th>Completion tok</Th><Th>Failures</Th><Th>Avg latency</Th></Tr></Thead>
            <Tbody>
              {d.byAgent.map((a) => (
                <Tr key={a.agent}>
                  <Td className="font-mono text-xs">{a.agent}</Td>
                  <Td className="tabular-nums">{a.calls}</Td>
                  <Td className="tabular-nums">{usd(a.cost)}</Td>
                  <Td className="tabular-nums">{Number(a.promptTokens).toLocaleString()}</Td>
                  <Td className="tabular-nums">{Number(a.completionTokens).toLocaleString()}</Td>
                  <Td className="tabular-nums">{a.failures}</Td>
                  <Td className="tabular-nums">{Number(a.avgLatencyMs).toFixed(0)}ms</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
      <Card>
        <CardHeader>By day</CardHeader>
        {d.byDay.length === 0 ? <CardBody className="text-sm text-neutral-500">—</CardBody> : (
          <Table>
            <Thead><Tr><Th>Day</Th><Th>Calls</Th><Th>Cost</Th></Tr></Thead>
            <Tbody>
              {d.byDay.map((r) => (
                <Tr key={r.day}>
                  <Td className="text-xs">{fmtDate(r.day)}</Td>
                  <Td className="tabular-nums">{r.calls}</Td>
                  <Td className="tabular-nums">{usd(r.cost)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        )}
      </Card>
    </div>
  );
}
