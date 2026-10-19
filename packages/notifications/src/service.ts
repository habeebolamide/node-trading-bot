import type { Pool, PoolClient } from 'pg';
import { randomUUID } from 'node:crypto';
import { z } from 'zod';
import { DomainError } from '../../core/src/index.js';
export const preferencesInput = z
  .object({
    botId: z.uuid().nullable().default(null),
    enabled: z.boolean(),
    recipientRef: z
      .string()
      .regex(/^-?\d{1,20}$/)
      .nullable(),
    events: z
      .array(z.enum(['ENTRY', 'EXIT', 'PROTECTION', 'RECOVERY', 'SIGNAL']))
      .max(5),
  })
  .strict()
  .refine(
    (p) => !p.enabled || !!p.recipientRef,
    'Telegram chat ID required when enabled',
  );
export type PreferencesInput = z.infer<typeof preferencesInput>;
type DB = Pick<PoolClient, 'query'>;
export async function savePreferences(
  pool: Pool,
  accountId: string,
  actorId: string,
  input: PreferencesInput,
) {
  const client = await pool.connect();
  try {
    await client.query('BEGIN');
    if (
      input.botId &&
      !(
        await client.query(
          'SELECT id FROM bots WHERE id=$1 AND exchange_account_id=$2',
          [input.botId, accountId],
        )
      ).rowCount
    )
      throw new DomainError('BOT_NOT_FOUND', 'Bot not found', 404);
    const scope = input.botId ?? accountId;
    const { rows } = await client.query(
      `INSERT INTO notification_preferences(scope,account_id,bot_id,enabled,recipient_ref,events)
      VALUES($1,$2,$3,$4,$5,$6) ON CONFLICT(scope) DO UPDATE SET enabled=excluded.enabled,recipient_ref=excluded.recipient_ref,events=excluded.events,updated_at=now() RETURNING *`,
      [
        scope,
        accountId,
        input.botId,
        input.enabled,
        input.recipientRef,
        JSON.stringify(input.events),
      ],
    );
    await client.query(
      `INSERT INTO audit_events(account_id,bot_id,actor_id,event_type,correlation_id,details) VALUES($1,$2,$3,'notifications.preferences',$4,$5)`,
      [
        accountId,
        input.botId,
        actorId,
        randomUUID(),
        JSON.stringify({ enabled: input.enabled, events: input.events }),
      ],
    );
    await client.query('COMMIT');
    return rows[0];
  } catch (e) {
    await client.query('ROLLBACK');
    throw e;
  } finally {
    client.release();
  }
}
async function enqueue(
  db: DB,
  account: string,
  bot: string | null,
  event: string,
  category: string,
  text: string,
  severity = 'INFO',
) {
  // Account routing is authoritative for incidents. Optional bot routing inherits account defaults.
  const { rows } = await db.query(
    `SELECT * FROM notification_preferences WHERE account_id=$1 AND (bot_id=$2 OR bot_id IS NULL) ORDER BY bot_id NULLS LAST LIMIT 1`,
    [account, category === 'INCIDENT' ? null : bot],
  );
  const p = rows[0];
  if (
    !p?.enabled ||
    !p.recipient_ref ||
    (category !== 'INCIDENT' && !p.events.includes(category))
  )
    return;
  await db.query(
    `INSERT INTO notification_outbox(account_id,domain_event_id,recipient_ref,template_key,payload_snapshot,dedupe_key,severity)
    VALUES($1,$2,$3,$4,$5,$6,$7) ON CONFLICT DO NOTHING`,
    [
      account,
      event,
      p.recipient_ref,
      category,
      JSON.stringify({ text: text.slice(0, 1800) }),
      `${event}:${p.recipient_ref}:${category}`,
      severity,
    ],
  );
}
export async function incidentFaults(
  db: DB,
  account: string,
  now = Date.now(),
) {
  const { rows } = await db.query(
    `SELECT b.id,b.canonical_market_id,b.operational_status,b.trading_state,
    h.state AS health,h.observed_at,c.fault,
    EXISTS(SELECT 1 FROM recovery_gaps g WHERE g.bot_id=b.id AND g.status<>'RESOLVED') AS gap,
    EXISTS(SELECT 1 FROM trade_lifecycles t WHERE t.bot_id=b.id AND t.state IN ('OPEN','CLOSING','UNRESOLVED') AND (t.state='UNRESOLVED' OR t.protection_status<>'CONFIRMED')) AS exposure_fault
    FROM bots b LEFT JOIN runtime_checkpoints c ON c.bot_id=b.id LEFT JOIN market_checkpoints h ON h.stream_key=b.canonical_market_id||':health'
    WHERE b.exchange_account_id=$1 ORDER BY b.id`,
    [account],
  );
  const feed = rows.filter(
    (b) =>
      (b.operational_status !== 'STOPPED' || b.trading_state !== 'IDLE') &&
      (!b.health?.canEvaluate || now - Number(b.observed_at) > 15000 || b.gap),
  );
  const faults: {
    fingerprint: string;
    title: string;
    bots: string[];
    evidence: unknown;
    severity: string;
  }[] = [];
  if (feed.length)
    faults.push({
      fingerprint: 'feed:bybit',
      title: 'Bybit market data or recovery degraded',
      bots: feed.map((b) => b.id),
      evidence: feed.map((b) => ({
        botId: b.id,
        market: b.canonical_market_id,
        observedAt: b.observed_at,
        gap: b.gap,
        tradingState: b.trading_state,
        fault: b.fault,
        reason: b.health?.reason ?? 'Missing or stale health',
      })),
      severity: 'HIGH',
    });
  for (const b of rows) {
    if (
      (b.exposure_fault || b.trading_state === 'UNRESOLVED') &&
      !(b.gap && b.fault === 'RECONCILIATION_UNCERTAIN')
    )
      faults.push({
        fingerprint: `exposure:${b.id}`,
        title: 'Paper exposure requires reconciliation',
        bots: [b.id],
        evidence: { state: b.trading_state },
        severity: 'HIGH',
      });
    if (['ERROR', 'RISK_SUSPENDED'].includes(b.operational_status))
      faults.push({
        fingerprint: `runtime:${b.id}`,
        title: 'Bot entries suspended',
        bots: [b.id],
        evidence: { state: b.operational_status },
        severity: 'HIGH',
      });
  }
  return faults;
}
async function projectIncidents(db: DB, account: string, now: number) {
  const faults = await incidentFaults(db, account, now);
  for (const f of faults) {
    const { rows } = await db.query(
      'SELECT * FROM system_incidents WHERE account_id=$1 AND fingerprint=$2 FOR UPDATE',
      [account, f.fingerprint],
    );
    const previous = rows[0];
    if (!previous) {
      const inserted = await db.query(
        `INSERT INTO system_incidents(account_id,fingerprint,severity,title,affected_bots,evidence) VALUES($1,$2,$3,$4,$5,$6) RETURNING *`,
        [
          account,
          f.fingerprint,
          f.severity,
          f.title,
          JSON.stringify(f.bots),
          JSON.stringify(f.evidence),
        ],
      );
      const incident = inserted.rows[0];
      await db.query(
        `INSERT INTO incident_events(incident_id,kind,evidence) VALUES($1,'DETECTED',$2)`,
        [incident.id, JSON.stringify(f.evidence)],
      );
      await enqueue(
        db,
        account,
        null,
        `incident:${incident.id}:1`,
        'INCIDENT',
        `${f.title}. ${f.bots.length} affected bot(s). Inspect the dashboard; acknowledgment does not resume trading.`,
        f.severity,
      );
    } else {
      const reopen = ['RESOLVED', 'RECOVERING'].includes(previous.status);
      await db.query(
        `UPDATE system_incidents SET status=CASE WHEN $2 THEN 'ACTIVE' ELSE status END,affected_bots=$3,evidence=$4,last_seen=now(),occurrence_count=occurrence_count+CASE WHEN $2 THEN 1 ELSE 0 END WHERE id=$1`,
        [
          previous.id,
          reopen,
          JSON.stringify(f.bots),
          JSON.stringify(f.evidence),
        ],
      );
      if (reopen) {
        await db.query(
          `INSERT INTO incident_events(incident_id,kind,evidence) VALUES($1,'REOPENED',$2)`,
          [previous.id, JSON.stringify(f.evidence)],
        );
        await enqueue(
          db,
          account,
          null,
          `incident:${previous.id}:${previous.occurrence_count + 1}`,
          'INCIDENT',
          `${f.title} recurred. Inspect the dashboard.`,
          f.severity,
        );
      }
    }
  }
  const open = await db.query(
    `SELECT * FROM system_incidents WHERE account_id=$1 AND status IN ('ACTIVE','ACKNOWLEDGED')`,
    [account],
  );
  for (const i of open.rows.filter(
    (i) => !faults.some((f) => f.fingerprint === i.fingerprint),
  )) {
    await db.query(
      `UPDATE system_incidents SET status='RECOVERING' WHERE id=$1`,
      [i.id],
    );
    await db.query(
      `INSERT INTO incident_events(incident_id,kind,evidence) VALUES($1,'RECOVERING',$2)`,
      [i.id, JSON.stringify({ checkedAt: now, underlyingFaultAbsent: true })],
    );
  }
}
export async function updateIncident(
  pool: Pool,
  account: string,
  actor: string,
  id: string,
  action: 'ACKNOWLEDGED' | 'RESOLVED',
  reason: string,
) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    // Same lock as the projector: a fault refresh cannot race an operator resolution.
    await db.query(
      `SELECT pg_advisory_xact_lock(hashtext('notification-projector'))`,
    );
    const { rows } = await db.query(
      'SELECT * FROM system_incidents WHERE id=$1 AND account_id=$2 FOR UPDATE',
      [id, account],
    );
    const i = rows[0];
    if (!i)
      throw new DomainError('INCIDENT_NOT_FOUND', 'Incident not found', 404);
    if (
      action === 'RESOLVED' &&
      (await incidentFaults(db, account)).some(
        (f) => f.fingerprint === i.fingerprint,
      )
    )
      throw new DomainError(
        'FAULT_ACTIVE',
        'Underlying fault or reconciliation remains unresolved',
        409,
      );
    if (i.status === 'RESOLVED')
      throw new DomainError(
        'INCIDENT_RESOLVED',
        'Incident already resolved',
        409,
      );
    await db.query('UPDATE system_incidents SET status=$2 WHERE id=$1', [
      id,
      action,
    ]);
    await db.query(
      'INSERT INTO incident_events(incident_id,actor_id,kind,evidence) VALUES($1,$2,$3,$4)',
      [id, actor, action, JSON.stringify({ reason, checkedAt: Date.now() })],
    );
    await db.query(
      `INSERT INTO audit_events(account_id,actor_id,event_type,correlation_id,details) VALUES($1,$2,'incident.control',$3,$4)`,
      [
        account,
        actor,
        randomUUID(),
        JSON.stringify({ incidentId: id, action, reason }),
      ],
    );
    if (action === 'RESOLVED')
      await enqueue(
        db,
        account,
        null,
        `incident:${id}:resolved:${i.occurrence_count}`,
        'RECOVERY',
        `${i.title}: recovery verified by the operator. Bots still require explicit runtime controls.`,
      );
    await db.query('COMMIT');
    return { id, status: action };
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
export async function projectNotifications(pool: Pool, now = Date.now()) {
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const lock = await db.query(
      `SELECT pg_try_advisory_xact_lock(hashtext('notification-projector')) AS locked`,
    );
    if (!lock.rows[0].locked) {
      await db.query('ROLLBACK');
      return;
    }
    await db.query(
      `INSERT INTO notification_worker_health(id) VALUES('projector') ON CONFLICT(id) DO UPDATE SET observed_at=now()`,
    );
    const accounts = await db.query(
      `SELECT a.id FROM exchange_accounts a LEFT JOIN notification_worker_health h ON h.id='account:'||a.id::text WHERE a.replay_scope='FORWARD' ORDER BY h.observed_at NULLS FIRST,a.id LIMIT 10`,
    );
    for (const a of accounts.rows) {
      await projectIncidents(db, a.id, now);
      await db.query(
        `INSERT INTO notification_worker_health(id) VALUES($1) ON CONFLICT(id) DO UPDATE SET observed_at=now()`,
        ['account:' + a.id],
      );
    }
    const events =
      await db.query(`SELECT e.*,b.exchange_account_id,b.name FROM runtime_events e JOIN bots b ON b.id=e.bot_id JOIN exchange_accounts a ON a.id=b.exchange_account_id
      WHERE a.replay_scope='FORWARD' AND NOT EXISTS(SELECT 1 FROM notification_projected_events p WHERE p.event_id=e.id) ORDER BY e.event_time,e.id LIMIT 100`);
    for (const e of events.rows) {
      // No raw event payload or arbitrary operator text is sent to Telegram.
      const actions = e.details.actions ?? [];
      const category =
        e.kind === 'execution.entry_fill'
          ? 'ENTRY'
          : e.kind === 'execution.exit_fill'
            ? 'EXIT'
            : e.kind === 'recovery.replay_started'
              ? 'RECOVERY'
              : actions.some((a: { kind: string }) => a.kind === 'CLOSE')
                ? 'EXIT'
                : actions.some((a: { kind: string }) => a.kind === 'ENTRY')
                  ? 'ENTRY'
                  : actions.some((a: { kind: string }) =>
                        ['PROTECT', 'AMEND_STOP'].includes(a.kind),
                      )
                    ? 'PROTECTION'
                    : null;
      if (category)
        await enqueue(
          db,
          e.exchange_account_id,
          e.bot_id,
          e.id,
          category,
          `PAPER / SIMULATED · ${e.name} · ${category} (${e.kind}). ${e.details.to?.operational ?? ''} / ${e.details.to?.trading ?? ''}. Inspect the dashboard for execution confirmation.`,
        );
      // SIGNAL_ONLY LONG/SHORT are opt-in; NO_TRADE never creates a delivery.
      if (
        e.kind === 'strategy.evaluated' &&
        ['LONG', 'SHORT'].includes(e.details.decision)
      )
        await enqueue(
          db,
          e.exchange_account_id,
          e.bot_id,
          e.id,
          'SIGNAL',
          `Research signal · ${e.name} · ${e.details.decision}. No fill implied.`,
        );
      await db.query(
        'INSERT INTO notification_projected_events(event_id,account_id) VALUES($1,$2) ON CONFLICT DO NOTHING',
        [e.id, e.exchange_account_id],
      );
    }
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
}
export type DeliveryResult = {
  messageId?: string;
  retryAfter?: number;
  error?: 'RATE_LIMIT' | 'REJECTED' | 'UNAVAILABLE' | 'TIMEOUT';
};
export type Sender = (
  recipient: string,
  text: string,
  signal: AbortSignal,
) => Promise<DeliveryResult>;
export function telegramSender(token: string): Sender {
  if (!/^\d+:[A-Za-z0-9_-]+$/.test(token))
    throw Error('Invalid Telegram token format');
  return async (recipient, text, signal) => {
    const response = await fetch(
      `https://api.telegram.org/bot${token}/sendMessage`,
      {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ chat_id: recipient, text }),
        signal,
      },
    );
    const body = (await response.json()) as {
      ok?: boolean;
      error_code?: number;
      result?: { message_id: number };
      parameters?: { retry_after: number };
    };
    if (response.ok && body.ok)
      return Number.isSafeInteger(body.result?.message_id)
        ? { messageId: String(body.result!.message_id) }
        : { error: 'UNAVAILABLE' };
    if (response.status === 429 || body.error_code === 429)
      return { error: 'RATE_LIMIT', retryAfter: body.parameters?.retry_after };
    return { error: response.status >= 500 ? 'UNAVAILABLE' : 'REJECTED' };
  };
}
export async function deliverOne(pool: Pool, sender: Sender, timeoutMs = 5000) {
  const lease = randomUUID();
  const claimed = await pool.query(
    `WITH claimed AS (UPDATE notification_outbox SET status='SENDING',lease_token=$1,lease_until=now()+interval '20 seconds',attempt_count=attempt_count+1
    WHERE id=(SELECT id FROM notification_outbox WHERE ((status='PENDING' AND available_at<=now()) OR (status='SENDING' AND lease_until<now())) AND attempt_count<5 ORDER BY available_at,created_at FOR UPDATE SKIP LOCKED LIMIT 1) RETURNING *), attempt AS (INSERT INTO notification_attempts(outbox_id,attempt_no,result) SELECT id,attempt_count,'STARTED' FROM claimed RETURNING outbox_id) SELECT c.* FROM claimed c JOIN attempt a ON a.outbox_id=c.id`,
    [lease],
  );
  const row = claimed.rows[0];
  if (!row) return false;
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  let result: DeliveryResult;
  try {
    result = await Promise.race([
      sender(row.recipient_ref, row.payload_snapshot.text, controller.signal),
      new Promise<DeliveryResult>((resolve) => {
        timer = setTimeout(
          () => {
            controller.abort();
            resolve({ error: 'TIMEOUT' });
          },
          Math.min(5000, Math.max(1, timeoutMs)),
        );
      }),
    ]);
  } catch {
    result = { error: controller.signal.aborted ? 'TIMEOUT' : 'UNAVAILABLE' };
  } finally {
    clearTimeout(timer);
  }
  const retryAfter = Number.isFinite(result.retryAfter)
    ? Math.max(0, result.retryAfter!)
    : 0;
  const terminal =
    row.attempt_count >= 5 || result.error === 'REJECTED' || retryAfter > 86400;
  const retrySeconds = Math.max(
    Math.min(3600, 2 ** row.attempt_count * 5 + Math.floor(Math.random() * 5)),
    Math.min(retryAfter, 86400),
  );
  const db = await pool.connect();
  try {
    await db.query('BEGIN');
    const changed = await db.query(
      `UPDATE notification_outbox SET status=$3,last_error=$4,available_at=now()+($5::text||' seconds')::interval,sent_at=CASE WHEN $3='SENT' THEN now() ELSE NULL END,lease_until=NULL,lease_token=NULL
      WHERE id=$1 AND lease_token=$2 AND status='SENDING' RETURNING id`,
      [
        row.id,
        lease,
        result.error ? (terminal ? 'DEAD' : 'PENDING') : 'SENT',
        result.error ?? null,
        retrySeconds,
      ],
    );
    if (changed.rowCount)
      await db.query(
        "UPDATE notification_attempts SET result=$3,message_id=$4,retry_at=CASE WHEN $3 IN ('TIMEOUT','UNAVAILABLE','RATE_LIMIT') THEN now()+($5::text||' seconds')::interval ELSE NULL END WHERE outbox_id=$1 AND attempt_no=$2",
        [
          row.id,
          row.attempt_count,
          result.error ?? 'SENT',
          result.messageId ?? null,
          retrySeconds,
        ],
      );
    await db.query('COMMIT');
  } catch (e) {
    await db.query('ROLLBACK');
    throw e;
  } finally {
    db.release();
  }
  return true;
}
// A crash on the final leased send is conservatively dead-lettered; it might have reached Telegram.
export async function expireFinalAttempts(pool: Pool) {
  await pool.query(
    `UPDATE notification_outbox SET status='DEAD',last_error='DELIVERY_UNKNOWN',lease_until=NULL,lease_token=NULL WHERE status='SENDING' AND lease_until<now() AND attempt_count>=5`,
  );
}
