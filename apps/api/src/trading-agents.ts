import { Router } from 'express';
import { ValidationError } from '@tip/domain';
import type { Db } from '@tip/database';
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
