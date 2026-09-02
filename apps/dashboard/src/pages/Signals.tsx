import { Link, useParams } from 'react-router-dom';
import { useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { useSignals } from '@/hooks/useSignals';
import { useSignalDetail } from '@/hooks/useSignalDetail';

export function Signals() {
  const { id } = useParams();
  if (id) return <SignalDetailPage id={id} />;
  return <SignalsList />;
}

function SignalsList() {
  const [state, setState] = useState<string>('');
  const [domain, setDomain] = useState<string>('');
  const q = useSignals({ ...(state ? { state } : {}), ...(domain ? { domain } : {}), limit: 200 });
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Signals</h1>
      <div className="mb-3 flex gap-2 text-xs">
        <label>State:
          <select value={state} onChange={(e) => setState(e.target.value)} className="ml-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1">
            <option value="">any</option>{['ACTIVE','CONSUMED','EXPIRED','INVALIDATED'].map((s) => <option key={s} value={s}>{s}</option>)}
          </select>
        </label>
        <label>Domain:
          <select value={domain} onChange={(e) => setDomain(e.target.value)} className="ml-1 rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1">
            <option value="">any</option><option value="perp">perp</option><option value="memecoin">memecoin</option>
          </select>
        </label>
      </div>
      {q.isLoading ? <Skeleton className="h-40" /> : (
        <Card>
          <Table>
            <Thead><Tr><Th>Symbol</Th><Th>Direction</Th><Th>Score</Th><Th>Conf</Th><Th>State</Th><Th>Created</Th></Tr></Thead>
            <Tbody>
              {(q.data?.rows ?? []).map((s) => (
                <Tr key={s.id}>
                  <Td><Link className="text-accent hover:underline" to={`/signals/${s.id}`}>{s.symbol}</Link></Td>
                  <Td>{s.direction}</Td>
                  <Td className="tabular-nums">{Number(s.compositeScore).toFixed(2)}</Td>
                  <Td className="tabular-nums">{Number(s.confidence).toFixed(2)}</Td>
                  <Td><Badge tone={s.state === 'ACTIVE' ? 'success' : s.state === 'CONSUMED' ? 'info' : s.state === 'INVALIDATED' ? 'danger' : 'neutral'}>{s.state}</Badge></Td>
                  <Td className="text-neutral-400 text-xs">{new Date(s.createdAt).toISOString()}</Td>
                </Tr>
              ))}
              {(q.data?.rows ?? []).length === 0 && <Tr><Td colSpan={6} className="text-neutral-500">No signals.</Td></Tr>}
            </Tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function SignalDetailPage({ id }: { id: string }) {
  const q = useSignalDetail(id);
  if (q.isLoading) return <Skeleton className="h-40" />;
  if (!q.data) return <p className="text-neutral-500">Not found.</p>;
  const { signal: s, features, risk, noTrade, judge } = q.data;
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/signals" className="text-sm text-neutral-400 hover:text-neutral-100">← Signals</Link>
        <h1 className="text-lg font-semibold">{s.symbol}</h1>
        <Badge tone={s.domain === 'perp' ? 'info' : 'warn'}>{s.domain}</Badge>
        <Badge tone="neutral">{s.direction}</Badge>
        <Badge tone={s.state === 'ACTIVE' ? 'success' : s.state === 'CONSUMED' ? 'info' : s.state === 'INVALIDATED' ? 'danger' : 'neutral'}>{s.state}</Badge>
      </div>
      <div className="grid grid-cols-1 gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>Score + confidence</CardHeader>
          <CardBody className="grid grid-cols-2 gap-2 text-sm">
            <div className="text-neutral-400">Composite score</div><div className="tabular-nums text-right">{Number(s.compositeScore).toFixed(3)}</div>
            <div className="text-neutral-400">Confidence</div><div className="tabular-nums text-right">{Number(s.confidence).toFixed(3)}</div>
            <div className="text-neutral-400">Config version</div><div className="text-right">v{s.configVersion}</div>
            <div className="text-neutral-400">Fingerprint</div><div className="font-mono text-xs text-right">{s.fingerprint.slice(0, 12)}…</div>
          </CardBody>
        </Card>
        {risk && (
          <Card>
            <CardHeader>Risk verdict</CardHeader>
            <CardBody>
              <Badge tone={risk.riskLevel === 'INVALIDATED' ? 'danger' : risk.riskLevel === 'HIGH' || risk.riskLevel === 'MEDIUM_HIGH' ? 'warn' : 'success'}>{risk.riskLevel}</Badge>
              {risk.riskFlags.length > 0 && <p className="mt-2 text-xs text-neutral-400">Flags: {risk.riskFlags.join(', ')}</p>}
            </CardBody>
          </Card>
        )}
        {noTrade && (
          <Card>
            <CardHeader>NO_TRADE veto</CardHeader>
            <CardBody>
              <Badge tone="warn">{noTrade.reason}</Badge>
              {noTrade.detail && <p className="mt-2 text-xs text-neutral-400">{noTrade.detail}</p>}
            </CardBody>
          </Card>
        )}
        {judge && (
          <Card>
            <CardHeader>Judge decision</CardHeader>
            <CardBody className="text-sm space-y-1">
              <div>Action: <Badge tone={judge.judgeAction === 'FLIP' ? 'info' : judge.judgeAction === 'STAND_ASIDE' ? 'danger' : 'neutral'}>{judge.judgeAction}</Badge></div>
              <div>Det conf: <span className="tabular-nums">{Number(judge.detConfidence).toFixed(2)}</span> · Judge conf: <span className="tabular-nums">{Number(judge.judgeConfidence).toFixed(2)}</span></div>
            </CardBody>
          </Card>
        )}
        <Card className="lg:col-span-2">
          <CardHeader>Contributing agents (§22)</CardHeader>
          <Table>
            <Thead><Tr><Th>Agent</Th><Th>v.</Th><Th>Score</Th><Th>Confidence</Th></Tr></Thead>
            <Tbody>
              {features.map((f) => (
                <Tr key={`${f.agentKey}-${f.agentVersion}`}>
                  <Td>{f.agentKey}</Td>
                  <Td>v{f.agentVersion}</Td>
                  <Td className="tabular-nums">{Number(f.score).toFixed(2)}</Td>
                  <Td className="tabular-nums">{Number(f.confidence).toFixed(2)}</Td>
                </Tr>
              ))}
            </Tbody>
          </Table>
        </Card>
      </div>
    </div>
  );
}
