/**
 * Per-agent Brain-seeding surface (§25 / §30 pre-launch gate — operator request).
 *
 * The CLI (`npm run seed-brain`) stays the power tool; this router is the dashboard's
 * one-button flow: POST kicks off a seed for THE AGENT'S OWN coin (its universe — one symbol
 * per perp agent), the status endpoints tell the UI whether an agent was ever seeded (the
 * "Seed Brain" button only renders for un-seeded agents).
 *
 * Availability guard: seeding replays local candles — if the agent's symbol has no backfilled
 * candles (primary TF for the walk, 1m for outcome resolution), the POST fails fast with the
 * operator-specified message `No backfill for this token` instead of walking 0 bars and writing
 * a hollow gate report (the exact confusion the 2026-09-02 pagination bug produced).
 *
 * The run itself executes in-process, async — MVP single-operator scale. A per-agent in-memory
 * registry prevents double-starts; "seeded" is durable (the seeder's checkpoint marker in
 * `domain_event`), so the button stays hidden across restarts.
 */
import { Router } from 'express';
import { and, eq, gte, lte, sql, count, min, max } from 'drizzle-orm';
import type { Db } from '@tip/database';
import { domainEvent, marketCandle } from '@tip/database';
import { PRIMARY_TF, getTradingAgent, type TradingStyle } from '@tip/trading-agents';
import { seedSymbol, buildGateReport, type GateReport, type SeedStats } from '@tip/seeding';

interface SeedJob {
  state: 'running' | 'done' | 'failed';
  dryRun: boolean;
  startedAt: string;
  finishedAt?: string;
  from: string;
  to: string;
  symbols: string[];
  stats?: SeedStats[];
  report?: GateReport;
  error?: string;
}

const jobs = new Map<string, SeedJob>();

async function seededAgentIds(db: Db): Promise<Set<string>> {
  const rows = await db.execute(sql`
    SELECT DISTINCT payload->>'agentId' AS agent_id
      FROM domain_event
     WHERE type = 'brain-seeding.checkpoint'
  `);
  const out = new Set<string>();
  for (const r of rows as unknown as Iterable<{ agent_id: string | null }>) {
    if (r.agent_id) out.add(r.agent_id);
  }
  return out;
}

export function seedingRouter(db: Db): Router {
  const r = Router();

  /** Status for every agent — one call feeds the whole agents-list column. */
  r.get('/seeding/status', async (_req, res) => {
    const seeded = await seededAgentIds(db);
    const statuses: Record<string, { seeded: boolean; running: boolean; job: SeedJob | null }> = {};
    for (const id of seeded) statuses[id] = { seeded: true, running: false, job: jobs.get(id) ?? null };
    for (const [id, job] of jobs) {
      statuses[id] = { seeded: seeded.has(id) || (job.state === 'done' && !job.dryRun), running: job.state === 'running', job };
    }
    res.json({ statuses });
  });

  r.get('/:id/seed/status', async (req, res) => {
    const seeded = await seededAgentIds(db);
    const job = jobs.get(req.params.id!) ?? null;
    res.json({
      seeded: seeded.has(req.params.id!) || (job?.state === 'done' && !job.dryRun),
      running: job?.state === 'running',
      job,
    });
  });

  r.post('/:id/seed', async (req, res) => {
    const agentId = req.params.id!;
    const agent = await getTradingAgent(db, agentId);
    if (!agent) { res.status(404).json({ error: 'agent not found' }); return; }
    if (agent.domain !== 'perp') {
      // §25 — memecoin has no historical backtest/seeding in MVP, by plan.
      res.status(400).json({ error: 'memecoin agents have no historical Brain seeding (§25)' });
      return;
    }
    const existing = jobs.get(agentId);
    if (existing?.state === 'running') {
      res.status(409).json({ error: 'a seed run is already in progress for this agent' });
      return;
    }

    const symbols = agent.universe;
    const primaryTf = PRIMARY_TF[agent.tradingStyle as TradingStyle];
    const dryRun = Boolean((req.body as { dryRun?: boolean } | undefined)?.dryRun);

    // Backfill availability + default range from what's actually loaded. Both the walk TF and
    // the 1m resolution store must exist, for every symbol the agent trades.
    let rangeFrom: Date | null = null;
    let rangeTo: Date | null = null;
    for (const symbol of symbols) {
      const [primary] = await db.select({ n: count(), from: min(marketCandle.openTime), to: max(marketCandle.openTime) })
        .from(marketCandle)
        .where(and(eq(marketCandle.symbol, symbol), eq(marketCandle.timeframe, primaryTf)));
      const [oneMin] = await db.select({ n: count() })
        .from(marketCandle)
        .where(and(eq(marketCandle.symbol, symbol), eq(marketCandle.timeframe, '1m')));
      if (!primary || Number(primary.n) === 0 || !oneMin || Number(oneMin.n) === 0) {
        res.status(400).json({ error: 'No backfill for this token' });
        return;
      }
      const pFrom = primary.from as Date | null;
      const pTo = primary.to as Date | null;
      if (pFrom && (!rangeFrom || pFrom < rangeFrom)) rangeFrom = pFrom;
      if (pTo && (!rangeTo || pTo > rangeTo)) rangeTo = pTo;
    }

    const body = (req.body ?? {}) as { from?: string; to?: string };
    const from = body.from ? new Date(body.from) : rangeFrom!;
    const to = body.to ? new Date(body.to) : rangeTo!;
    if (isNaN(from.getTime()) || isNaN(to.getTime()) || from >= to) {
      res.status(400).json({ error: 'invalid from/to range' }); return;
    }
    // A requested window with zero candles is the same operator mistake as no backfill at all.
    const [inRange] = await db.select({ n: count() })
      .from(marketCandle)
      .where(and(
        eq(marketCandle.symbol, symbols[0]!), eq(marketCandle.timeframe, primaryTf),
        gte(marketCandle.openTime, from), lte(marketCandle.openTime, to),
      ));
    if (!inRange || Number(inRange.n) === 0) {
      res.status(400).json({ error: 'No backfill for this token' });
      return;
    }

    const job: SeedJob = {
      state: 'running', dryRun, startedAt: new Date().toISOString(),
      from: from.toISOString(), to: to.toISOString(), symbols: [...symbols],
    };
    jobs.set(agentId, job);

    // Fire-and-track: the seed runs async in-process; status endpoints watch the registry.
    void (async () => {
      try {
        const stats: SeedStats[] = [];
        for (const symbol of symbols) {
          stats.push(await seedSymbol({ db, tradingAgentId: agentId, symbols, from, to, dryRun, symbol }));
        }
        const report = await buildGateReport(db, {
          range: { from, to }, symbols: [...symbols],
          configVersion: agent.activeConfigVersion, perSymbol: stats,
        });
        jobs.set(agentId, { ...job, state: 'done', finishedAt: new Date().toISOString(), stats, report });
      } catch (err) {
        jobs.set(agentId, {
          ...job, state: 'failed', finishedAt: new Date().toISOString(),
          error: err instanceof Error ? err.message : String(err),
        });
      }
    })();

    res.status(202).json({ started: true, symbols, from, to, dryRun });
  });

  return r;
}

/** Test-only: reset the in-memory job registry between cases. */
export function clearSeedJobsForTests(): void {
  jobs.clear();
}
