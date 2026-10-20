# Phase 8 — Hardening and PAPER readiness

## Delivered interfaces and safeguards

- Production forward runtime defaults to **Protect & Freeze**. `PAPER_ENTRIES_ENABLED=false` cancels pending remainders without closing filled exposure, preserves protection/monitoring, and emits a durable policy event. Explicit enablement still requires normal health, ownership, reconciliation and atomic risk checks. Entry permission is checked after asynchronous evaluation and at the submission boundary; a freeze during submission authorization retains conservative UNKNOWN capacity rather than claiming execution or sending a new entry. Replay execution remains independent of the forward entry gate. LIVE is still rejected.
- Production API requires loopback binding behind the TLS proxy, trusts only loopback forwarding, suppresses authenticated response caching and has bounded header/request/keepalive timeouts. Structured logging redacts Telegram, bearer and nested credentials. Bootstrap OWNER issuance is audited and printed only after commit.
- `npm run ops:token -- --action issue|revoke --owner ... --reason ...`: privileged, account-scoped token administration. Issuance defaults to VIEWER, creates an exclusive `0600` output file and expires after 30 days. Revocation uses a token UUID. Both operations persist immutable audit evidence without raw token/hash data. Service identities cannot issue tokens.
- `npm run ops:backup -- --file /private/path/paper.dump`: native consistent PostgreSQL custom-format archive with private permissions, checksum/size manifest, exclusive publication and fsync. Credentials stay out of arguments and utility error output. Optional `PG_BIN_DIR` selects native utilities; remote utility connections require `sslmode=verify-full`.
- `npm run ops:restore -- --file ... --confirm-target exact_name`: refuses checksum corruption, existing tables/sequences/views and other sessions; transactionally restores into an isolated empty target, verifies execution/ledger/funding/reservation conservation, expires leases and advances runtime fencing. It never overwrites the original database. A failed target remains offline for investigation/recreation.
- `npm run ops:verify`: read-only consistent-snapshot economic checks from reconciled execution facts through gross P&L, fees, funding and terminal reservation release; reports PAPER trade/unresolved counts and fails on disagreement.
- Migration runner serializes on a PostgreSQL advisory lock on the same physical connection, validates every applied timestamp/hash against the source prefix, and applies pending migrations transactionally. No applied migration was edited. New migrations 0029–0032 enforce service execution-scope boundaries, including replay-run scopes and control/config/evaluation/audit writes.
- `deploy/roles.sql` provides unprivileged, non-login service groups, explicit DML grants, no service deletion/DDL/token administration, and revocation of PUBLIC schema-create/TEMP permissions. Runtime and replay economic state cannot cross FORWARD/run-specific boundaries. Restricted API, replay and notifier flows were rehearsed against a restored database, not merely inspected as SQL text.
- Native Linux systemd/Caddy assets separate API, runtime, CPU-heavy replay and notifier users/processes/environment, give the runtime priority, and bound background CPU/memory. GitHub Actions defines native PostgreSQL/Node 22 release gates and configuration validation without Docker or external trading/messaging credentials. Optional local `.env` loading supports externally supplied production environments.
- `npm run security:check` guards tracked artifact hygiene, likely hard-coded Telegram/raw bearer files, PAPER-only exchange endpoints and notification imports on critical paths. It is included in `npm run check`; it is not a general penetration test or complete secret detector.

## Verification

Verified locally with Node 22.23.2 and native PostgreSQL 17:

- `npm run check` passed: TypeScript checks, 74 unit tests and 76 integration/process/database tests (150 total), production TypeScript/Vite builds, and the security regression checks.
- `npm run format:check` and `git diff --check` passed.
- `npm audit --omit=dev --fetch-retries=1 --fetch-timeout=15000` reported zero vulnerabilities after retrying a transient DNS failure.
- `npm run db:migrate` applied migrations 0029–0032 to the development database. Test migrations and disposable restore rehearsals also passed during the integration suite.
- `npm run ops:verify` passed against development, reporting zero PAPER trades and zero unresolved trades; populated lifecycle conservation is covered by the integration fixtures above.
- `npm run db:generate` reported no schema changes. The new service-scope guards are custom SQL migrations.

New release evidence includes:

- 1,000 seeded randomized sizing cases across all risk profiles; 12 randomized real-PostgreSQL lifecycle sequences with partial fills, duplicate price events, signed funding, explicit cancellation, exits and reservation release. Economic results reconcile to emitted facts without topping up the independent second bot.
- Native backup/restore of an open partially filled, protected PAPER position plus ledger and queued notification. Restored facts match, ledger immutability remains enforced, previous-owner writes fail, corrupt/nonempty restores are refused, and restricted service-role API/replay/notifier flows succeed while forbidden financial/credential/control access fails.
- Concurrent migration runners, modified-history rejection, partially executed DDL rollback and unchanged migration journal after failure.
- Private viewer-token issuance, refusal to overwrite its output file, scoped audited revocation and API 401/403 enforcement.
- Freeze during asynchronous strategy persistence and during submission authorization, cancellation of unfilled remainder with continued stop management, and injected database failure before the adapter boundary.
- A separate replay process executes a 50,000-event job with injected CPU-heavy indicator-style work while a hanging Telegram sender remains pending. Forward PAPER entry risk approval, fills, confirmed protection and stop-loss closure finish within the asserted four-second regression bound; the replay process remains independently alive until deliberately killed.

## Acceptance mapping

Existing Section 22 suites remain release blockers: closed-candle/no-lookahead/TA warmup, duplicate evaluation and fill idempotency, $20 → $19.50 net-loss isolation, minimum-order rejection, allocation/reservation concurrency, partial and late fills, expiry, desired/submitted/confirmed stops, unknown submission, strict coin ownership, fencing, complete/ambiguous gap recovery, reproducible walk-forward/holdout/golden replay, incident grouping, NO_TRADE suppression and durable notification retry. New tests add the operations/property/process/security evidence above. LIVE-specific exchange reconciliation tests are not activated by this PAPER milestone; no private exchange adapter is implemented or authorized.

## Runbooks and deployment boundary

[Native deployment/backup/rollback](../deploy/README.md), [incident playbooks](../deploy/INCIDENTS.md), and [security review](security-review.md) describe exact workflows and remaining trust boundaries. CI is defined, not claimed to have executed remotely. Systemd/Caddy assets require target Linux validation; this macOS host does not provide systemd/cgroups or provision DNS/certificates. No remote production deployment, public exposure, real Telegram send, off-host backup schedule, measured production RPO/RTO or multi-day public-data soak was performed.

PAPER readiness is bounded by conservative public-data evidence: missing trade ordering remains uncertain; no restart, incident acknowledgment, restore or environment flag fabricates a favorable exit. Snapshots recover only their captured point in time and must be protected/encrypted by the operator. PostgreSQL and the migration/restore administrator remain trusted. Resource limits and a local regression load test do not guarantee capacity for arbitrary market counts; validate the deployment host before enabling new paper entries. Engine/migration changes invalidate old queued/resuming replay manifests; drain before upgrades or create fresh runs.
