import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { apiGet, apiPost, type ApiError } from '@/lib/api';

interface CoveragePerTf { timeframe: string; rows: number; from: string | null; to: string | null }
interface BackfillProgress { timeframe: string; fetched: number; inserted: number }
interface BackfillJob {
  state: 'running' | 'done' | 'failed';
  months: number; from: string; to: string; startedAt: string; finishedAt?: string;
  progress: BackfillProgress[];
  funding?: BackfillProgress;
  openInterest?: BackfillProgress;
  error?: string;
}
interface SymbolCoverage {
  symbol: string;
  perTf: CoveragePerTf[];
  funding: { rows: number; from: string | null; to: string | null };
  openInterest: { rows: number; from: string | null; to: string | null };
  job: BackfillJob | null;
}

/**
 * Data foundation page (§25 pre-launch prep). Per-symbol candle + funding + OI coverage,
 * with a Backfill button that kicks off the Bybit REST pull for the last N months. Perp
 * only — memecoin has no historical backfill in MVP (§25).
 *
 * The seed-brain button on the Agents page depends on this data being loaded; when it says
 * "No backfill for this token" you fix it from here.
 */
export function Data() {
  const q = useQuery({
    queryKey: ['backfill.status'],
    queryFn: () => apiGet<{ symbols: SymbolCoverage[] }>('/backfill/status'),
    refetchInterval: (query) =>
      (query.state.data?.symbols ?? []).some((s) => s.job?.state === 'running') ? 4_000 : 30_000,
  });
  const short = (s: string | null) => (s ? s.slice(0, 10) : '—');

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Data Foundation</h1>
      <p className="mb-4 text-sm text-neutral-400">
        Bybit klines + funding + open-interest per symbol. Backfilling one symbol takes a few
        minutes (390k 1m candles for a 9-month range). Perp only — memecoin has no historical
        backfill in MVP (§25).
      </p>
      {q.isLoading ? <Skeleton className="h-40" /> : (
        <div className="space-y-4">
          {(q.data?.symbols ?? []).map((s) => (
            <SymbolCard key={s.symbol} coverage={s} shortDate={short} />
          ))}
        </div>
      )}
    </div>
  );
}

function SymbolCard({ coverage, shortDate }: { coverage: SymbolCoverage; shortDate: (s: string | null) => string }) {
  const qc = useQueryClient();
  const [months, setMonths] = useState(9);
  const [error, setError] = useState<string | null>(null);
  const [starting, setStarting] = useState(false);
  const job = coverage.job;
  const running = job?.state === 'running';
  const anyRows = coverage.perTf.some((t) => t.rows > 0);

  return (
    <Card>
      <CardHeader className="flex items-center justify-between gap-3">
        <div className="flex items-center gap-2">
          <span className="font-semibold">{coverage.symbol}</span>
          {anyRows ? (
            <Badge tone="success">loaded</Badge>
          ) : (
            <Badge tone="warn">empty</Badge>
          )}
          {running && <Badge tone="info">backfilling…</Badge>}
          {job?.state === 'done' && <Badge tone="success">last run ok</Badge>}
          {job?.state === 'failed' && <Badge tone="danger">last run failed</Badge>}
        </div>
        <div className="flex items-center gap-2">
          <select value={months} onChange={(e) => setMonths(Number(e.target.value))}
            disabled={running}
            className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1 text-xs">
            {[3, 6, 9, 12, 18, 24].map((m) => <option key={m} value={m}>{m} months</option>)}
          </select>
          <button
            disabled={running || starting}
            onClick={() => {
              setError(null); setStarting(true);
              apiPost(`/backfill/${coverage.symbol}/run`, { months })
                .then(() => qc.invalidateQueries({ queryKey: ['backfill.status'] }))
                .catch((e: ApiError) => setError(e.message))
                .finally(() => setStarting(false));
            }}
            className="rounded-md border border-accent/60 px-3 py-1 text-xs font-medium text-accent hover:bg-accent/10 disabled:opacity-50">
            {starting ? 'Starting…' : running ? 'Running…' : anyRows ? 'Re-run backfill' : 'Backfill'}
          </button>
        </div>
      </CardHeader>
      <CardBody className="text-sm">
        {error && <p className="mb-2 text-red-300">{error}</p>}
        {job?.error && <p className="mb-2 text-red-300">Last error: {job.error}</p>}
        <Table>
          <Thead>
            <Tr><Th>Timeframe</Th><Th>Rows</Th><Th>From</Th><Th>To</Th><Th>Last run</Th></Tr>
          </Thead>
          <Tbody>
            {coverage.perTf.map((t) => {
              const jp = job?.progress.find((p) => p.timeframe === t.timeframe);
              return (
                <Tr key={t.timeframe}>
                  <Td>{t.timeframe}</Td>
                  <Td className="tabular-nums">{t.rows.toLocaleString()}</Td>
                  <Td className="text-xs">{shortDate(t.from)}</Td>
                  <Td className="text-xs">{shortDate(t.to)}</Td>
                  <Td className="text-xs text-neutral-400">
                    {jp ? `fetched ${jp.fetched.toLocaleString()} / ins ${jp.inserted.toLocaleString()}` : '—'}
                  </Td>
                </Tr>
              );
            })}
            <Tr>
              <Td>funding</Td>
              <Td className="tabular-nums">{coverage.funding.rows.toLocaleString()}</Td>
              <Td className="text-xs">{shortDate(coverage.funding.from)}</Td>
              <Td className="text-xs">{shortDate(coverage.funding.to)}</Td>
              <Td className="text-xs text-neutral-400">
                {job?.funding ? `fetched ${job.funding.fetched} / ins ${job.funding.inserted}` : '—'}
              </Td>
            </Tr>
            <Tr>
              <Td>open interest</Td>
              <Td className="tabular-nums">{coverage.openInterest.rows.toLocaleString()}</Td>
              <Td className="text-xs">{shortDate(coverage.openInterest.from)}</Td>
              <Td className="text-xs">{shortDate(coverage.openInterest.to)}</Td>
              <Td className="text-xs text-neutral-400">
                {job?.openInterest ? `fetched ${job.openInterest.fetched} / ins ${job.openInterest.inserted}` : '—'}
              </Td>
            </Tr>
          </Tbody>
        </Table>
      </CardBody>
    </Card>
  );
}
