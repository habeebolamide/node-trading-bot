import { useState } from 'react';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { Skeleton } from '@/components/ui/Skeleton';
import { Table, Thead, Th, Tbody, Tr, Td } from '@/components/ui/Table';
import { apiGet, apiPost, type ApiError } from '@/lib/api';
import { fmtDate, fmtDateTime } from '@/lib/format';

interface VersionRow {
  version: number;
  active: boolean;
  createdAt: string;
  config: {
    agentWeights?: Record<string, number>;
    startingBalance?: number;
    [k: string]: unknown;
  };
}
interface Response { activeVersion: number; versions: VersionRow[] }

/**
 * Config version history + one-click switch (§Rule 16). Every `scoring_config` row for the
 * agent, most-recent first. Clicking "Switch to vN" flips the active flag via
 * `POST /trading-agents/:id/active-config` after a confirmation modal.
 *
 * Refuses server-side when the agent has an OPEN or PENDING_ENTRY position — avoids mid-trade
 * config flip that would mix attribution across versions.
 */
export function ConfigVersionSwitcher({ agentId }: { agentId: string }) {
  const qc = useQueryClient();
  const [pending, setPending] = useState<number | null>(null);
  const [error, setError] = useState<string | null>(null);
  const [busy, setBusy] = useState(false);

  const q = useQuery({
    queryKey: ['agent.configs', agentId],
    queryFn: () => apiGet<Response>(`/../trading-agents/${agentId}/configs`),
  });

  if (q.isLoading) return <Card><CardBody><Skeleton className="h-32" /></CardBody></Card>;
  if (!q.data) return null;
  const versions = q.data.versions;
  const activeVersion = q.data.activeVersion;
  const activeConfig = versions.find((v) => v.version === activeVersion);
  const target = pending !== null ? versions.find((v) => v.version === pending) : null;

  return (
    <>
      <Card>
        <CardHeader className="flex items-center gap-2">
          <span>Config versions</span>
          <Badge tone="info">active: v{activeVersion}</Badge>
        </CardHeader>
        <Table>
          <Thead><Tr><Th>Version</Th><Th>Created</Th><Th>Weights summary</Th><Th></Th></Tr></Thead>
          <Tbody>
            {versions.map((v) => {
              const weights = Object.entries(v.config.agentWeights ?? {})
                .sort((a, b) => b[1] - a[1]).slice(0, 3)
                .map(([k, w]) => `${k.replace('perp.', '')} ${(w * 100).toFixed(0)}%`)
                .join(' · ');
              return (
                <Tr key={v.version}>
                  <Td className="tabular-nums">v{v.version}</Td>
                  <Td className="text-xs text-neutral-400 tabular-nums">{fmtDateTime(v.createdAt)}</Td>
                  <Td className="text-xs">{weights || <span className="text-neutral-500">—</span>}</Td>
                  <Td>
                    {v.active
                      ? <Badge tone="success">active</Badge>
                      : <button onClick={() => { setError(null); setPending(v.version); }}
                          className="rounded-md border border-accent/60 px-2 py-1 text-xs text-accent hover:bg-accent/10">
                          Switch to v{v.version}
                        </button>}
                  </Td>
                </Tr>
              );
            })}
          </Tbody>
        </Table>
        {error && <CardBody><p className="text-xs text-red-300">{error}</p></CardBody>}
      </Card>

      {target && activeConfig && (
        <div className="fixed inset-0 z-50 flex items-center justify-center bg-black/60 p-4"
             onClick={() => setPending(null)}>
          <div className="max-w-lg rounded-lg border border-neutral-800 bg-neutral-950 p-6 text-sm"
               onClick={(e) => e.stopPropagation()}>
            <h2 className="mb-2 text-base font-semibold">Switch active config?</h2>
            <div className="mb-3 grid grid-cols-2 gap-3 text-xs">
              <div>
                <div className="text-neutral-500">Currently active</div>
                <div className="mt-1 font-mono">v{activeConfig.version}</div>
                <div className="mt-1 text-neutral-400">{fmtDate(activeConfig.createdAt)}</div>
              </div>
              <div>
                <div className="text-neutral-500">Switching to</div>
                <div className="mt-1 font-mono text-accent">v{target.version}</div>
                <div className="mt-1 text-neutral-400">{fmtDate(target.createdAt)}</div>
              </div>
            </div>
            <div className="mb-3 rounded-md border border-neutral-800 bg-neutral-900 p-2 text-xs">
              <div className="mb-1 uppercase tracking-wider text-neutral-500">Weight changes</div>
              <ul className="space-y-0.5 font-mono">
                {diffWeights(activeConfig.config.agentWeights ?? {}, target.config.agentWeights ?? {}).map((d, i) => (
                  <li key={i}>
                    <span className="text-neutral-400">{d.agent}</span>{' '}
                    <span className="text-neutral-500">{(d.from * 100).toFixed(1)}% → </span>
                    <span className={d.delta > 0 ? 'text-emerald-300' : d.delta < 0 ? 'text-red-300' : 'text-neutral-100'}>
                      {(d.to * 100).toFixed(1)}%
                    </span>
                  </li>
                ))}
              </ul>
            </div>
            <p className="mb-3 text-xs text-amber-300">
              ⚠ New signals will score under v{target.version}. Existing predictions stay
              attributed to their original version (rule 16 — never blends). Refused if the
              agent has an OPEN position — close it first.
            </p>
            <div className="flex justify-end gap-2">
              <button onClick={() => setPending(null)}
                className="rounded-md border border-neutral-800 px-3 py-1 text-xs hover:border-neutral-600">
                Cancel
              </button>
              <button
                disabled={busy}
                onClick={() => {
                  setBusy(true); setError(null);
                  apiPost(`/../trading-agents/${agentId}/active-config`, { version: target.version })
                    .then(() => {
                      qc.invalidateQueries({ queryKey: ['agent.configs', agentId] });
                      qc.invalidateQueries({ queryKey: ['agent', agentId] });
                      setPending(null);
                    })
                    .catch((e: ApiError) => setError(e.message))
                    .finally(() => setBusy(false));
                }}
                className="rounded-md bg-accent px-3 py-1 text-xs font-medium text-neutral-950 hover:bg-cyan-300 disabled:opacity-50">
                {busy ? 'Switching…' : `Switch to v${target.version}`}
              </button>
            </div>
          </div>
        </div>
      )}
    </>
  );
}

function diffWeights(a: Record<string, number>, b: Record<string, number>) {
  const keys = new Set([...Object.keys(a), ...Object.keys(b)]);
  const out: { agent: string; from: number; to: number; delta: number }[] = [];
  for (const k of keys) {
    const from = a[k] ?? 0;
    const to = b[k] ?? 0;
    out.push({ agent: k, from, to, delta: to - from });
  }
  return out.sort((x, y) => Math.abs(y.delta) - Math.abs(x.delta));
}
