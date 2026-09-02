import { useQuery } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { apiGet } from '@/lib/api';

interface SmartMoneyResponse {
  wallets: { walletId: string; score: string; timestamp: string; tradeCount: number; status: string }[];
  clusterRun: { runId: string; runAt: string; windowHours: number; walletCount: number; clusterCount: number } | null;
  clusters: { clusterId: string; members: number }[];
  recentBuys: { id: string; eventTime: string; payload: { wallet?: string; mint?: string; amountSol?: string; walletScore?: number } }[];
  recentConvergences: { id: string; eventTime: string; payload: { mint?: string; wallets?: unknown[]; walletCount?: number } }[];
}

/** Wallet radar (§26/§27 — audit #19). Replaces the M8 placeholder with the live M2/M3 data:
 *  top-scored wallets (latest append-only score per §4), the active funder-cluster run, and the
 *  most recent buy detections / convergence emissions off the durable event log. */
export function SmartMoney() {
  const q = useQuery({ queryKey: ['smart-money'], queryFn: () => apiGet<SmartMoneyResponse>('/smart-money'), refetchInterval: 30_000 });
  if (q.isLoading) return <div><h1 className="mb-4 text-lg font-semibold">Smart Money</h1><Skeleton className="h-64" /></div>;
  const d = q.data;
  const short = (s?: string) => (s && s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s ?? '—');
  const when = (s: string) => new Date(s).toLocaleString();

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Smart Money</h1>
      <div className="grid gap-4 lg:grid-cols-2">
        <Card>
          <CardHeader>Top wallets by score (latest {`"as of now"`} read of the append-only log)</CardHeader>
          {(d?.wallets.length ?? 0) === 0 ? (
            <CardBody className="text-sm text-neutral-500">No rated wallets yet — the M2 seed backfill + scoring pass populates this.</CardBody>
          ) : (
            <Table>
              <Thead><Tr><Th>Wallet</Th><Th>Score</Th><Th>Trades</Th><Th>Scored at</Th></Tr></Thead>
              <Tbody>
                {d!.wallets.slice(0, 25).map((w) => (
                  <Tr key={w.walletId}>
                    <Td className="font-mono text-xs">{short(w.walletId)}</Td>
                    <Td className="tabular-nums">{Number(w.score).toFixed(1)}</Td>
                    <Td className="tabular-nums">{w.tradeCount}</Td>
                    <Td className="text-xs text-neutral-400">{when(w.timestamp)}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader className="flex items-center gap-2">
            <span>Funder clusters (§5 dedup)</span>
            {d?.clusterRun && <Badge tone="info">run {when(d.clusterRun.runAt)} · {d.clusterRun.clusterCount} clusters / {d.clusterRun.walletCount} wallets</Badge>}
          </CardHeader>
          {(d?.clusters.length ?? 0) === 0 ? (
            <CardBody className="text-sm text-neutral-500">No active cluster run — clustering runs once funded-wallet data exists.</CardBody>
          ) : (
            <Table>
              <Thead><Tr><Th>Cluster</Th><Th>Members</Th></Tr></Thead>
              <Tbody>
                {d!.clusters.slice(0, 25).map((c) => (
                  <Tr key={c.clusterId}>
                    <Td className="font-mono text-xs">{short(c.clusterId)}</Td>
                    <Td className="tabular-nums">{c.members}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader>Recent watched-wallet buys</CardHeader>
          {(d?.recentBuys.length ?? 0) === 0 ? (
            <CardBody className="text-sm text-neutral-500">No buy detections yet.</CardBody>
          ) : (
            <Table>
              <Thead><Tr><Th>When</Th><Th>Wallet</Th><Th>Mint</Th><Th>SOL</Th><Th>Score@T</Th></Tr></Thead>
              <Tbody>
                {d!.recentBuys.map((e) => (
                  <Tr key={e.id}>
                    <Td className="text-xs text-neutral-400">{when(e.eventTime)}</Td>
                    <Td className="font-mono text-xs">{short(e.payload.wallet)}</Td>
                    <Td className="font-mono text-xs">{short(e.payload.mint)}</Td>
                    <Td className="tabular-nums">{e.payload.amountSol ?? '—'}</Td>
                    <Td className="tabular-nums">{e.payload.walletScore?.toFixed?.(1) ?? '—'}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>

        <Card>
          <CardHeader>Recent convergences (≥2 cluster-distinct wallets on one mint)</CardHeader>
          {(d?.recentConvergences.length ?? 0) === 0 ? (
            <CardBody className="text-sm text-neutral-500">No convergence emissions yet.</CardBody>
          ) : (
            <Table>
              <Thead><Tr><Th>When</Th><Th>Mint</Th><Th>Wallets</Th></Tr></Thead>
              <Tbody>
                {d!.recentConvergences.map((e) => (
                  <Tr key={e.id}>
                    <Td className="text-xs text-neutral-400">{when(e.eventTime)}</Td>
                    <Td className="font-mono text-xs">{short(e.payload.mint)}</Td>
                    <Td className="tabular-nums">{e.payload.walletCount ?? (Array.isArray(e.payload.wallets) ? e.payload.wallets.length : '—')}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
        </Card>
      </div>
    </div>
  );
}
