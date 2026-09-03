import { useState } from 'react';
import { Link, useParams } from 'react-router-dom';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { usePrediction, usePredictions } from '@/hooks/usePredictions';
import { usePredictionAttribution, usePredictionAutopsy } from '@/hooks/usePredictionExtras';
import { PredictionOutcome } from '@/components/PredictionOutcome';
import { useAgents } from '@/hooks/useAgents';

const PAGE_SIZE = 50;

export function Predictions() {
  const { id } = useParams();
  if (id) return <PredictionDetail id={id} />;
  return <PredictionList />;
}


function PredictionList() {
  const [offset, setOffset] = useState(0);
  const [agentId, setAgentId] = useState('');
  const agents = useAgents();
  const q = usePredictions({ ...(agentId ? { agentId } : {}), limit: PAGE_SIZE, offset });
  const total = q.data?.total ?? 0;
  const shown = q.data?.rows.length ?? 0;
  const from = total === 0 ? 0 : offset + 1;
  const to = offset + shown;
  const hasPrev = offset > 0;
  const hasNext = offset + shown < total;

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Predictions</h1>
      <div className="mb-3 flex items-center gap-2 text-xs">
        <label>
          Agent:
          <select
            value={agentId}
            onChange={(event) => { setAgentId(event.target.value); setOffset(0); }}
            className="ml-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1"
            aria-label="Filter predictions by agent"
          >
            <option value="">all agents</option>
            {(agents.data ?? []).map((agent) => <option key={agent.id} value={agent.id}>{agent.name}</option>)}
          </select>
        </label>
      </div>
      {q.isLoading && !q.data ? <Skeleton className="h-40" /> : (
        <Card>
          <Table>
            <Thead><Tr>
              <Th>Symbol</Th><Th>Agent</Th><Th>Direction</Th><Th>Entry</Th><Th>SL</Th><Th>TP</Th><Th>R:R</Th>
              <Th>Outcome</Th><Th>Real?</Th><Th>Created</Th>
            </Tr></Thead>
            <Tbody>
              {(q.data?.rows ?? []).map((p) => (
                <Tr key={p.id}>
                  <Td><Link className="text-accent hover:underline" to={`/predictions/${p.id}`}>{p.symbol}</Link></Td>
                  <Td>{p.agentName}</Td>
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
                <Tr><Td colSpan={10} className="text-neutral-500">No predictions yet.</Td></Tr>
              )}
            </Tbody>
          </Table>
          {/* Pagination row — fix #2. `placeholderData` on the hook keeps the current rows
              visible while the next page loads, so the buttons never blink an empty table. */}
          <CardBody className="flex items-center justify-between border-t border-neutral-900 py-2 text-xs text-neutral-400">
            <span>{total > 0 ? `${from}–${to} of ${total.toLocaleString()}` : '—'}</span>
            <div className="flex items-center gap-2">
              <button
                disabled={!hasPrev || q.isFetching}
                onClick={() => setOffset(Math.max(0, offset - PAGE_SIZE))}
                className="rounded-md border border-neutral-800 px-3 py-1 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400"
              >← Prev</button>
              <button
                disabled={!hasNext || q.isFetching}
                onClick={() => setOffset(offset + PAGE_SIZE)}
                className="rounded-md border border-neutral-800 px-3 py-1 hover:border-accent hover:text-accent disabled:opacity-40 disabled:hover:border-neutral-800 disabled:hover:text-neutral-400"
              >Next →</button>
            </div>
          </CardBody>
        </Card>
      )}
    </div>
  );
}

function PredictionDetail({ id }: { id: string }) {
  const q = usePrediction(id);
  const attribution = usePredictionAttribution(id);
  const autopsy = usePredictionAutopsy(id);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data) return <p className="text-neutral-500">Not found.</p>;
  const p = q.data.prediction;
  const pos = q.data.position;
  const feats = attribution.data?.features ?? [];
  const judge = attribution.data?.judge ?? null;
  const risk = attribution.data?.risk ?? null;
  const judgeFeature = feats.find((f) => f.agentKey === 'judge');
  const judgeFeatures = (judgeFeature?.features ?? {}) as { thesis?: string; keyRisks?: string[]; invalidators?: unknown[]; confidenceTag?: string };

  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/predictions" className="text-sm text-neutral-400 hover:text-neutral-100">← Predictions</Link>
        <h1 className="text-lg font-semibold">{p.symbol}</h1>
        <Badge tone={p.isShadow ? 'warn' : 'success'}>{p.isShadow ? 'shadow' : 'real'}</Badge>
        <Badge tone="neutral">{p.direction}</Badge>
        <Badge tone="neutral">v{p.configVersion}</Badge>
        <PredictionOutcome p={p} />
      </div>

      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>Setup</CardHeader>
          <CardBody className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-neutral-400">Entry</div><div className="tabular-nums text-right">{Number(p.entry).toFixed(2)}</div>
            <div className="text-neutral-400">Stop</div><div className="tabular-nums text-right">{Number(p.stopLoss).toFixed(2)}</div>
            <div className="text-neutral-400">TP</div><div className="tabular-nums text-right">{p.takeProfit ? Number(p.takeProfit).toFixed(2) : '—'}</div>
            <div className="text-neutral-400">R:R</div><div className="tabular-nums text-right">{Number(p.riskReward).toFixed(2)}</div>
            <div className="text-neutral-400">Position size</div><div className="tabular-nums text-right">{Number(p.positionSize).toFixed(4)}</div>
            <div className="text-neutral-400">Leverage</div><div className="tabular-nums text-right">{p.leverage ? Number(p.leverage).toFixed(1) + 'x' : '—'}</div>
            <div className="text-neutral-400">Score</div><div className="tabular-nums text-right">{Number(p.score).toFixed(2)}</div>
            <div className="text-neutral-400">Confidence</div><div className="tabular-nums text-right">{Number(p.confidence).toFixed(2)}</div>
            <div className="text-neutral-400">Horizon</div><div className="text-right">{p.horizon}</div>
          </CardBody>
        </Card>

        {pos && (
          <Card>
            <CardHeader>Paper position (§20)</CardHeader>
            <CardBody className="grid grid-cols-2 gap-2 text-sm">
              <div className="text-neutral-400">State</div>
              <div className="text-right">
                {pos.state === 'OPEN' ? <Badge tone="info">OPEN</Badge>
                : pos.state === 'CLOSED' ? <Badge tone={pos.closeReason === 'TAKE_PROFIT' ? 'success' : pos.closeReason === 'STOP_LOSS' ? 'danger' : 'neutral'}>{pos.closeReason ?? 'CLOSED'}</Badge>
                : <Badge tone="neutral">{pos.state}</Badge>}
              </div>
              <div className="text-neutral-400">Fill price</div><div className="tabular-nums text-right">{Number(pos.entryPrice).toFixed(6)}</div>
              <div className="text-neutral-400">Size (remaining)</div><div className="tabular-nums text-right">{Number(pos.remainingSize).toFixed(4)} / {Number(pos.size).toFixed(4)}</div>
              <div className="text-neutral-400">Realized P&L</div>
              <div className={`tabular-nums text-right ${Number(pos.realizedPnl) > 0 ? 'text-emerald-300' : Number(pos.realizedPnl) < 0 ? 'text-red-300' : ''}`}>
                {Number(pos.realizedPnl).toFixed(4)}
              </div>
              <div className="text-neutral-400">MFE / MAE</div><div className="tabular-nums text-right">{Number(pos.mfe).toFixed(4)} / {Number(pos.mae).toFixed(4)}</div>
              <div className="text-neutral-400">Opened</div><div className="text-right text-xs">{new Date(pos.openedAtProcessing).toISOString().slice(0, 19).replace('T', ' ')}</div>
              {pos.closedAt && (<>
                <div className="text-neutral-400">Closed</div>
                <div className="text-right text-xs">{new Date(pos.closedAt).toISOString().slice(0, 19).replace('T', ' ')}</div>
              </>)}
            </CardBody>
          </Card>
        )}

        <Card>
          <CardHeader>Judge decision</CardHeader>
          <CardBody className="space-y-2 text-sm">
            {judge ? (
              <>
                <div>Action: <Badge tone={judge.judgeAction === 'FLIP' ? 'info' : judge.judgeAction === 'STAND_ASIDE' ? 'danger' : judge.judgeAction === 'AGREE' ? 'success' : 'warn'}>{judge.judgeAction}</Badge>
                  {judge.flipRefusedByPlanner && <span className="ml-2 text-xs text-amber-300">flip refused by planner</span>}
                </div>
                <div>Deterministic: <span className="tabular-nums">{Number(judge.detConfidence).toFixed(2)}</span> · <span className="text-neutral-400">{judge.detDirection}</span></div>
                <div>Judge:         <span className="tabular-nums">{Number(judge.judgeConfidence).toFixed(2)}</span> · <span className="text-neutral-400">{judge.judgeDirection}</span></div>
                <div>Gap: <span className="tabular-nums">{Number(judge.gap).toFixed(2)}</span></div>
              </>
            ) : <div className="text-neutral-500">No Judge decision recorded — LLM was down or the signal was Risk-INVALIDATED.</div>}
            {judgeFeatures.thesis && (
              <div className="mt-3 border-t border-neutral-800 pt-2 text-xs">
                <div className="mb-1 uppercase tracking-wider text-neutral-500">Judge thesis</div>
                <p className="whitespace-pre-wrap text-neutral-200">{judgeFeatures.thesis}</p>
                {(judgeFeatures.keyRisks ?? []).length > 0 && (
                  <>
                    <div className="mt-2 uppercase tracking-wider text-neutral-500">Key risks</div>
                    <ul className="list-disc pl-4">{judgeFeatures.keyRisks!.map((r, i) => <li key={i}>{r}</li>)}</ul>
                  </>
                )}
              </div>
            )}
          </CardBody>
        </Card>

        <Card className="lg:col-span-2">
          <CardHeader>Attribution — per-agent contribution (§22)</CardHeader>
          <Table>
            <Thead><Tr><Th>Agent</Th><Th>v.</Th><Th>Score</Th><Th>Confidence</Th></Tr></Thead>
            <Tbody>
              {feats.filter((f) => f.agentKey !== 'judge').map((f) => (
                <Tr key={`${f.agentKey}-${f.agentVersion}`}>
                  <Td>{f.agentKey}</Td>
                  <Td>v{f.agentVersion}</Td>
                  <Td className="tabular-nums">{Number(f.score).toFixed(2)}</Td>
                  <Td className="tabular-nums">{Number(f.confidence).toFixed(2)}</Td>
                </Tr>
              ))}
              {feats.length === 0 && <Tr><Td colSpan={4} className="text-neutral-500">No signal_feature rows.</Td></Tr>}
            </Tbody>
          </Table>
        </Card>

        {risk && (
          <Card className="lg:col-span-2">
            <CardHeader>Risk verdict</CardHeader>
            <CardBody>
              <div>Level: <Badge tone={risk.riskLevel === 'INVALIDATED' ? 'danger' : risk.riskLevel === 'HIGH' || risk.riskLevel === 'MEDIUM_HIGH' ? 'warn' : 'success'}>{risk.riskLevel}</Badge></div>
              {risk.riskFlags.length > 0 && <div className="mt-2 text-xs text-neutral-400">Flags: {risk.riskFlags.join(', ')}</div>}
            </CardBody>
          </Card>
        )}

        {autopsy.data && (
          <Card className="lg:col-span-2">
            <CardHeader>Autopsy</CardHeader>
            <CardBody className="space-y-1 text-sm">
              <div>
                <Badge tone={autopsy.data.outcome === 'WIN' ? 'success' : 'danger'}>{autopsy.data.outcome}</Badge>
                <span className="ml-2 text-neutral-400">{autopsy.data.failureCategory ?? autopsy.data.successFactor ?? ''}</span>
              </div>
              {autopsy.data.rootCause && <div><span className="text-neutral-400">Root cause:</span> {autopsy.data.rootCause}</div>}
              {autopsy.data.explanation && <p className="whitespace-pre-wrap text-neutral-300 text-xs">{autopsy.data.explanation}</p>}
              {autopsy.data.recommendation && <div className="border-t border-neutral-800 pt-2 text-xs"><span className="text-neutral-400">Recommendation:</span> {autopsy.data.recommendation}</div>}
            </CardBody>
          </Card>
        )}
      </div>
    </div>
  );
}
