import { useState } from 'react';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { Badge } from '@/components/ui/Badge';
import { useCreateAgent, type CreateAgentBody } from '@/hooks/useCreateAgent';
import { DEFAULT_CONFIG_MEMECOIN, DEFAULT_CONFIG_PERP, DEFAULT_CONFIG_PERP_SEED } from '@/lib/agentDefaults';

/** Inline Create-Agent form on the Agents page. POSTs to /trading-agents (M4). Config is
 *  prefilled from the plan defaults; the operator can edit the JSON before submit. On success
 *  the mutation invalidates the useAgents cache so the list refreshes. */
export function CreateAgentForm({ onClose }: { onClose: () => void }) {
  const create = useCreateAgent();
  const [name, setName] = useState('');
  const [domain, setDomain] = useState<'perp' | 'memecoin'>('perp');
  const [style, setStyle] = useState<'scalp' | 'day' | 'swing'>('day');
  const [universeInput, setUniverseInput] = useState('BTCUSDT');
  const [profile, setProfile] = useState<'live' | 'seed'>('live');
  const [configText, setConfigText] = useState(() => JSON.stringify(DEFAULT_CONFIG_PERP, null, 2));
  const [useJudge, setUseJudge] = useState(true);

  // Swap the prefilled perp config between the full live roster and the seed profile
  // (positioning + liquidation zeroed). Only overwrites if the user hasn't hand-edited.
  const onProfileChange = (p: 'live' | 'seed') => {
    setProfile(p);
    if (domain !== 'perp') return;
    const current = configText.trim();
    const liveJson = JSON.stringify(DEFAULT_CONFIG_PERP, null, 2);
    const seedJson = JSON.stringify(DEFAULT_CONFIG_PERP_SEED, null, 2);
    if (current === liveJson || current === seedJson || current === '') {
      setConfigText(p === 'seed' ? seedJson : liveJson);
    }
  };

  const onDomainChange = (d: 'perp' | 'memecoin') => {
    setDomain(d);
    // Swap the prefilled config to match the domain. If the user has already edited, warn them.
    const current = configText.trim();
    const perpJson = JSON.stringify(DEFAULT_CONFIG_PERP, null, 2);
    const seedJson = JSON.stringify(DEFAULT_CONFIG_PERP_SEED, null, 2);
    const memeJson = JSON.stringify(DEFAULT_CONFIG_MEMECOIN, null, 2);
    if (current === perpJson || current === seedJson || current === memeJson || current === '') {
      const perpCfg = profile === 'seed' ? DEFAULT_CONFIG_PERP_SEED : DEFAULT_CONFIG_PERP;
      setConfigText(JSON.stringify(d === 'perp' ? perpCfg : DEFAULT_CONFIG_MEMECOIN, null, 2));
    }
    if (d === 'memecoin') {
      // Memecoin agents don't pre-declare a token list — they REACT to watched-wallet buys via
      // the M3 watchlist. The api still requires a non-empty universe[], so 'SOLANA' is a
      // sentinel scope label. Style is meaningful only for Signal-TTL (§8, 10m/30m/2h), so
      // we default it to 'day' and hide the field.
      setUniverseInput('SOLANA');
      setStyle('day');
    } else if (universeInput.trim() === 'SOLANA' || universeInput.trim() === '' || universeInput.includes(',')) {
      setUniverseInput('BTCUSDT');
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
    // Merge the useJudge toggle for perp agents; memecoin ignores it. Checkbox wins over JSON.
    if (domain === 'perp') config.useJudge = useJudge;
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
          {domain === 'perp' && (
            <>
              <div>
                <label className="text-xs text-neutral-400">Style</label>
                <select value={style} onChange={(e) => setStyle(e.target.value as 'scalp' | 'day' | 'swing')}
                  className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm">
                  <option value="scalp">scalp (5m primary TF)</option>
                  <option value="day">day (1h primary TF)</option>
                  <option value="swing">swing (4h primary TF)</option>
                </select>
              </div>
              <div>
                <label className="text-xs text-neutral-400">Symbol (one per agent — create additional agents for more)</label>
                <select value={universeInput} onChange={(e) => setUniverseInput(e.target.value)}
                  className="mt-1 w-full rounded-md border border-neutral-800 bg-neutral-950 px-3 py-2 text-sm font-mono">
                  <option value="BTCUSDT">BTCUSDT</option>
                  <option value="ETHUSDT">ETHUSDT</option>
                  <option value="SOLUSDT">SOLUSDT</option>
                </select>
              </div>
              <div className="md:col-span-2">
                <label className="text-xs text-neutral-400">Weight profile</label>
                <div className="mt-1 flex gap-1">
                  {([
                    ['live', 'Live roster', 'All 8 agents. Use when trading live from day one.'],
                    ['seed', 'Seed profile', 'positioning + liquidation zeroed — they can\'t be seeded (no Bybit history). Use when you\'ll backfill + seed this agent.'],
                  ] as const).map(([key, label, hint]) => (
                    <button key={key} type="button" onClick={() => onProfileChange(key)}
                      title={hint}
                      className={`flex-1 rounded-md border px-3 py-2 text-left text-sm ${key === profile ? 'border-accent bg-accent/10 text-accent' : 'border-neutral-800 text-neutral-400 hover:text-neutral-100'}`}>
                      {label}
                    </button>
                  ))}
                </div>
                <p className="mt-1 text-[11px] leading-snug text-neutral-500">
                  {profile === 'seed'
                    ? 'positioning + liquidation set to 0 (no historical data to seed them). They fire once live — bump their weights on the Configuration tab after they build a track record.'
                    : 'Full 8-agent roster per Part III §3.'}
                </p>
              </div>
            </>
          )}
          {domain === 'memecoin' && (
            <div className="md:col-span-2 rounded-md border border-neutral-800 bg-neutral-900/60 px-3 py-2 text-xs text-neutral-300">
              Memecoin agents don't pre-declare a token list — they REACT to buys from wallets on the M3
              watchlist. Style defaults to <code>day</code> (drives Signal-TTL only per §8, memecoin
              10m/30m/2h). No universe field needed here.
              <p className="mt-1 text-neutral-500">
                To adjust either later: <code>PATCH /trading-agents/:id</code>.
              </p>
            </div>
          )}
          {domain === 'perp' && (
            <div className="md:col-span-2">
              <label className="flex items-start gap-3 rounded-md border border-neutral-800 bg-neutral-900/40 p-3">
                <input type="checkbox" checked={useJudge}
                  onChange={(e) => setUseJudge(e.target.checked)}
                  className="mt-1 h-4 w-4 accent-accent" />
                <span className="flex flex-col gap-0.5">
                  <span className="text-sm text-neutral-100">Use LLM Judge (§18)</span>
                  <span className="text-[11px] leading-snug text-neutral-500">
                    When on, each perp signal is reviewed by DeepSeek Judge — it can FLIP direction,
                    DEFER, or STAND_ASIDE within the §18 override gate. When off, this agent uses the
                    deterministic composite direction (faster, no LLM cost). Change later on the
                    Configuration tab.
                  </span>
                </span>
              </label>
            </div>
          )}
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
