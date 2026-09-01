import { Router } from 'express';
import { ValidationError } from '@tip/domain';
import type { Watchlist } from '@tip/watchlist';

/**
 * Watchlist API (m3-watchlist). Backfill-inline for MVP simplicity — callers see the outcome
 * synchronously. Errors map to sensible HTTP codes:
 *   - ValidationError (bad address / bad body)   → 400
 *   - Helius or DB failure                        → 500 (unhandled, Express default)
 *   - address not currently watched (on DELETE)   → 404
 */
export function walletsRouter(watchlist: Watchlist): Router {
  const r = Router();

  r.post('/', async (req, res) => {
    const body = (req.body ?? {}) as { address?: unknown; note?: unknown };
    if (typeof body.address !== 'string' || body.address.trim() === '') {
      res.status(400).json({ error: 'address (string) is required' });
      return;
    }
    const note = typeof body.note === 'string' ? body.note : undefined;
    try {
      const result = await watchlist.add(body.address, note);
      res.status(result.resurrected ? 200 : 201).json(result);
    } catch (err) {
      if (err instanceof ValidationError) {
        res.status(400).json({ error: err.message });
        return;
      }
      throw err;
    }
  });

  r.get('/', async (_req, res) => {
    const rows = await watchlist.list();
    res.json({ wallets: rows, count: rows.length });
  });

  r.delete('/:address', async (req, res) => {
    const { address } = req.params;
    if (!address) {
      res.status(400).json({ error: 'address path param required' });
      return;
    }
    const { removed } = await watchlist.remove(address);
    if (!removed) {
      res.status(404).json({ error: 'wallet not actively watched' });
      return;
    }
    res.status(204).end();
  });

  return r;
}
