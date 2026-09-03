import { Router } from 'express';
import { and, desc, eq, inArray } from 'drizzle-orm';
import { ValidationError } from '@tip/domain';
import { paperPosition, scoringConfig, tradingAgent, type Db } from '@tip/database';
import { createPortfolio } from '@tip/paper-engine';
import {
  createTradingAgent, getTradingAgent, listTradingAgents, updateTradingAgentConfig,
  type CreateTradingAgentInput,
} from '@tip/trading-agents';

/**
 * TradingAgent CRUD (§8, §14, §16). All routes take/return JSON. Validation errors → 400;
 * not-found → 404; anything else bubbles to Express default (500).
 */
export function tradingAgentsRouter(db: Db): Router {
  const r = Router();

  r.post('/', async (req, res) => {
    const body = (req.body ?? {}) as Partial<CreateTradingAgentInput>;
    if (typeof body.name !== 'string' || !body.name.trim()) {
      res.status(400).json({ error: 'name (string) is required' });
      return;
    }
    if (body.domain !== 'perp' && body.domain !== 'memecoin') {
      res.status(400).json({ error: 'domain must be "perp" | "memecoin"' });
      return;
    }
    if (body.tradingStyle !== 'scalp' && body.tradingStyle !== 'day' && body.tradingStyle !== 'swing') {
      res.status(400).json({ error: 'tradingStyle must be "scalp" | "day" | "swing"' });
      return;
    }
    if (!Array.isArray(body.universe) || body.universe.length === 0) {
      res.status(400).json({ error: 'universe (non-empty string[]) is required' });
      return;
    }
    try {
      const row = await createTradingAgent(db, {
        name: body.name,
        domain: body.domain,
        universe: body.universe,
        tradingStyle: body.tradingStyle,
        config: body.config,
      });
      // §14 — every TradingAgent owns a paper portfolio from birth (audit-2: createPortfolio
      // had no live caller, so agents never had one). Composed here at the app layer so
      // @tip/trading-agents keeps its no-paper-engine dependency direction.
      const startingCash = (body.config as { startingBalance?: number })?.startingBalance ?? 10_000;
      await createPortfolio(db, { tradingAgentId: row.id, startingCash });
      res.status(201).json(row);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  r.get('/', async (_req, res) => {
    const rows = await listTradingAgents(db);
    res.json({ tradingAgents: rows, count: rows.length });
  });

  r.get('/:id', async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'id path param required' });
      return;
    }
    const row = await getTradingAgent(db, id);
    if (!row) {
      res.status(404).json({ error: 'trading agent not found' });
      return;
    }
    res.json(row);
  });

  /**
   * GET /:id/configs — full version history for the version-switcher UI.
   * Every `scoring_config` row for this agent, most-recent first, with the active flag.
   */
  r.get('/:id/configs', async (req, res) => {
    const { id } = req.params;
    if (!id) { res.status(400).json({ error: 'id path param required' }); return; }
    const agent = await getTradingAgent(db, id);
    if (!agent) { res.status(404).json({ error: 'trading agent not found' }); return; }
    const rows = await db.select().from(scoringConfig)
      .where(eq(scoringConfig.tradingAgentId, id))
      .orderBy(desc(scoringConfig.version));
    res.json({
      activeVersion: agent.activeConfigVersion,
      versions: rows.map((r_) => ({
        version: r_.version,
        active: r_.active,
        createdAt: r_.createdAt,
        config: r_.config,
      })),
    });
  });

  /**
   * POST /:id/active-config — switch the agent to a different config version.
   * Refuses when the agent has an OPEN / PENDING_ENTRY position (avoids mid-trade config flip).
   */
  r.post('/:id/active-config', async (req, res) => {
    const { id } = req.params;
    if (!id) { res.status(400).json({ error: 'id path param required' }); return; }
    const body = (req.body ?? {}) as { version?: number };
    if (typeof body.version !== 'number' || body.version < 1) {
      res.status(400).json({ error: 'version (positive integer) is required' });
      return;
    }
    const agent = await getTradingAgent(db, id);
    if (!agent) { res.status(404).json({ error: 'trading agent not found' }); return; }

    // Guard: version must exist for this agent.
    const target = (await db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, id), eq(scoringConfig.version, body.version)))
      .limit(1))[0];
    if (!target) {
      res.status(400).json({ error: `version ${body.version} does not exist for this agent` });
      return;
    }

    // Guard: no OPEN / PENDING_ENTRY positions — a mid-trade config flip mixes attribution.
    const openCount = await db.select().from(paperPosition)
      .innerJoin(tradingAgent, eq(tradingAgent.id, id))
      .where(and(
        eq(paperPosition.symbol, agent.universe[0] ?? ''),
        inArray(paperPosition.state, ['OPEN', 'PENDING_ENTRY']),
        eq(paperPosition.isShadow, false),
      )).then((r) => r.length);
    if (openCount > 0) {
      res.status(409).json({ error: 'cannot switch config while an open (or pending) paper position exists — close it first' });
      return;
    }

    // Flip active flag: current → false, target → true, and update trading_agent.
    const targetVersion = body.version;
    await db.transaction(async (tx) => {
      await tx.update(scoringConfig).set({ active: false })
        .where(and(eq(scoringConfig.tradingAgentId, id), eq(scoringConfig.active, true)));
      await tx.update(scoringConfig).set({ active: true })
        .where(and(eq(scoringConfig.tradingAgentId, id), eq(scoringConfig.version, targetVersion)));
      await tx.update(tradingAgent).set({ activeConfigVersion: targetVersion }).where(eq(tradingAgent.id, id));
    });
    const updated = await getTradingAgent(db, id);
    res.json(updated);
  });

  r.patch('/:id/config', async (req, res) => {
    const { id } = req.params;
    if (!id) {
      res.status(400).json({ error: 'id path param required' });
      return;
    }
    try {
      const row = await updateTradingAgentConfig(db, id, (req.body ?? {}));
      res.json(row);
    } catch (err) {
      if (err instanceof ValidationError) {
        // Distinguish "not found" from other validation errors by inspecting the message.
        const status = err.message.includes('not found') ? 404 : 400;
        res.status(status).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  return r;
}
