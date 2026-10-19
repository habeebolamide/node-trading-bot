import React, { useCallback, useEffect, useState, useRef } from 'react';
import { createRoot } from 'react-dom/client';
import { Decimal } from 'decimal.js';
import '@fontsource-variable/public-sans';
import './style.css';
type Bot = {
  id: string;
  name: string;
  canonicalMarketId: string;
  executionMode: string;
  riskProfile: string;
  operationalStatus: string;
  tradingState: string;
  allocationTargetPercent: string;
  configVersion: number;
};
type Capital = {
  bot_id: string;
  balance: string;
  principal: string;
  unrealized: string;
  actualEquity: string;
  reserved: string;
  committed: string;
  availableBudget: string;
  targetAllocationPercent: string;
};
type Strategy = { id: string; name: string; version: string; status: string };
type Incident = {
  id: string;
  title: string;
  status: string;
  severity: string;
  affected_bots: string[];
  last_seen: string;
  occurrence_count: number;
  evidence: unknown;
  timeline?: { kind: string; created_at: string; evidence: unknown }[];
};
type Row = Record<string, unknown>;
type Report = {
  decisions: {
    bot_id: string;
    decision: string;
    reason_code: string;
    count: number;
  }[];
  rejections: {
    bot_id: string;
    kind: string;
    details: { reason?: string };
    event_time: number;
  }[];
  trades: Row[];
  realizedCurve: { event_time: string; net_pnl: string }[];
  runtimeLeases: { bot_id: string; expires_at: string }[];
  recoveryGaps: Row[];
  observedAt: number;
};
type Delivery = {
  deliveries: Row[];
  workers: {
    id: string;
    stale: boolean;
    observed_at: string;
    telegramConfigured: boolean | null;
  }[];
};
type Preference = {
  scope: string;
  bot_id: string | null;
  enabled: boolean;
  recipient_ref: string | null;
  events: string[];
};
type Snapshot = {
  bots: Bot[];
  capital: { equityBaseline: string; bots: Capital[] };
  strategies: Strategy[];
  incidents: Incident[];
  health: Row[];
  report: Report;
  backtests: Row[];
  preferences: Preference[];
  delivery: Delivery;
  audit: Row[];
  role: string;
};
const money = (x: unknown) => {
  try {
    const amount = new Decimal(String(x ?? 0));
    return amount.toFixed(!amount.isZero() && amount.abs().lt(1) ? 4 : 2);
  } catch {
    return '—';
  }
};
const value = (x: unknown) =>
  x == null ? '—' : typeof x === 'object' ? JSON.stringify(x) : String(x);
const time = (x: unknown) =>
  x
    ? new Date(
        typeof x === 'string' && /^\d+$/.test(x)
          ? Number(x)
          : (x as string | number),
      ).toLocaleString()
    : '—';
const sum = (values: string[]) =>
  values.reduce((n, v) => n.plus(v), new Decimal(0));
function Badge({ children }: { children: React.ReactNode }) {
  return (
    <span
      className={`badge ${/UNRESOLVED|ERROR|DEAD|UNKNOWN|HIGH|CRITICAL/.test(String(children)) ? 'danger' : /RUNNING|CONFIRMED|SENT|COMPLETED|READY/.test(String(children)) ? 'good' : ''}`}
    >
      {children}
    </span>
  );
}
function Table({
  heads,
  rows,
}: {
  heads: string[];
  rows: React.ReactNode[][];
}) {
  return (
    <div className="table-scroll">
      <table>
        <thead>
          <tr>
            {heads.map((h) => (
              <th key={h}>{h}</th>
            ))}
          </tr>
        </thead>
        <tbody>
          {rows.map((row, i) => (
            <tr key={i}>
              {row.map((c, j) => (
                <td key={j}>{c}</td>
              ))}
            </tr>
          ))}
        </tbody>
      </table>
      {!rows.length && <p className="empty">No records yet.</p>}
    </div>
  );
}
function Json({ data }: { data: unknown }) {
  return <pre>{JSON.stringify(data, null, 2)}</pre>;
}
function EquityChart({
  rows,
  baseline,
}: {
  rows: Report['realizedCurve'];
  baseline: string;
}) {
  if (!rows.length)
    return (
      <p className="empty">
        The equity curve will appear after the first realized paper posting.
        Unfilled signals create no P&amp;L.
      </p>
    );
  const ys = rows.map((r) => Number(new Decimal(baseline).plus(r.net_pnl))),
    lo = Math.min(Number(baseline), ...ys),
    hi = Math.max(Number(baseline), ...ys),
    range = hi - lo || 1;
  const first = Number(rows[0]!.event_time),
    last = Number(rows.at(-1)!.event_time),
    duration = last - first || 1;
  const points = rows
    .map(
      (r, i) =>
        `${50 + ((Number(r.event_time) - first) / duration) * 900},${155 - ((ys[i]! - lo) / range) * 120}`,
    )
    .join(' ');
  return (
    <>
      <svg
        className="chart"
        viewBox="0 0 1000 190"
        role="img"
        aria-label={`Simulated realized account equity, ${money(ys[0])} to ${money(ys.at(-1))} USDT. Excludes unrealized P&L.`}
      >
        <line
          x1="50"
          y1="155"
          x2="950"
          y2="155"
          stroke="currentColor"
          opacity=".2"
        />
        <polyline
          fill="none"
          stroke="var(--accent)"
          strokeWidth="2.5"
          points={points}
        />
        <text x="0" y="28">
          {money(hi)}
        </text>
        <text x="0" y="154">
          {money(lo)}
        </text>
      </svg>
      <div className="split muted">
        <span>{time(first)}</span>
        <span>{time(last)}</span>
      </div>
    </>
  );
}
function App() {
  const [token, setToken] = useState(''),
    [draftToken, setDraftToken] = useState(''),
    [data, setData] = useState<Snapshot | null>(null),
    [page, setPage] = useState('Portfolio'),
    [selected, setSelected] = useState<string | null>(null),
    [detail, setDetail] = useState<{
      runtime: Row;
      evaluations: Row[];
      history: unknown;
    } | null>(null),
    [error, setError] = useState(''),
    [notice, setNotice] = useState(''),
    [busy, setBusy] = useState(false),
    [creating, setCreating] = useState(false),
    [run, setRun] = useState<Row | null>(null),
    [incident, setIncident] = useState<Incident | null>(null);
  const sessionRef = useRef(token);
  sessionRef.current = token;
  const api = useCallback(
    async <T,>(
      path: string,
      body?: unknown,
      method = 'POST',
      key?: string,
    ): Promise<T> => {
      const response = await fetch(`/api${path}`, {
        method: body === undefined ? 'GET' : method,
        headers: {
          Authorization: `Bearer ${token}`,
          ...(body === undefined ? {} : { 'Content-Type': 'application/json' }),
          ...(key ? { 'Idempotency-Key': key } : {}),
        },
        ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      });
      const result = await response.json();
      if (!response.ok) {
        if (response.status === 401 && sessionRef.current === token) {
          setData(null);
          setToken('');
          setDraftToken('');
        }
        throw Error(
          result.error?.message ?? `Request failed (${response.status})`,
        );
      }
      return result.data;
    },
    [token],
  );
  const selectedRef = useRef(selected);
  selectedRef.current = selected;
  const cache = useRef<{ token: string; data: Snapshot | null }>({
    token,
    data: null,
  });
  if (cache.current.token !== token) cache.current = { token, data: null };
  const [detailError, setDetailError] = useState('');
  const [detailLoading, setDetailLoading] = useState(false);
  const loadDetail = useCallback(
    async (botId: string) => {
      setDetailLoading(true);
      try {
        const [runtime, evaluations, history] = await Promise.all([
          api<Row>(`/bots/${botId}/runtime`),
          api<Row[]>(`/bots/${botId}/evaluations`),
          api<unknown>(`/bots/${botId}/config-versions`),
        ]);
        if (sessionRef.current === token && selectedRef.current === botId) {
          setDetail({ runtime, evaluations, history });
          setDetailError('');
        }
      } catch (e) {
        if (sessionRef.current === token && selectedRef.current === botId) {
          setDetailError((e as Error).message);
          throw e;
        }
      } finally {
        if (selectedRef.current === botId) setDetailLoading(false);
      }
    },
    [api, token],
  );
  const refresh = useCallback(async () => {
    const previous = cache.current.data;
    const [
      bots,
      capital,
      strategies,
      incidents,
      health,
      report,
      backtests,
      preferences,
      delivery,
      audit,
      session,
    ] = await Promise.all([
      api<Bot[]>('/bots'),
      api<Snapshot['capital']>('/account/capital'),
      previous
        ? Promise.resolve(previous.strategies)
        : api<Strategy[]>('/strategies'),
      api<Incident[]>('/incidents'),
      api<Row[]>('/market-data/health'),
      api<Report>('/account/report'),
      page === 'Reports' || !previous
        ? api<Row[]>('/backtests')
        : Promise.resolve(previous.backtests),
      page === 'Notifications' || !previous
        ? api<Preference[]>('/notifications/preferences')
        : Promise.resolve(previous.preferences),
      page === 'Notifications' || !previous
        ? api<Delivery>('/notifications/delivery-status')
        : Promise.resolve(previous.delivery),
      page === 'Audit trail' || !previous
        ? api<Row[]>('/audit-events')
        : Promise.resolve(previous.audit),
      previous
        ? Promise.resolve({ role: previous.role })
        : api<{ role: string }>('/session'),
    ]);
    if (sessionRef.current === token) {
      const snapshot = {
        bots,
        capital,
        strategies,
        incidents,
        health,
        report,
        backtests,
        preferences,
        delivery,
        audit,
        role: session.role,
      };
      cache.current = { token, data: snapshot };
      setData(snapshot);
      if (selected) await loadDetail(selected);
    }
  }, [api, token, selected, page, loadDetail]);
  useEffect(() => {
    if (!token) return;
    let alive = true,
      loading = false;
    const controller = new AbortController();
    async function load() {
      if (loading || !alive) return;
      loading = true;
      try {
        await refresh();
        if (alive) setError('');
      } catch (e) {
        if (alive) setError((e as Error).message);
      } finally {
        loading = false;
      }
    }
    void load();
    // Authenticated SSE invalidation; a bounded stream reconnects and reauthenticates.
    async function stream() {
      while (alive) {
        try {
          const res = await fetch('/api/events', {
            headers: { Authorization: `Bearer ${token}` },
            signal: controller.signal,
          });
          if (!res.ok) break;
          const reader = res.body?.getReader();
          if (!reader) break;
          while (alive) {
            const chunk = await reader.read();
            if (chunk.done) break;
            void load();
          }
        } catch {
          break;
        }
      }
    }
    void stream();
    const timer = setInterval(() => void load(), 30000);
    return () => {
      alive = false;
      controller.abort();
      clearInterval(timer);
    };
  }, [token, refresh]);
  useEffect(() => {
    setDetail(null);
    setDetailError('');
  }, [selected, token]);
  const mutate = async (fn: () => Promise<unknown>, message: string) => {
    setBusy(true);
    setError('');
    setNotice('');
    try {
      await fn();
      setNotice(message);
      await refresh();
    } catch (e) {
      setError((e as Error).message);
    } finally {
      setBusy(false);
    }
  };
  const owner = data?.role === 'OWNER',
    bot = data?.bots.find((b) => b.id === selected),
    own = data?.capital.bots.find((b) => b.bot_id === selected);
  const nav = (next: string) => {
    setPage(next);
    setSelected(null);
    setNotice('');
    setIncident(null);
    setRun(null);
  };
  if (!token)
    return (
      <main className="login">
        <div className="brand">
          <span className="brand-mark" aria-hidden="true">
            S
          </span>{' '}
          Strategy platform
        </div>
        <h1>
          Your paper portfolio,
          <br />
          in clear view.
        </h1>
        <p>
          Inspect strategy decisions, simulated capital and position protection
          from one operator workspace.
        </p>
        <form
          onSubmit={(e) => {
            e.preventDefault();
            setError('');
            setToken(draftToken.trim());
          }}
        >
          <label>
            API bearer token
            <input
              type="password"
              autoComplete="off"
              required
              pattern="[A-Za-z0-9_-]{43}"
              value={draftToken}
              onChange={(e) => setDraftToken(e.target.value)}
            />
          </label>
          <button type="submit">Open workspace</button>
        </form>
        <p className="muted">
          Use the owner or viewer token issued by the local bootstrap command.
          The token stays in this tab’s memory and is cleared on sign out.
        </p>
        {error && (
          <p role="alert" className="alert">
            {error}
          </p>
        )}
        <footer>
          PAPER environment · All P&amp;L is simulated · LIVE disabled
        </footer>
      </main>
    );
  return (
    <div className="shell">
      <aside>
        <a className="brand" href="#portfolio" onClick={() => nav('Portfolio')}>
          <span className="brand-mark" aria-hidden="true">
            S
          </span>{' '}
          Strategy <br />
          platform
        </a>
        <nav aria-label="Workspace">
          {[
            'Portfolio',
            'Reports',
            'Incidents',
            'Notifications',
            'Audit trail',
          ].map((n) => (
            <button
              className={page === n ? 'active' : ''}
              onClick={() => nav(n)}
              key={n}
              aria-current={page === n ? 'page' : undefined}
            >
              {n}
              {n === 'Incidents' && data
                ? ` (${data.incidents.filter((i) => i.status !== 'RESOLVED').length})`
                : ''}
            </button>
          ))}
        </nav>
        <div className="rail-footer">
          <Badge>PAPER</Badge>
          <p>
            All P&amp;L is simulated.
            <br />
            LIVE trading disabled.
          </p>
          <button
            onClick={() => {
              setToken('');
              setDraftToken('');
              setData(null);
              setSelected(null);
              setDetail(null);
              setRun(null);
            }}
          >
            Sign out
          </button>
        </div>
      </aside>
      <main>
        <header className="split">
          <div>
            <h1>{bot ? bot.name : page}</h1>
            <p className="muted">
              {bot ? bot.canonicalMarketId : 'Paper research & operations'} ·{' '}
              {data?.role ?? 'Connecting'}
            </p>
          </div>
          <div className="header-actions">
            <span className="muted">
              {data
                ? `Updated ${new Date(data.report.observedAt).toLocaleTimeString()}`
                : 'Loading…'}
            </span>
            <button
              onClick={() =>
                void mutate(async () => {}, 'Workspace refreshed.')
              }
              disabled={busy}
            >
              Refresh
            </button>
          </div>
        </header>
        {error && (
          <div role="alert" className="alert">
            {error} <button onClick={() => setError('')}>Dismiss</button>
          </div>
        )}
        {notice && (
          <p role="status" className="notice">
            {notice}
          </p>
        )}
        {!data ? (
          <p role="status" className="empty">
            Loading your portfolio…
          </p>
        ) : (
          <>
            {bot ? (
              <>
                {detailLoading && (
                  <p role="status" className="muted">
                    Refreshing bot evidence…
                  </p>
                )}
                {detailError && (
                  <p role="alert" className="alert">
                    Bot evidence could not refresh: {detailError}. Previously
                    loaded evidence may be stale. Use Refresh to retry.
                  </p>
                )}
                <button
                  className="text-button"
                  onClick={() => setSelected(null)}
                >
                  Back to portfolio
                </button>
                <div className="statusline">
                  <Badge>{bot.executionMode}</Badge>
                  <Badge>{bot.operationalStatus}</Badge>
                  <Badge>{bot.tradingState}</Badge>
                  <span>{bot.riskProfile}</span>
                </div>
                {bot.tradingState !== 'IDLE' && (
                  <div className="alert">
                    <strong>Exposure remains active or unresolved.</strong>{' '}
                    Pause and stop block new entries and request pending-entry
                    cancellation. They do not close a position. Protection and
                    reconciliation continue; unresolved quantities and reserved
                    capital remain until verified.
                  </div>
                )}
                <section>
                  <h2>Market readiness & runtime health</h2>
                  <p>
                    {value(
                      data.health.find(
                        (h) => h.marketKey === bot.canonicalMarketId,
                      )?.reason ??
                        'No fresh market projection recorded. Inspect the runtime process before requesting new entries.',
                    )}
                  </p>
                  <Badge>
                    {data.health.find(
                      (h) => h.marketKey === bot.canonicalMarketId,
                    )?.canEvaluate
                      ? 'READY'
                      : 'ENTRIES BLOCKED'}
                  </Badge>
                  <details>
                    <summary>Runtime checkpoint & fault evidence</summary>
                    <Json data={detail?.runtime.checkpoint} />
                  </details>
                </section>
                <section>
                  <h2>Runtime controls</h2>
                  <form
                    className="inline-form"
                    onSubmit={(e) => {
                      e.preventDefault();
                      const f = new FormData(e.currentTarget);
                      const action = String(f.get('action'));
                      void mutate(
                        () =>
                          api(
                            `/bots/${bot.id}/${action}`,
                            { reason: f.get('reason') },
                            'POST',
                            crypto.randomUUID(),
                          ),
                        'Command accepted. Review its status below; acceptance is not completion.',
                      );
                    }}
                  >
                    <label>
                      Action
                      <select
                        name="action"
                        key={bot.id}
                        defaultValue={
                          bot.operationalStatus === 'STOPPED'
                            ? 'start'
                            : 'pause'
                        }
                      >
                        <option
                          value="start"
                          disabled={
                            bot.operationalStatus !== 'STOPPED' ||
                            bot.tradingState !== 'IDLE'
                          }
                        >
                          Start
                        </option>
                        <option
                          value="pause"
                          disabled={bot.operationalStatus === 'STOPPED'}
                        >
                          Pause new entries
                        </option>
                        <option
                          value="resume"
                          disabled={
                            bot.tradingState === 'UNRESOLVED' ||
                            !!(detail?.runtime.checkpoint as Row | undefined)
                              ?.fault ||
                            (detail?.runtime.checkpoint as Row | undefined)
                              ?.desired !== 'PAUSED'
                          }
                        >
                          Resume
                        </option>
                        <option value="stop">Stop new entries</option>
                      </select>
                    </label>
                    <label className="grow">
                      Reason
                      <input name="reason" required maxLength={500} />
                    </label>
                    <button disabled={!owner || busy}>Request action</button>
                  </form>
                  <p className="muted">
                    Commands are durable and processed by the runtime.
                    Acknowledging an incident never resumes a bot.
                  </p>
                  <Table
                    heads={['Command', 'Status', 'Requested', 'Result']}
                    rows={((detail?.runtime.commands ?? []) as Row[]).map(
                      (c) => [
                        value(c.kind),
                        <Badge>{value(c.status)}</Badge>,
                        time(c.requestedAt),
                        value(c.result),
                      ],
                    )}
                  />
                </section>
                <section>
                  <h2>Capital & configuration</h2>
                  {own && <CapitalTable rows={[own]} bots={data.bots} />}
                  <details>
                    <summary>Configure name and allocation target</summary>
                    <form
                      key={bot.configVersion}
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void mutate(
                          () =>
                            api(
                              `/bots/${bot.id}`,
                              {
                                name: f.get('name'),
                                allocationTargetPercent: f.get('allocation'),
                                expectedVersion: bot.configVersion,
                                reason: f.get('reason'),
                              },
                              'PATCH',
                            ),
                          'Configuration saved. Allocation targets do not transfer capital.',
                        );
                      }}
                    >
                      <label>
                        Name
                        <input
                          name="name"
                          required
                          maxLength={100}
                          defaultValue={bot.name}
                        />
                      </label>
                      <label>
                        Target %
                        <input
                          name="allocation"
                          type="number"
                          min="0"
                          max="80"
                          step="0.000001"
                          required
                          defaultValue={bot.allocationTargetPercent}
                        />
                      </label>
                      <label>
                        Reason
                        <input name="reason" required maxLength={500} />
                      </label>
                      <button
                        disabled={
                          !owner ||
                          busy ||
                          bot.operationalStatus !== 'STOPPED' ||
                          bot.tradingState !== 'IDLE'
                        }
                      >
                        Save configuration
                      </button>
                    </form>
                    <p className="muted">
                      Available only while STOPPED / IDLE. Targets do not
                      rebalance actual equity. Market and strategy are
                      immutable.
                    </p>
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void mutate(
                          () =>
                            api(`/bots/${bot.id}/initial-funding`, {
                              reason: f.get('reason'),
                            }),
                          'Initial paper funding recorded.',
                        );
                      }}
                    >
                      <label>
                        Initial funding reason
                        <input name="reason" required maxLength={500} />
                      </label>
                      <button
                        disabled={
                          !owner ||
                          busy ||
                          new Decimal(own?.principal ?? 0).gt(0)
                        }
                      >
                        Fund initial allocation once
                      </button>
                    </form>
                    <details>
                      <summary>Configuration history</summary>
                      <Json data={detail?.history} />
                    </details>
                  </details>
                </section>
                <section>
                  <h2>Orders & position lifecycle</h2>
                  <p className="muted">
                    Protection is simulated locally. Desired, submitted and
                    confirmed values are separate states.
                  </p>
                  <Table
                    heads={[
                      'Side / state',
                      'Filled / requested',
                      'Closed quantity',
                      'Entry average',
                      'Stop: desired / submitted / confirmed',
                      'Protection / quantity',
                      'Exit reason',
                    ]}
                    rows={((detail?.runtime.trades ?? []) as Row[]).map((t) => [
                      <>
                        {value(t.side)} <Badge>{value(t.state)}</Badge>
                      </>,
                      `${value(t.filledQuantity)} / ${value(t.requestedQuantity)}`,
                      value(t.closedQuantity),
                      value(t.averageEntry),
                      `${value(t.desiredStop)} / ${value(t.submittedStop)} / ${value(t.confirmedStop)}`,
                      `${value(t.protectionStatus)} / ${value(t.protectedQuantity)}`,
                      value(t.closeReason),
                    ])}
                  />
                </section>
                <section>
                  <h2>Durable order intents</h2>
                  <Table
                    heads={[
                      'Intent',
                      'State',
                      'Quantity',
                      'Stop price',
                      'Reason',
                      'Created',
                    ]}
                    rows={((detail?.runtime.actions ?? []) as Row[]).map(
                      (a) => [
                        value(a.kind),
                        <Badge>{value(a.state)}</Badge>,
                        value(a.quantity),
                        value(a.stopPrice),
                        value(a.reason),
                        time(a.createdAt),
                      ],
                    )}
                  />
                </section>
                <section>
                  <h2>Strategy decisions</h2>
                  <Table
                    heads={['Time', 'Decision', 'Reason', 'Evidence']}
                    rows={(detail?.evaluations ?? []).map((e) => [
                      time(e.eventTime),
                      <Badge>{value(e.decision)}</Badge>,
                      value(e.reasonCode),
                      <details>
                        <summary>Indicators & context</summary>
                        <Json data={e.snapshot} />
                      </details>,
                    ])}
                  />
                </section>
                <section>
                  <h2>Activity & health timeline</h2>
                  <Table
                    heads={['Event time', 'Event', 'Transition / evidence']}
                    rows={((detail?.runtime.events ?? []) as Row[]).map((e) => [
                      time(e.eventTime),
                      value(e.kind),
                      <details>
                        <summary>Inspect transition</summary>
                        <Json data={e.details} />
                      </details>,
                    ])}
                  />
                </section>
              </>
            ) : page === 'Portfolio' ? (
              <>
                {data.bots.some((b) => b.tradingState === 'UNRESOLVED') && (
                  <div className="alert" role="alert">
                    <strong>Unresolved exposure requires attention.</strong>
                    <p>
                      New entries remain gated. Pause and stop do not close
                      exposure or release committed capital. Inspect the
                      affected bots:
                    </p>
                    <div className="statusline">
                      {data.bots
                        .filter((b) => b.tradingState === 'UNRESOLVED')
                        .map((b) => (
                          <button
                            className="text-button"
                            key={b.id}
                            onClick={() => setSelected(b.id)}
                          >
                            {b.name}
                          </button>
                        ))}
                    </div>
                  </div>
                )}
                <div className="split section-title">
                  <h2>Account capital</h2>
                  <Badge>SIMULATED · USDT</Badge>
                </div>
                <div className="summary-strip">
                  <div>
                    <span>Account equity</span>
                    <strong>
                      {money(
                        sum(
                          data.capital.bots.map((b) =>
                            new Decimal(b.balance)
                              .minus(b.principal)
                              .plus(b.unrealized)
                              .toString(),
                          ),
                        ).plus(data.capital.equityBaseline),
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Baseline</span>
                    <strong>{money(data.capital.equityBaseline)}</strong>
                  </div>
                  <div>
                    <span>Net realized P&amp;L</span>
                    <strong>
                      {money(
                        sum(
                          data.capital.bots.map((b) =>
                            new Decimal(b.balance)
                              .minus(b.principal)
                              .toString(),
                          ),
                        ),
                      )}
                    </strong>
                  </div>
                  <div>
                    <span>Unrealized P&amp;L</span>
                    <strong>
                      {money(sum(data.capital.bots.map((b) => b.unrealized)))}
                    </strong>
                  </div>
                  <div>
                    <span>Target allocation</span>
                    <strong>
                      {money(
                        sum(data.bots.map((b) => b.allocationTargetPercent)),
                      )}
                      % / 80%
                    </strong>
                  </div>
                </div>
                <section>
                  <div className="split">
                    <h2>
                      Strategy bots{' '}
                      <span className="muted">{data.bots.length}</span>
                    </h2>
                    <button
                      className="primary"
                      disabled={!owner}
                      onClick={() => setCreating(!creating)}
                    >
                      {creating ? 'Close form' : 'Create bot'}
                    </button>
                  </div>
                  {creating && (
                    <CreateBot
                      strategies={data.strategies}
                      busy={busy}
                      submit={(input) =>
                        mutate(async () => {
                          await api('/bots', input);
                          setCreating(false);
                        }, 'Bot created. It is stopped until you request a start.')
                      }
                    />
                  )}
                  {!data.bots.length ? (
                    <div className="empty">
                      <h3>No bots configured</h3>
                      <p>
                        Create a paper bot with a market, strategy and
                        allocation target. Research strategies are draft and
                        have no validated profitability claim.
                      </p>
                    </div>
                  ) : (
                    <Table
                      heads={[
                        'Bot / market',
                        'Runtime',
                        'Lifecycle',
                        'Target',
                        'Actual equity',
                        'Available budget',
                        'Runtime lease',
                      ]}
                      rows={data.bots.map((b) => {
                        const c = data.capital.bots.find(
                            (c) => c.bot_id === b.id,
                          ),
                          lease = data.report.runtimeLeases.find(
                            (l) => l.bot_id === b.id,
                          );
                        return [
                          <button
                            className="bot-link"
                            onClick={() => setSelected(b.id)}
                          >
                            {b.name}
                            <small>{b.canonicalMarketId}</small>
                          </button>,
                          <Badge>{b.operationalStatus}</Badge>,
                          <Badge>{b.tradingState}</Badge>,
                          `${money(b.allocationTargetPercent)}%`,
                          money(c?.actualEquity),
                          money(c?.availableBudget),
                          lease &&
                          new Date(lease.expires_at).getTime() > Date.now()
                            ? 'Leased'
                            : 'No active lease',
                        ];
                      })}
                    />
                  )}
                </section>
                <section>
                  <h2>Allocation target versus actual equity</h2>
                  <p className="muted">
                    Targets allocate initial baseline capital. Each bot
                    compounds its own net simulated results. Changing a target
                    does not transfer equity.
                  </p>
                  <CapitalTable rows={data.capital.bots} bots={data.bots} />
                </section>
                <section>
                  <h2>Market data & recovery</h2>
                  <Table
                    heads={[
                      'Market',
                      'State',
                      'Entry readiness',
                      'Last projection',
                      'Reason',
                    ]}
                    rows={data.health.map((h) => [
                      value(h.marketKey),
                      <Badge>{value(h.state)}</Badge>,
                      h.canEvaluate ? 'Ready' : 'Blocked',
                      time(h.projectionObservedAt),
                      value(h.reason),
                    ])}
                  />
                  <details>
                    <summary>
                      Recovery gaps ({data.report.recoveryGaps.length})
                    </summary>
                    <Json data={data.report.recoveryGaps} />
                  </details>
                </section>
              </>
            ) : page === 'Reports' ? (
              <>
                <section>
                  <h2>Forward paper performance</h2>
                  <ForwardStats report={data.report} />
                  <p className="muted">
                    Simulated realized account equity · USDT · up to 500 ledger
                    timestamps. Unrealized P&amp;L appears separately in
                    Portfolio. Bot and trade tables use a maximum of 200 recent
                    trades.
                  </p>
                  <EquityChart
                    rows={data.report.realizedCurve}
                    baseline={data.capital.equityBaseline}
                  />
                  <Table
                    heads={[
                      'Bot',
                      'Side',
                      'State',
                      'Net realized P&L',
                      'Exit reason',
                    ]}
                    rows={data.report.trades.map((t) => [
                      data.bots.find((b) => b.id === t.bot_id)?.name ??
                        value(t.bot_id),
                      value(t.side),
                      <Badge>{value(t.state)}</Badge>,
                      money(t.net_pnl),
                      value(t.close_reason),
                    ])}
                  />
                </section>
                <section>
                  <h2>Decision quality & risk rejections</h2>
                  <Table
                    heads={['Bot', 'Decision', 'Reason', 'Count']}
                    rows={data.report.decisions.map((d) => [
                      data.bots.find((b) => b.id === d.bot_id)?.name ??
                        d.bot_id,
                      d.decision,
                      d.reason_code,
                      d.count,
                    ])}
                  />
                  <h3>Recent rejected proposals</h3>
                  <Table
                    heads={['Time', 'Bot', 'Reason']}
                    rows={data.report.rejections.map((r) => [
                      time(r.event_time),
                      data.bots.find((b) => b.id === r.bot_id)?.name ??
                        r.bot_id,
                      r.details.reason ?? r.kind,
                    ])}
                  />
                </section>
                <section>
                  <h2>Historical backtests</h2>
                  <p className="muted">
                    Replay results are simulated, dataset dependent and not
                    evidence of future returns. Reports preserve manifest,
                    coverage warnings and untouched holdout stage.
                  </p>
                  <Table
                    heads={['Run', 'Status', 'Created', 'Report']}
                    rows={data.backtests.map((r) => [
                      value(r.id).slice(0, 8),
                      <Badge>{value(r.status)}</Badge>,
                      time(r.createdAt),
                      <button
                        onClick={() =>
                          void mutate(
                            async () =>
                              setRun(await api<Row>(`/backtests/${r.id}`)),
                            'Replay report loaded.',
                          )
                        }
                      >
                        View report
                      </button>,
                    ])}
                  />
                  {run && (
                    <details open>
                      <summary>Replay report · {value(run.status)}</summary>
                      <ReplaySummary run={run} />
                      <details>
                        <summary>Full manifest, metrics & evidence</summary>
                        <Json data={run} />
                      </details>
                    </details>
                  )}
                </section>
              </>
            ) : page === 'Incidents' ? (
              <>
                <p className="muted">
                  Acknowledgment records that an incident was seen. Resolution
                  requires a fresh underlying-fault check; neither action
                  resumes bots.
                </p>
                <Table
                  heads={[
                    'Incident',
                    'Severity',
                    'Status',
                    'Affected bots',
                    'Occurrences',
                    'Last seen',
                    'Details',
                  ]}
                  rows={data.incidents.map((i) => [
                    i.title,
                    <Badge>{i.severity}</Badge>,
                    <Badge>{i.status}</Badge>,
                    i.affected_bots.length,
                    i.occurrence_count,
                    time(i.last_seen),
                    <button
                      onClick={() =>
                        void mutate(
                          async () =>
                            setIncident(
                              await api<Incident>(`/incidents/${i.id}`),
                            ),
                          'Incident timeline loaded.',
                        )
                      }
                    >
                      Inspect
                    </button>,
                  ])}
                />
                {incident && (
                  <section>
                    <h2>{incident.title}</h2>
                    <Badge>{incident.status}</Badge>
                    <Json
                      data={{
                        affectedBots: incident.affected_bots,
                        evidence: incident.evidence,
                        timeline: incident.timeline,
                      }}
                    />
                    <form
                      className="inline-form"
                      onSubmit={(e) => {
                        e.preventDefault();
                        const f = new FormData(e.currentTarget);
                        void mutate(async () => {
                          await api(
                            `/incidents/${incident.id}/${f.get('action')}`,
                            { reason: f.get('reason') },
                          );
                          setIncident(
                            await api<Incident>(`/incidents/${incident.id}`),
                          );
                        }, 'Incident updated. Bot runtime state was not changed.');
                      }}
                    >
                      <label>
                        Action
                        <select name="action">
                          <option value="acknowledge">Acknowledge</option>
                          <option value="resolve">
                            Resolve after verification
                          </option>
                        </select>
                      </label>
                      <label className="grow">
                        Reason
                        <input name="reason" required maxLength={500} />
                      </label>
                      <button
                        disabled={
                          !owner || busy || incident.status === 'RESOLVED'
                        }
                      >
                        Record action
                      </button>
                    </form>
                  </section>
                )}
              </>
            ) : page === 'Notifications' ? (
              <>
                <section>
                  <h2>Telegram delivery</h2>
                  <p>
                    One-way alerts from a separate delivery worker. Trading and
                    protective actions continue independently of Telegram.
                  </p>
                  <p className="muted">
                    Set TELEGRAM_BOT_TOKEN on the notifier process, start it
                    with npm run dev:notifier, then enable a chat below. No
                    individual NO_TRADE or tick alerts are sent. Delivery can be
                    delayed or duplicated after an uncertain acknowledgment.
                  </p>
                  <Table
                    heads={['Worker', 'Health', 'Last seen']}
                    rows={data.delivery.workers.map((w) => [
                      w.id,
                      <Badge>
                        {w.stale
                          ? 'STALE'
                          : w.telegramConfigured === false
                            ? 'NOT CONFIGURED'
                            : 'READY'}
                      </Badge>,
                      time(w.observed_at),
                    ])}
                  />
                  {!data.delivery.workers.length && (
                    <p className="alert">
                      No notification worker heartbeat. Queued deliveries remain
                      in PostgreSQL.
                    </p>
                  )}
                </section>
                <section>
                  <h2>Account & bot preferences</h2>
                  <p className="muted">
                    Account settings route incidents. Bot settings override
                    optional event routing and cannot suppress incident
                    recording. Changes apply to future events; queued deliveries
                    retain their original recipient and payload.
                  </p>
                  {[null, ...data.bots.map((b) => b.id)].map((id) => (
                    <PreferenceForm
                      key={id ?? 'account'}
                      bot={id ? data.bots.find((b) => b.id === id) : undefined}
                      preference={data.preferences.find((p) => p.bot_id === id)}
                      accountDefaults={data.preferences.find(
                        (p) => p.bot_id === null,
                      )}
                      disabled={!owner || busy}
                      submit={(input) =>
                        mutate(
                          () =>
                            api('/notifications/preferences', input, 'PATCH'),
                          'Notification preference saved.',
                        )
                      }
                    />
                  ))}
                </section>
                <section>
                  <h2>Recent deliveries</h2>
                  <Table
                    heads={[
                      'Created',
                      'Type',
                      'Status',
                      'Attempts',
                      'Last error',
                      'Next eligible time',
                    ]}
                    rows={data.delivery.deliveries.map((d) => [
                      time(d.created_at),
                      value(d.template_key),
                      <Badge>{value(d.status)}</Badge>,
                      value(d.attempt_count),
                      value(d.last_error),
                      time(d.available_at),
                    ])}
                  />
                </section>
              </>
            ) : (
              <section>
                <h2>Persistent audit trail</h2>
                <Table
                  heads={['Time', 'Event', 'Bot', 'Correlation', 'Details']}
                  rows={data.audit.map((a) => [
                    time(a.created_at),
                    value(a.event_type),
                    data.bots.find((b) => b.id === a.bot_id)?.name ?? 'Account',
                    value(a.correlation_id),
                    <details>
                      <summary>Inspect audit evidence</summary>
                      <Json data={a.details} />
                    </details>,
                  ])}
                />
              </section>
            )}
          </>
        )}
        <footer>
          Strategy platform · PAPER environment · All P&amp;L is simulated ·
          Production LIVE disabled
        </footer>
      </main>
    </div>
  );
}
function ForwardStats({ report }: { report: Report }) {
  const total = report.decisions.reduce((n, d) => n + d.count, 0),
    noTrade = report.decisions
      .filter((d) => d.decision === 'NO_TRADE')
      .reduce((n, d) => n + d.count, 0);
  const closed = report.trades.filter((t) => t.state === 'CLOSED'),
    wins = closed.filter((t) => new Decimal(String(t.net_pnl)).gt(0)).length;
  return (
    <>
      <Table
        heads={['All-time evaluations', 'NO_TRADE', 'Long / short proposals']}
        rows={[
          [
            total,
            `${noTrade} (${total ? new Decimal(noTrade).div(total).mul(100).toFixed(1) : '0'}%)`,
            `${report.decisions.filter((d) => d.decision === 'LONG').reduce((n, d) => n + d.count, 0)} / ${report.decisions.filter((d) => d.decision === 'SHORT').reduce((n, d) => n + d.count, 0)}`,
          ],
        ]}
      />
      <Table
        heads={[
          'Recent lifecycles',
          'Filled',
          'Expired unfilled',
          'Closed',
          'Closed win rate (net)',
        ]}
        rows={[
          [
            report.trades.length,
            report.trades.filter((t) =>
              new Decimal(String(t.filled_quantity)).gt(0),
            ).length,
            report.trades.filter((t) => t.state === 'EXPIRED').length,
            closed.length,
            closed.length
              ? new Decimal(wins).div(closed.length).mul(100).toFixed(1) + '%'
              : '—',
          ],
        ]}
      />
    </>
  );
}
function ReplaySummary({ run }: { run: Row }) {
  const report = run.report as {
    metrics?: Row;
    warnings?: string[];
    coverage?: unknown;
  } | null;
  return (
    <>
      <p>
        <Badge>{value(run.stage)}</Badge> Variant: {value(run.variant)} ·
        Window: {value(run.windowIndex)}
      </p>
      {report?.metrics && (
        <Table
          heads={['Metric', 'Simulated result']}
          rows={Object.entries(report.metrics)
            .filter(([, v]) => typeof v !== 'object' || v === null)
            .map(([k, v]) => [k, value(v)])}
        />
      )}
      <p className="alert">
        {report?.warnings?.join(' · ') ||
          'Research replay only. No profitability validation or live authorization is implied.'}
      </p>
      <details>
        <summary>Dataset coverage</summary>
        <Json data={report?.coverage} />
      </details>
    </>
  );
}
function CapitalTable({ rows, bots }: { rows: Capital[]; bots: Bot[] }) {
  return (
    <Table
      heads={[
        'Bot',
        'Target',
        'Initial funding',
        'Actual equity',
        'Unrealized P&L',
        'Reserved',
        'Committed',
        'Available budget',
      ]}
      rows={rows.map((c) => [
        bots.find((b) => b.id === c.bot_id)?.name ?? c.bot_id,
        `${money(c.targetAllocationPercent)}%`,
        money(c.principal),
        money(c.actualEquity),
        money(c.unrealized),
        money(c.reserved),
        money(c.committed),
        money(c.availableBudget),
      ])}
    />
  );
}
function CreateBot({
  strategies,
  busy,
  submit,
}: {
  strategies: Strategy[];
  busy: boolean;
  submit: (input: unknown) => Promise<void>;
}) {
  const options = strategies.filter((s) => !s.version.includes('+replay.'));
  return (
    <form
      className="edit-form"
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit({
          name: f.get('name'),
          market: {
            exchange: 'bybit',
            marketType: f.get('marketType'),
            baseAsset: f.get('base'),
            quoteAsset: f.get('quote'),
          },
          strategyVersionId: f.get('strategy'),
          executionMode: f.get('mode'),
          riskProfile: f.get('risk'),
          allocationTargetPercent: f.get('allocation'),
        });
      }}
    >
      <label>
        Name
        <input name="name" required maxLength={100} />
      </label>
      <label>
        Base asset
        <input
          name="base"
          required
          pattern="[a-zA-Z0-9]{2,15}"
          placeholder="BTC"
        />
      </label>
      <label>
        Quote asset
        <input
          name="quote"
          required
          defaultValue="USDT"
          pattern="[a-zA-Z0-9]{2,15}"
        />
      </label>
      <label>
        Market
        <select name="marketType">
          <option value="LINEAR_PERPETUAL">Linear perpetual</option>
          <option value="SPOT">Spot</option>
        </select>
      </label>
      <label>
        Strategy
        <select name="strategy" required>
          {options.map((s) => (
            <option key={s.id} value={s.id}>
              {s.name} {s.version} · {s.status}
            </option>
          ))}
        </select>
      </label>
      <label>
        Execution mode
        <select name="mode">
          <option>PAPER</option>
          <option>SIGNAL_ONLY</option>
        </select>
      </label>
      <label>
        Risk profile
        <select name="risk">
          <option>CONSERVATIVE</option>
          <option>MODERATE</option>
          <option>AGGRESSIVE</option>
        </select>
      </label>
      <label>
        Target allocation %
        <input
          name="allocation"
          required
          type="number"
          min="0"
          max="80"
          step="0.000001"
          defaultValue="20"
        />
      </label>
      <p className="muted">
        Account target limit: 80%. Signal-only requires 0%. One active owner per
        coin. Strategies are draft research configurations.
      </p>
      <button className="primary" disabled={busy || !options.length}>
        Create stopped bot
      </button>
    </form>
  );
}
function PreferenceForm({
  bot,
  preference,
  accountDefaults,
  disabled,
  submit,
}: {
  bot?: Bot;
  preference?: Preference;
  accountDefaults?: Preference;
  disabled: boolean;
  submit: (input: unknown) => Promise<void>;
}) {
  const effective = preference ?? (bot ? accountDefaults : undefined);
  return (
    <form
      className="preference"
      key={JSON.stringify(effective)}
      onSubmit={(e) => {
        e.preventDefault();
        const f = new FormData(e.currentTarget);
        void submit({
          botId: bot?.id ?? null,
          enabled: f.get('enabled') === 'on',
          recipientRef: String(f.get('chat') ?? '').trim() || null,
          events: f.getAll('events'),
        });
      }}
    >
      <h3>{bot?.name ?? 'Account incident routing & defaults'}</h3>
      {bot && !preference && (
        <p className="muted">
          Inheriting account defaults shown below. Saving creates an explicit
          bot override.
        </p>
      )}
      <div className="inline-form">
        <label className="check">
          <input
            type="checkbox"
            name="enabled"
            defaultChecked={effective?.enabled ?? false}
          />
          Enable Telegram
        </label>
        <label>
          Telegram chat ID
          <input
            name="chat"
            pattern="-?[0-9]{1,20}"
            defaultValue={effective?.recipient_ref ?? ''}
          />
        </label>
        <button disabled={disabled}>Save preferences</button>
      </div>
      <fieldset>
        <legend>Optional events</legend>
        {['ENTRY', 'EXIT', 'PROTECTION', 'RECOVERY', 'SIGNAL'].map((event) => (
          <label className="check" key={event}>
            <input
              type="checkbox"
              name="events"
              value={event}
              defaultChecked={(
                effective?.events ?? ['ENTRY', 'EXIT', 'PROTECTION', 'RECOVERY']
              ).includes(event)}
            />
            {event.toLowerCase()}
          </label>
        ))}
      </fieldset>
    </form>
  );
}
createRoot(document.getElementById('root')!).render(
  <React.StrictMode>
    <App />
  </React.StrictMode>,
);
