# PAPER incident and recovery playbooks

Keep new entries frozen until the underlying fault and reconciliation are verified. Acknowledging an incident records that it was seen; it never resumes a bot. Simulated stops exist only in the local PAPER engine. No playbook here submits an exchange order.

## Unknown fills, missing protection or feed gaps

1. Inspect the bot lifecycle, desired/submitted/confirmed stop, protected and filled quantities, unresolved actions, and recovery gap evidence. Record incident ID, correlation/evaluation IDs and affected markets.
2. Pause affected entries, or set `PAPER_ENTRIES_ENABLED=false` for the runtime policy. Do not casually restart a healthy runtime managing exposure: a restart itself creates a missed-event gap. Do not mark a position CLOSED, clear a fault, delete a reservation or edit a ledger to make the dashboard appear healthy.
3. Existing known exposure remains managed when observations and persistence are trustworthy. If event ordering or executions are uncertain, retain quantities/capacity and use the durable reconciliation barrier. A candle touching TP and SL cannot establish which happened first.
4. For sufficient independently verified evidence, stop the forward runtime so its leases are released, then use the documented `npm run recovery:replay -- --file /private/evidence.json --owner ...` workflow from Phase 6. The evidence must cover the complete gap in event time and pin the same code/data context. Repeating the recovery must not post twice.
5. If the public provider cannot certify the tape, leave RECONCILIATION_UNCERTAIN, unresolved exposure and the incident visible. Acknowledge it and record the limitation. Do not fabricate a favorable exit or use SQL as a risk override. A separate operator-approved simulator reset/migration would be new work with its own accounting evidence.
6. Verify financial integrity, healthy data and confirmed protection. Resolve the incident with evidence. Resume or start through authorized durable commands only after the safety policy permits it.

## Database outage

Durable state is a prerequisite for strategy/OMS commits. Database failures prevent approved new orders and fills; they do not grant permission to reuse stale memory or bypass fencing. Inspect local health and sanitized service logs. Restore database availability before reconciliation. Because observations may have been lost, stop/restart the runtime conservatively with entries disabled and inspect the startup gap. If permanent loss occurred, use the new-target backup restore procedure. Incidents cannot be written while PostgreSQL itself is unavailable; use independent host/database monitoring and persist the recovery evidence when storage returns.

## Process crash or controlled restart

For a controlled restart, pause new entries, drain critical work, send SIGTERM and observe exit status. systemd allows 20 seconds; applications normally bound shutdown to 10 seconds. A SIGKILL is a crash, not a clean release. Leases expire using database time, and the next owner advances the fence. Old owners cannot commit actions or economic effects after takeover. Keep the old process stopped before restoring or switching a database. Restarted active PAPER exposure needs sufficient missed-event evidence; PAUSE/STOP does not waive that requirement. Do not switch owners repeatedly during an open incident.

## Replay overload or Telegram outage

Runtime, replay and notifier are independent processes with separate database pools and Linux resource limits. If replay resource pressure rises, stop the worker first, preserving its durable checkpoint; do not stop position monitoring to finish a report. Changed engine manifests require fresh runs rather than resuming an old job with new semantics. If Telegram fails, inspect PENDING/SENDING/DEAD attempts and heartbeat freshness; position management never awaits delivery. Recover the notifier independently. Final-attempt uncertainty is dead-lettered; a lost successful response can cause duplicate messages. No API/manual retry should impersonate an execution acknowledgment. Recipients/preferences apply to future events, while queued messages keep their stored routing snapshot.

## Bad migration or failed deployment

Keep services stopped/frozen. The migrator validates every applied source checksum and serializes migration runners; failed pending DDL rolls back with no journal advancement. Fix a new unapplied migration through review; never rewrite applied history. Restore exact applied files if history differs. Test the candidate on a restored clone. Follow the deployment rollback procedure for binary/schema compatibility or a new-target snapshot restore. Preserve failed-release logs and the original database until the recovery point is understood.

## Credential exposure

Revoke the affected bearer token with the privileged token CLI; confirm the API now returns 401. Rotate Telegram credentials only in the notifier environment and restart that process. Do not paste credentials into an incident, audit details, command reason, screenshot or Telegram. Inspect immutable issuance/revocation audits and access boundaries. Rotate database credentials per service if compromised; terminate their sessions as an authorized DBA. Service logins must never inherit migration/superuser permissions. Run the integrity check before enabling entries after any suspected financial-state access.

## Routine readiness checks

Check PostgreSQL availability/backup freshness, four independent service readiness endpoints, runtime lease ownership, stale market projections, open incidents, protection coverage, unreconciled gaps, budget/reservations and notification backlog. Run `npm run ops:verify`; retain private backup/restore drill records. Process readiness does not imply profitable strategies, current data for every market, delivery configured, or permission for LIVE execution.
