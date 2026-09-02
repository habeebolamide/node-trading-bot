import { Link, useParams } from 'react-router-dom';
import { useState } from 'react';
import { Card } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { usePortfolios, usePositions } from '@/hooks/usePortfolios';

export function Portfolios() {
  const { id } = useParams();
  if (id) return <PortfolioDetail id={id} />;
  return <PortfolioList />;
}

function PortfolioList() {
  const q = usePortfolios();
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Paper Portfolios</h1>
      {q.isLoading ? <Skeleton className="h-40" /> : (
        <Card>
          <Table>
            <Thead><Tr><Th>ID</Th><Th>Agent</Th><Th>Cash</Th><Th>Equity</Th><Th>Realized</Th><Th>Max DD</Th></Tr></Thead>
            <Tbody>
              {(q.data?.rows ?? []).map((p) => (
                <Tr key={p.id}>
                  <Td><Link className="font-mono text-xs text-accent hover:underline" to={`/portfolios/${p.id}`}>{p.id.slice(0, 8)}…</Link></Td>
                  <Td className="font-mono text-xs">{p.tradingAgentId.slice(0, 8)}…</Td>
                  <Td className="tabular-nums">${Number(p.cash).toFixed(2)}</Td>
                  <Td className="tabular-nums">${Number(p.equity).toFixed(2)}</Td>
                  <Td className="tabular-nums">${Number(p.realizedPnl).toFixed(2)}</Td>
                  <Td className="tabular-nums">{(Number(p.maxDrawdown) * 100).toFixed(2)}%</Td>
                </Tr>
              ))}
              {(q.data?.rows ?? []).length === 0 && <Tr><Td colSpan={6} className="text-neutral-500">No paper portfolios yet.</Td></Tr>}
            </Tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}

function PortfolioDetail({ id }: { id: string }) {
  const [state, setState] = useState<'OPEN' | 'CLOSED'>('OPEN');
  const q = usePositions(id, state);
  return (
    <div>
      <div className="mb-4 flex items-center gap-3">
        <Link to="/portfolios" className="text-sm text-neutral-400 hover:text-neutral-100">← Portfolios</Link>
        <h1 className="text-lg font-semibold font-mono">{id.slice(0, 12)}…</h1>
        <div className="flex gap-1 rounded-md border border-neutral-800 p-0.5 text-xs">
          {(['OPEN','CLOSED'] as const).map((s) => (
            <button key={s} onClick={() => setState(s)}
              className={`rounded px-2 py-1 ${s === state ? 'bg-accent text-neutral-950' : 'text-neutral-400 hover:text-neutral-100'}`}>
              {s}
            </button>
          ))}
        </div>
      </div>
      {q.isLoading ? <Skeleton className="h-40" /> : (
        <Card>
          <Table>
            <Thead><Tr><Th>Symbol</Th><Th>Direction</Th><Th>Entry</Th><Th>Stop</Th><Th>Size</Th><Th>Remaining</Th><Th>Close reason</Th><Th>Real. P&L</Th><Th>Shadow?</Th></Tr></Thead>
            <Tbody>
              {(q.data?.rows ?? []).map((pos) => (
                <Tr key={pos.id}>
                  <Td>{pos.symbol}</Td>
                  <Td>{pos.direction}</Td>
                  <Td className="tabular-nums">{Number(pos.entryPrice).toFixed(2)}</Td>
                  <Td className="tabular-nums">{Number(pos.currentStop).toFixed(2)}</Td>
                  <Td className="tabular-nums">{Number(pos.size).toFixed(4)}</Td>
                  <Td className="tabular-nums">{Number(pos.remainingSize).toFixed(4)}</Td>
                  <Td className="text-xs">{pos.closeReason ?? '—'}</Td>
                  <Td className="tabular-nums">${Number(pos.realizedPnl).toFixed(2)}</Td>
                  <Td>{pos.isShadow ? <Badge tone="warn">shadow</Badge> : <Badge tone="success">real</Badge>}</Td>
                </Tr>
              ))}
              {(q.data?.rows ?? []).length === 0 && <Tr><Td colSpan={9} className="text-neutral-500">No {state.toLowerCase()} positions.</Td></Tr>}
            </Tbody>
          </Table>
        </Card>
      )}
    </div>
  );
}
