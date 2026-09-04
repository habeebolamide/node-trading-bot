import { useState } from 'react';
import { useQueryClient } from '@tanstack/react-query';
import { Card, CardBody, CardHeader } from '@/components/ui/Card';
import { apiGet, apiPatch, type ApiError } from '@/lib/api';
import type { AgentRow } from '@/hooks/useAgents';

/**
 * Risk tuner (rule 16 versioned edits). One-field-per-row form for the three risk knobs
 * the operator tunes most often: `minRR`, `riskPercent`, and (perp only) `leverageMax`.
 * Each Save fetches the current config, replaces those numbers, and PATCHes it back — the
 * API creates a NEW `scoring_config` row (rule 16 append-only), old versions stay in history
 * and are switchable via `ConfigVersionSwitcher` above.
 *
 * Not shown here: `agentWeights`, `confidenceWeights`, and `signalThresholds` — those are the
 * auto-tune surface (Predictions tab → Autopsy). This card is for manual research knobs.
 */
export function RiskTuner({ agent }: { agent: AgentRow }) {
  const qc = useQueryClient();
  const cfg = agent.config as { minRR?: number; riskPercent?: number; leverageMax?: number };
  const [minRR, setMinRR] = useState<string>(String(cfg.minRR ?? 1.5));
  const [riskPercent, setRiskPercent] = useState<string>(String(cfg.riskPercent ?? 0.01));
  const [leverageMax, setLeverageMax] = useState<string>(String(cfg.leverageMax ?? 10));
  const [busy, setBusy] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [savedAt, setSavedAt] = useState<number | null>(null);

  const dirty =
    Number(minRR) !== (cfg.minRR ?? 1.5) ||
    Number(riskPercent) !== (cfg.riskPercent ?? 0.01) ||
    (agent.domain === 'perp' && Number(leverageMax) !== (cfg.leverageMax ?? 10));

  async function save(): Promise<void> {
    setBusy(true); setError(null); setSavedAt(null);
    try {
      // Re-fetch current config to avoid clobbering a concurrent change (e.g. auto-tune).
      const fresh = await apiGet<AgentRow>(`/../trading-agents/${agent.id}`);
      const nextConfig = {
        ...(fresh.config as Record<string, unknown>),
        minRR: Number(minRR),
        riskPercent: Number(riskPercent),
        ...(agent.domain === 'perp' ? { leverageMax: Number(leverageMax) } : {}),
      };
      await apiPatch(`/../trading-agents/${agent.id}/config`, nextConfig);
      await Promise.all([
        qc.invalidateQueries({ queryKey: ['agent', agent.id] }),
        qc.invalidateQueries({ queryKey: ['agents'] }),
        qc.invalidateQueries({ queryKey: ['agent.configs', agent.id] }),
      ]);
      setSavedAt(Date.now());
    } catch (e) {
      setError((e as ApiError).message ?? 'save failed');
    } finally {
      setBusy(false);
    }
  }

  return (
    <Card>
      <CardHeader className="flex items-center justify-between">
        <span>Risk tuning (rule 16 — each save writes a new version)</span>
        {savedAt !== null && Date.now() - savedAt < 4_000 && (
          <span className="text-xs text-emerald-300">saved · new version active</span>
        )}
      </CardHeader>
      <CardBody className="space-y-3">
        <div className="grid grid-cols-1 gap-3 md:grid-cols-3">
          <Field
            label="Min R:R"
            hint="Trade Planner refuses NO_TRADE if computed RR falls below this. Lower → more trades, wider PnL distribution. Typical 1.0 – 2.0."
            value={minRR} onChange={setMinRR}
            min="0" step="0.1" placeholder="1.5"
          />
          <Field
            label="Risk per trade"
            hint="Fraction of portfolio to risk per position (SL distance × size = riskPercent × balance). 0.01 = 1%."
            value={riskPercent} onChange={setRiskPercent}
            min="0" max="1" step="0.001" placeholder="0.01"
          />
          {agent.domain === 'perp' && (
            <Field
              label="Max leverage"
              hint="Perp only. Cap the derived leverage the planner computes from size + margin. Bybit's exchange cap still applies on top."
              value={leverageMax} onChange={setLeverageMax}
              min="1" max="100" step="1" placeholder="10"
            />
          )}
        </div>
        {error && <p className="text-xs text-red-300">{error}</p>}
        <div className="flex items-center justify-end gap-2">
          {dirty && !busy && (
            <button
              onClick={() => {
                setMinRR(String(cfg.minRR ?? 1.5));
                setRiskPercent(String(cfg.riskPercent ?? 0.01));
                setLeverageMax(String(cfg.leverageMax ?? 10));
                setError(null);
              }}
              className="rounded-md border border-neutral-800 px-3 py-1 text-xs hover:border-neutral-600">
              Reset
            </button>
          )}
          <button
            disabled={!dirty || busy}
            onClick={save}
            className="rounded-md bg-accent px-3 py-1.5 text-xs font-medium text-neutral-950 hover:bg-cyan-300 disabled:opacity-40">
            {busy ? 'Saving…' : dirty ? 'Save as new version' : 'No changes'}
          </button>
        </div>
      </CardBody>
    </Card>
  );
}

function Field(props: {
  label: string; hint: string; value: string; onChange: (v: string) => void;
  min?: string; max?: string; step?: string; placeholder?: string;
}) {
  return (
    <label className="flex flex-col gap-1">
      <span className="text-xs uppercase tracking-wider text-neutral-400">{props.label}</span>
      <input
        type="number" inputMode="decimal"
        value={props.value} onChange={(e) => props.onChange(e.target.value)}
        min={props.min} max={props.max} step={props.step} placeholder={props.placeholder}
        className="rounded-md border border-neutral-800 bg-neutral-950 px-2 py-1.5 font-mono text-sm text-neutral-100 focus:border-accent focus:outline-none"
      />
      <span className="text-[11px] leading-snug text-neutral-500">{props.hint}</span>
    </label>
  );
}
