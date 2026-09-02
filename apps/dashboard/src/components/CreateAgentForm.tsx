import { useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useCreateAgent, type CreateAgentBody } from '@/hooks/useCreateAgent';
import { DEFAULT_CONFIG_MEMECOIN, DEFAULT_CONFIG_PERP } from '@/lib/agentDefaults';

/** Inline Create-Agent form on the Agents page. POSTs to /trading-agents (M4). Config is
 *  prefilled from the plan defaults; the operator can edit the JSON before submit. On success
 *  the mutation invalidates the useAgents cache so the list refreshes. */
export function CreateAgentForm({ onClose }: { onClose: () => void }) {
  const create = useCreateAgent();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState<'perp' | 'memecoin'>('perp');
  const [style, setStyle] = useState<'scalp' | 'day' | 'swing'>('day');
  const [universeInput, setUniverseInput] = useState('BTCUSDT, ETHUSDT, SOLUSDT');
  const [configText, setConfigText] = useState(() => JSON.stringify(DEFAULT_CONFIG_PERP, null, 2));

  const onDomainChange = (d: 'perp' | 'memecoin') => {
    setDomain(d);
    // Swap the prefilled config to match the domain. If the user has already edited, warn them.
    const current = configText.trim();
    const perpJson = JSON.stringify(DEFAULT_CONFIG_PERP, null, 2);
    const memeJson = JSON.stringify(DEFAULT_CONFIG_MEMECOIN, null, 2);
    if (current === perpJson || current === memeJson || current === '') {
      setConfigText(JSON.stringify(d === 'perp' ? DEFAULT_CONFIG_PERP : DEFAULT_CONFIG_MEMECOIN, null, 2));
    }
    // Memecoin default is day-suitable; leave the style alone.
    if (d === 'memecoin' && universeInput.trim() === 'BTCUSDT, ETHUSDT, SOLUSDT') {
      setUniverseInput('');
    }
  };

  const submit = () => {
    let config: Record<string, unknown>;
    try {
      config = JSON.parse(configText);
    } catch (e) {
      alert(`Config JSON is invalid: ${String(e)}`);
      return;
    }
    const universe = universeInput.split(',').map((s) => s.trim()).filter(Boolean);
    if (universe.length === 0) { alert('Universe is empty — add at least one symbol/mint.'); return; }
    const body: CreateAgentBody = { name: name.trim(), domain, tradingStyle: style, universe, config };
    create.mutate(body, { onSuccess: () => onClose() });
  };

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span>Create Trading Agent</span>
        <button className="text-xs text-neutral-400 hover:text-neutral-100" onClick={onClose}>close</button>
      </CardHeader>
      <CardBody>
        <div className="grid grid-cols-1 gap-3 md:grid-cols-2">
          <div>
            <label className="text-xs text-neutral-400">Name</label>
            <input value={name} onChange={(e) => setName(e.target.value)}
              placeholder="BTC Perp Scout"
              className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm" />
          </div>
          <div>
            <label className="text-xs text-neutral-400">Domain</label>
            <div className="mt-1 flex gap-1">
              {(['perp', 'memecoin'] as const).map((d) => (
                <button key={d} onClick={() => onDomainChange(d)}
                  className={`flex-1 rounded-md border px-3 py-2 text-sm ${d === domain ? 'border-accent bg-accent/10 text-accent' : 'border-neutral-800 text-neutral-400 hover:text-neutral-100'}`}>
                  {d}
                </button>
              ))}
            </div>
          </div>
          <div>
            <label className="text-xs text-neutral-400">Style</label>
            <select value={style} onChange={(e) => setStyle(e.target.value as 'scalp' | 'day' | 'swing')}
              className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm">
              <option value="scalp">scalp</option><option value="day">day</option><option value="swing">swing</option>
            </select>
          </div>
          <div>
            <label className="text-xs text-neutral-400">Universe (comma-separated)</label>
            <input value={universeInput} onChange={(e) => setUniverseInput(e.target.value)}
              placeholder={domain === 'perp' ? 'BTCUSDT, ETHUSDT' : 'Solana mint addresses…'}
              className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-mono" />
          </div>
          <div className="md:col-span-2">
            <label className="text-xs text-neutral-400">ScoringConfig (JSON — validated server-side)</label>
            <textarea value={configText} onChange={(e) => setConfigText(e.target.value)} rows={16}
              className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 font-mono text-xs" />
            <p className="mt-1 text-xs text-neutral-500">
              Prefilled from the plan defaults (Part II §9 / Part III §3). Edit before submit if you want
              non-default weights. A future edit is a versioned event (rule 16) — do that via
              <code className="mx-1">PATCH /trading-agents/:id</code>.
            </p>
          </div>
        </div>

        {create.isError && (
          <div className="mt-3 rounded-md border border-red-900 bg-red-950/40 px-3 py-2 text-sm text-red-200">
            {(create.error as Error).message}
          </div>
        )}
        {create.isSuccess && (
          <div className="mt-3 rounded-md border border-emerald-900 bg-emerald-950/40 px-3 py-2 text-sm text-emerald-200">
            Created. Fetching the updated agent list…
          </div>
        )}

        <div className="mt-4 flex justify-end gap-2">
          <button onClick={onClose}
            className="rounded-md border border-neutral-800 px-3 py-2 text-sm text-neutral-300 hover:bg-neutral-900">
            Cancel
          </button>
          <button onClick={submit} disabled={create.isPending || !name.trim()}
            className="rounded-md bg-accent px-3 py-2 text-sm font-medium text-neutral-950 hover:bg-cyan-300 disabled:cursor-not-allowed disabled:opacity-50">
            {create.isPending ? 'Creating…' : 'Create Agent'}
          </button>
        </div>

        <div className="mt-3 flex items-center gap-2 text-xs text-neutral-500">
          <Badge tone="warn">rule 20</Badge>
          <span>Paper only — created agent has no live-money path. Editing config is CLI-only (rule 16).</span>
        </div>
      </CardBody>
    </Card>
  );
}
