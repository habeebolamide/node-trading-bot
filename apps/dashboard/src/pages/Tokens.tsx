import { useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Skeleton } from '@/components/ui/Skeleton';
import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

interface TokenMemory {
  mint: string; profile: Record<string, unknown>; score: number | null;
  outcomes: { effectiveN: number; winRate: number | null; wilsonLower: number | null; wilsonUpper: number | null; medianReturn: number | null } | null;
  evidence: string;
}

/** MVP token lookup — a mint input hits /api/brain/... via a small proxy endpoint. Real page
 *  would list top-scored tokens; deferred until the token profile ingestion is populated. */
export function Tokens() {
  const [mint, setMint] = useState('');
  const q = useQuery({
    enabled: mint.length > 0,
    queryKey: ['brain.token', mint],
    queryFn: () => apiGet<TokenMemory | null>(`/brain/wallet/${mint}`).catch(() => null),
  });
  return (
    <div>
      <h1 className="mb-4 text-lg font-semibold">Tokens</h1>
      <Card className="mb-4">
        <CardHeader>Lookup by mint (BrainTokenMemory)</CardHeader>
        <CardBody className="flex gap-2">
          <input value={mint} onChange={(e) => setMint(e.target.value)} placeholder="Solana mint address"
            className="flex-1 rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-mono" />
        </CardBody>
      </Card>
      {q.isLoading ? <Skeleton className="h-32" /> : q.data ? (
        <Card>
          <CardHeader>Token profile</CardHeader>
          <CardBody className="text-sm">
            <pre className="max-h-96 overflow-auto whitespace-pre-wrap break-all text-xs text-neutral-300">
{JSON.stringify(q.data, null, 2)}
            </pre>
          </CardBody>
        </Card>
      ) : mint ? <p className="text-sm text-neutral-500">No token memory for this mint yet.</p> : (
        <p className="text-sm text-neutral-500">Enter a Solana mint to look up its BrainTokenMemory record.</p>
      )}
    </div>
  );
}
