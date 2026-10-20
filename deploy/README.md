# Native PAPER deployment and rollback

This milestone runs PAPER only. It does not authorize LIVE orders or deploy to an unspecified server. Linux systemd/Caddy assets are supplied; local verification uses native PostgreSQL on macOS. Use a dedicated host with at least two logical CPUs and sufficient memory for PostgreSQL plus the four Node processes. Calibrate limits under your own market count; the worker gets lower CPU/memory priority than the trading runtime.

## Prepare a release

Use an immutable release directory from a reviewed clean Git commit. Install Node **22.23.2** at `/opt/node22` (or edit ExecStart consistently) and native PostgreSQL 17 server/client utilities. Install Caddy from its official package repository. Keep PostgreSQL local; never expose ports 3000–3003 or PostgreSQL to the Internet. Use a SCRAM/password-authenticated local database, a restricted OS account per process, and a separate database administrator/migration identity. Do not reuse the macOS development trust-auth cluster in production.

```sh
npm ci
npm run check
npm run format:check
npm audit --omit=dev --audit-level=high
```

CI uses native PostgreSQL, never Docker and never exchange/Telegram credentials. All strategy, financial, replay, fencing, backup/restore and isolation suites are release blockers. CI configuration is in `.github/workflows/ci.yml`; local success is not a claim that a remote workflow has run.

Create `/opt/strategy-platform/releases/<commit>` from this clean revision with its matching `node_modules`, `dist`, `apps/web/dist`, package lock and migration sources. Record the commit and `sha256sum package-lock.json`. Build native TA-Lib on the deployment OS; do not copy macOS node_modules to Linux. Retain the previous tested release and a private database backup.

## Identities and environment

Create group `strategy` and OS users `strategy-api`, `strategy-runtime`, `strategy-worker`, `strategy-notifier` with no interactive login. Code is owned by the release administrator and read-only to services. Make `/etc/strategy-platform` root-only, with four root-owned `0600` environment files. systemd reads these before dropping privileges. Do not place secrets in the release, unit file, command arguments, Git, logs or frontend.

Each file contains its own `DATABASE_URL`, `NODE_ENV=production`, and `EXECUTION_MODE=PAPER`. API sets `API_HOST=127.0.0.1` and `API_PORT=3000`; runtime uses health port 3001, worker 3002, notifier 3003. Only notifier receives `TELEGRAM_BOT_TOKEN`. API/runtime/worker must not receive exchange credentials. Runtime starts with `PAPER_ENTRIES_ENABLED=false`; this durable policy cancels pending remainders and leaves filled positions protected/managed. Setting it true allows new proposals only after all ordinary market, reconciliation and risk checks pass. It never clears uncertain history.

As the migration database owner, run `npm run db:migrate`, then apply `deploy/roles.sql` with psql in that database. The SQL creates non-login group roles and grants only the required table operations. Use your administrator's password-management flow (`\password`, SCRAM or managed secrets) to create four independent LOGIN roles and grant **exactly one** corresponding group: platform_api, platform_runtime, platform_worker, platform_notifier. They must not be database/schema owners, superusers, CREATEROLE, BYPASSRLS or members of another service role. Configure each URL with its login. Runtime writes are constrained to FORWARD accounts; the replay worker is constrained to REPLAY economic state by migrations 0029–0032, in addition to lease fencing. Notifier cannot mutate financial tables; services cannot issue tokens or migrate. Re-run grants after schema migrations; future tables are not automatically granted broad rights.

Bootstrap and token administration use the separate privileged identity. Issue a viewer token for routine observation:

```sh
npm run ops:token -- --action issue --owner owner@localhost.test --role VIEWER --out /private/token.txt --reason 'Read-only operator access'
```

The output file must not exist; it is created `0600`. Tokens last 30 days. Revoke by scoped token UUID using `--action revoke --owner ... --token-id ... --reason ...`. Both changes produce immutable audits without raw token/hash values. Bootstrap OWNER issuance is also audited and prints only after commit. Do not copy a bearer token into Telegram or a URL.

## Install and start

Install `systemd/strategy@.service` and its instance drop-in directories in `/etc/systemd/system`. Point `/opt/strategy-platform/current` to the tested release. Then:

```sh
sudo systemctl daemon-reload
sudo systemctl enable --now strategy@api strategy@runtime strategy@worker strategy@notifier
```

Units default to Protect & Freeze. They have independent users, environment, restart policy, database connections and health ports. Worker and notifier have CPU quotas, lower weights/nice priorities and bounded memory. Runtime has higher CPU weight and lower OOM score. Configure alerts for **any** service restart, memory limit, stale heartbeat, unresolved exposure or failed backup. Those resource settings require Linux cgroups and must be checked on the target host; they are not emulated on macOS.

Set `PLATFORM_DOMAIN` in Caddy's environment to your actual DNS name, validate with `caddy validate --config deploy/Caddyfile --adapter caddyfile`, then install/reload that configuration. Caddy terminates TLS, proxies same-origin requests and streams SSE without buffering; health URLs are unavailable externally. Access logs are disabled by default. Keep administrative health checks local. API trusts forwarding headers only from loopback in production and forbids a public API bind.

Check all four local `/health/ready` URLs, dashboard sign-in, simulator labels, pending commands, account capital and `npm run ops:verify`. Readiness is process/schema readiness; individual entries can remain blocked. Confirm no unresolved gaps/orders/protection faults and no unexpected legacy FAKE exposure. Only then explicitly enable PAPER entries in the runtime environment and restart **that process**. Restart with open exposure creates a durable uncertain gap if missing public trades cannot be certified. Rehearse the recovery playbook before enabling entries; do not repeatedly restart an exposed bot expecting uncertainty to clear.

## Back up and restore

Use a private directory and an authorized read-only backup identity with access to **all schemas**, including Drizzle history. Supply `DATABASE_URL` and optionally `PG_BIN_DIR` via a private operator environment. Backups contain financial and recipient information and token hashes: encrypt storage/transfer and restrict access. Filesystem checksums detect accidental corruption, not a malicious archive plus modified manifest. Record the backup creation timestamp and measured restore duration externally; off-host retention and backup schedules must be established by the operator.

```sh
mkdir -m 700 /private/backups
npm run ops:backup -- --file /private/backups/paper.dump
```

The command creates a consistent custom-format pg_dump archive and checksum manifest, both `0600`, refuses to overwrite existing paths, fsyncs files and directory, and never puts a password in process arguments. Use matching PostgreSQL client tools. A dump is a consistent snapshot, not PITR/WAL archiving; data committed afterward is outside its recovery point.

Stop all services before promoting any restore. Create a **new, empty, isolated database** owned by the migration identity. Set DATABASE_URL to that new target (never pass the credential URL as a shell argument) and run:

```sh
npm run ops:restore -- --file /private/backups/paper.dump --confirm-target exact_database_name
npm run ops:verify
```

Restore verifies bytes/hash before touching the target, refuses any existing objects or other sessions, and uses pg_restore `--single-transaction --exit-on-error`. It checks restored execution/ledger/funding/reservation conservation, expires runtime/replay/notification leases, and advances runtime fences. Do not connect services until the command has exited successfully. On failure, leave the target offline and discard/recreate it; do not partly repair it. Restore never drops your existing database. Reapply restricted service grants and rotate credentials as appropriate; database dumps do not contain cluster role/password definitions. Confirm migration checksums using the exact release that produced the backup before any upgrade. Start services frozen, inspect surviving incidents/outbox/commands, reconcile gaps, then follow the explicit enablement procedure. Public REST recent trades cannot prove complete historical TP/SL ordering.

## Controlled upgrade and rollback

1. Freeze new entries and inspect exposure. Drain queued replay jobs or pause the replay worker: manifests pin exact engine/migration sources, so changed code rejects old queued/resuming jobs rather than silently mixing versions.
2. Stop runtime, worker and notifier cleanly. Verify lease release/expiry, preserve protective state and snapshot the database. Stop API writes for schema migration. A SIGKILL requires conservative gap recovery on restart.
3. Restore the backup to a disposable clone, apply candidate migrations there, run integrity and smoke checks. Migrations serialize with an advisory lock, validate the complete applied SHA-256 history and roll back failed pending DDL. Never edit an applied file.
4. Apply migrations once with the privileged identity; reapply grants. Atomically switch the `current` symlink to the candidate release on the same filesystem, restart services frozen and verify all readiness, financial and incident checks.
5. For rollback, use the previous binary only if its compatibility with the **current** schema was rehearsed on a clone. Otherwise restore the pre-upgrade snapshot into a new database and point the matching old release at that target. Never run down migrations or overwrite the only good database. Restoring loses later commits: assess that recovery point before promotion.
6. Keep the old release and database until the candidate passes an observed paper soak. Actual public-data soak, host resources, certificates, DNS and off-host backup promotion are deployment-specific checks; no code-only test can certify them.

References: [PostgreSQL pg_restore](https://www.postgresql.org/docs/17/app-pgrestore.html), [systemd resource controls](https://www.freedesktop.org/software/systemd/man/latest/systemd.resource-control.html), [Caddy reverse proxy](https://caddyserver.com/docs/caddyfile/directives/reverse_proxy).
