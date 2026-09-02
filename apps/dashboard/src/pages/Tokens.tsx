import { useState } from 'react';
import { useQuery } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { apiGet } from '@/lib/api';

interface TokenOutcomes { effectiveN: number; winRate: number | null; wilsonLower: number | null; wilsonUpper: number | null; medianReturn: number | null }
interface TokenMemory {
  mint: string; profile: Record<string, unknown>; score: number | null;
  outcomes: TokenOutcomes | null; evidence: string;
}
interface TopTokenRow {
  mint: string; score: string | null; evidence: string; outcomes: TokenOutcomes | null;
  profile: Record<string, unknown>; updatedAt: string; symbol: string | null; name: string | null;
}

/** Tokens page (§26 — audit #20). Top-scored BrainTokenMemory listing + point lookup. The
 *  lookup previously hit the WALLET brain endpoint by mistake — now /api/brain/token/:mint. */
export function Tokens() {
  const [mint, setMint] = useState('');
  const top = useQuery({
    queryKey: ['tokens.top'],
    queryFn: () => apiGet<{ tokens: TopTokenRow[]; count: number }>('/tokens/top'),
  });
  const lookup = useQuery({
    enabled: mint.length > 0,
    queryKey: ['brain.token', mint],
    queryFn: () => apiGet<TokenMemory | null>(`/brain/token/${mint}`).catch(() => null),
  });
  const short = (s: string) => (s.length > 12 ? `${s.slice(0, 6)}…${s.slice(-4)}` : s);
  const pct = (v: number | null | undefined) => (v === null || v === undefined ? '—' : (v * 100).toFixed(1) + '%');

  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Tokens</h1>

      <Card className="mb-4">
        <CardHeader>Top tokens by Brain score</CardHeader>
        {top.isLoading ? <CardBody><Skeleton className="h-40" /></CardBody>
          : (top.data?.tokens.length ?? 0) === 0 ? (
            <CardBody className="text-sm text-neutral-500">
              No BrainTokenMemory rows yet — token scoring populates this as memecoin activity is ingested.
            </CardBody>
          ) : (
            <Table>
              <Thead><Tr><Th>Token</Th><Th>Mint</Th><Th>Score</Th><Th>Evidence</Th><Th>eff-n</Th><Th>Win rate</Th><Th>Median return</Th><Th>Updated</Th></Tr></Thead>
              <Tbody>
                {top.data!.tokens.map((t) => (
                  <Tr key={t.mint} className="cursor-pointer hover:bg-neutral-900" onClick={() => setMint(t.mint)}>
                    <Td>{t.symbol ?? t.name ?? '—'}</Td>
                    <Td className="font-mono text-xs">{short(t.mint)}</Td>
                    <Td className="tabular-nums">{t.score === null ? '—' : Number(t.score).toFixed(1)}</Td>
                    <Td><Badge tone={t.evidence === 'SUFFICIENT' ? 'success' : 'neutral'}>{t.evidence}</Badge></Td>
                    <Td className="tabular-nums">{t.outcomes?.effectiveN?.toFixed?.(1) ?? '—'}</Td>
                    <Td className="tabular-nums">{pct(t.outcomes?.winRate)}</Td>
                    <Td className="tabular-nums">{pct(t.outcomes?.medianReturn)}</Td>
                    <Td className="text-xs text-neutral-400">{new Date(t.updatedAt).toLocaleDateString()}</Td>
                  </Tr>
                ))}
              </Tbody>
            </Table>
          )}
      </Card>

      <Card className="mb-4">
        <CardHeader>Lookup by mint (BrainTokenMemory)</CardHeader>
        <CardBody className="flex gap-2">
          <input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Solana mint address"
            className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-mono" />
        </CardBody>
      </Card>
      {lookup.isLoading ? <Skeleton className="h-32" /> : lookup.data ? (
        <Card>
          <CardHeader>Token profile</CardHeader>
          <CardBody className="text-sm">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-300">
{JSON.stringify(lookup.data, null, 2)}
            </pre>
          </CardBody>
        </Card>
      ) : mint ? <p className="text-sm text-neutral-500">No token memory for this mint yet.</p> : null}
    </div>
  );
}
