import type { Express, Response } from 'express';
import type { Pool } from 'pg';
import { z } from 'zod';
import type { Actor } from '../../../packages/database/src/bots.js';
import {
  preferencesInput,
  savePreferences,
  updateIncident,
} from '../../../packages/notifications/src/service.js';
import { DomainError } from '../../../packages/core/src/index.js';
export function dashboardRoutes(
  app: Express,
  pool: Pool,
  account: (res: Response) => Promise<{ id: string }>,
  actor: (res: Response) => Actor,
) {
  app.get('/api/session', (_req, res) =>
    res.json({ data: { role: actor(res).role } }),
  );
  app.get('/api/events', (req, res) => {
    res.set({
      'Content-Type': 'text/event-stream',
      'Cache-Control': 'no-store',
      'X-Accel-Buffering': 'no',
    });
    res.flushHeaders();
    res.write('event: refresh\ndata: {}\n\n');
    const timer = setInterval(
      () => res.write('event: refresh\ndata: {}\n\n'),
      10000,
    );
    // Reauthenticate at least once per minute, including token expiration/revocation.
    const end = setTimeout(() => res.end(), 60000);
    req.on('close', () => {
      clearInterval(timer);
      clearTimeout(end);
    });
  });
  app.get('/api/notifications/preferences', async (_req, res) =>
    res.json({
      data: (
        await pool.query(
          'SELECT * FROM notification_preferences WHERE account_id=$1 ORDER BY scope',
          [(await account(res)).id],
        )
      ).rows,
    }),
  );
  app.patch('/api/notifications/preferences', async (req, res) =>
    res.json({
      data: await savePreferences(
        pool,
        (await account(res)).id,
        actor(res).userId,
        preferencesInput.parse(req.body),
      ),
    }),
  );
  app.get('/api/notifications/delivery-status', async (_req, res) => {
    const a = await account(res);
    const [deliveries, workers] = await Promise.all([
      pool.query(
        `SELECT id,template_key,severity,status,attempt_count,last_error,available_at,created_at,sent_at FROM notification_outbox WHERE account_id=$1 ORDER BY created_at DESC LIMIT 50`,
        [a.id],
      ),
      pool.query(
        "SELECT * FROM notification_worker_health WHERE id IN ('projector','delivery','delivery-unconfigured')",
      ),
    ]);
    res.json({
      data: {
        deliveries: deliveries.rows,
        workers: workers.rows.map((w) => ({
          ...w,
          telegramConfigured:
            w.id === 'delivery'
              ? true
              : w.id === 'delivery-unconfigured'
                ? false
                : null,
          stale: Date.now() - new Date(w.observed_at).getTime() > 15000,
        })),
      },
    });
  });
  app.get('/api/incidents', async (req, res) => {
    const status = z
      .enum(['ACTIVE', 'ACKNOWLEDGED', 'RECOVERING', 'RESOLVED'])
      .optional()
      .parse(req.query.status);
    const severity = z
      .enum(['WARN', 'HIGH', 'CRITICAL'])
      .optional()
      .parse(req.query.severity);
    res.json({
      data: (
        await pool.query(
          `SELECT * FROM system_incidents WHERE account_id=$1 AND ($2::text IS NULL OR status=$2) AND ($3::text IS NULL OR severity=$3) ORDER BY last_seen DESC LIMIT 100`,
          [(await account(res)).id, status ?? null, severity ?? null],
        )
      ).rows,
    });
  });
  app.get('/api/incidents/:id', async (req, res) => {
    const id = z.uuid().parse(req.params.id);
    const { rows } = await pool.query(
      'SELECT * FROM system_incidents WHERE id=$1 AND account_id=$2',
      [id, (await account(res)).id],
    );
    if (!rows[0])
      throw new DomainError('INCIDENT_NOT_FOUND', 'Incident not found', 404);
    res.json({
      data: {
        ...rows[0],
        timeline: (
          await pool.query(
            'SELECT * FROM incident_events WHERE incident_id=$1 ORDER BY created_at',
            [id],
          )
        ).rows,
      },
    });
  });
  for (const [route, status] of [
    ['acknowledge', 'ACKNOWLEDGED'],
    ['resolve', 'RESOLVED'],
  ] as const)
    app.post(`/api/incidents/:id/${route}`, async (req, res) => {
      const body = z
        .object({ reason: z.string().trim().min(1).max(500) })
        .strict()
        .parse(req.body);
      res.json({
        data: await updateIncident(
          pool,
          (await account(res)).id,
          actor(res).userId,
          z.uuid().parse(req.params.id),
          status,
          body.reason,
        ),
      });
    });
  app.get('/api/audit-events', async (_req, res) =>
    res.json({
      data: (
        await pool.query(
          `SELECT id,bot_id,event_type,correlation_id,details,created_at FROM audit_events WHERE account_id=$1 ORDER BY created_at DESC LIMIT 100`,
          [(await account(res)).id],
        )
      ).rows,
    }),
  );
  app.get('/api/account/report', async (_req, res) => {
    const a = await account(res);
    const [decisions, rejections, trades, curve, leases, gaps] =
      await Promise.all([
        pool.query(
          `SELECT bot_id,decision,reason_code,count(*)::int AS count FROM strategy_evaluations WHERE account_id=$1 GROUP BY bot_id,decision,reason_code`,
          [a.id],
        ),
        pool.query(
          `SELECT e.bot_id,e.kind,e.details,e.event_time FROM runtime_events e JOIN bots b ON b.id=e.bot_id WHERE b.exchange_account_id=$1 AND (e.kind LIKE '%reject%' OR e.details::text LIKE '%RISK_REJECTED%') ORDER BY e.event_time DESC LIMIT 50`,
          [a.id],
        ),
        pool.query(
          `SELECT t.*,coalesce((SELECT sum(l.amount)::text FROM paper_capital_ledger l WHERE l.trade_id=t.id AND l.kind<>'FUNDING'),'0') AS net_pnl FROM trade_lifecycles t WHERE t.account_id=$1 AND t.execution_backend='PAPER' ORDER BY t.created_at DESC LIMIT 200`,
          [a.id],
        ),
        pool.query(
          `SELECT event_time,sum(sum(amount)) OVER(ORDER BY event_time)::text AS net_pnl FROM paper_capital_ledger WHERE account_id=$1 AND kind<>'FUNDING' GROUP BY event_time ORDER BY event_time DESC LIMIT 500`,
          [a.id],
        ),
        pool.query(
          `SELECT l.bot_id,l.expires_at FROM runtime_leases l JOIN bots b ON b.id=l.bot_id WHERE b.exchange_account_id=$1`,
          [a.id],
        ),
        pool.query(
          `SELECT g.id,g.bot_id,g.start_time,g.end_time,g.status,g.checkpoint FROM recovery_gaps g JOIN bots b ON b.id=g.bot_id WHERE b.exchange_account_id=$1 ORDER BY g.start_time DESC LIMIT 50`,
          [a.id],
        ),
      ]);
    res.json({
      data: {
        environment: 'PAPER',
        simulated: true,
        decisions: decisions.rows,
        rejections: rejections.rows,
        trades: trades.rows,
        realizedCurve: curve.rows.reverse(),
        runtimeLeases: leases.rows,
        recoveryGaps: gaps.rows,
        limits: { trades: 200, curve: 500 },
        observedAt: Date.now(),
      },
    });
  });
}
