\set ON_ERROR_STOP on
BEGIN;
DO $$ DECLARE role_name text; BEGIN
 FOREACH role_name IN ARRAY ARRAY['platform_api','platform_runtime','platform_worker','platform_notifier'] LOOP
  IF NOT EXISTS(SELECT 1 FROM pg_roles WHERE rolname=role_name) THEN EXECUTE format('CREATE ROLE %I NOLOGIN',role_name); END IF;
 END LOOP;
END $$;
DO $$ BEGIN
 IF EXISTS(SELECT 1 FROM pg_roles WHERE rolname IN ('platform_api','platform_runtime','platform_worker','platform_notifier') AND (rolsuper OR rolcreaterole OR rolcreatedb OR rolbypassrls OR rolcanlogin)) THEN RAISE EXCEPTION 'Service group roles must be unprivileged NOLOGIN roles'; END IF;
 IF EXISTS(SELECT 1 FROM pg_auth_members m JOIN pg_roles r ON r.oid=m.member WHERE r.rolname IN ('platform_api','platform_runtime','platform_worker','platform_notifier')) THEN RAISE EXCEPTION 'Service groups must not inherit other roles'; END IF;
END $$;
REVOKE ALL ON ALL TABLES IN SCHEMA public FROM platform_api,platform_runtime,platform_worker,platform_notifier;
REVOKE ALL ON ALL SEQUENCES IN SCHEMA public FROM platform_api,platform_runtime,platform_worker,platform_notifier;
REVOKE ALL ON SCHEMA public FROM platform_api,platform_runtime,platform_worker,platform_notifier;
REVOKE CREATE ON SCHEMA public FROM PUBLIC;
DO $$BEGIN EXECUTE format('REVOKE CONNECT,TEMPORARY ON DATABASE %I FROM PUBLIC',current_database());
 EXECUTE format('GRANT CONNECT ON DATABASE %I TO platform_api,platform_runtime,platform_worker,platform_notifier',current_database());END $$;
GRANT USAGE ON SCHEMA public TO platform_api,platform_runtime,platform_worker,platform_notifier;
GRANT USAGE,SELECT ON ALL SEQUENCES IN SCHEMA public TO platform_api,platform_runtime,platform_worker,platform_notifier;
GRANT SELECT ON ALL TABLES IN SCHEMA public TO platform_api;
DO $$DECLARE target text; BEGIN
 FOR target IN SELECT tablename FROM pg_tables WHERE schemaname='public' AND tablename<>'api_tokens' LOOP
  EXECUTE format('GRANT SELECT ON %I TO platform_runtime,platform_worker,platform_notifier',target);
 END LOOP;
END $$;
GRANT INSERT ON bots,bot_config_versions,coin_ownership,audit_events,runtime_commands,paper_capital_ledger,replay_runs,replay_experiments,notification_preferences,incident_events,notification_outbox TO platform_api;
GRANT UPDATE ON bots,notification_preferences,system_incidents,replay_experiments TO platform_api;
GRANT INSERT,UPDATE ON bots,runtime_leases,runtime_checkpoints,runtime_events,runtime_actions,trade_lifecycles,paper_marks,paper_price_events,paper_reservations,paper_capital_ledger,paper_execution_reports,paper_funding_events,paper_equity_peaks,recovery_gaps,candles,market_instruments,instrument_versions,market_checkpoints,market_data_gaps TO platform_runtime,platform_worker;
GRANT UPDATE(id) ON exchange_accounts TO platform_api,platform_runtime,platform_worker;
GRANT UPDATE ON runtime_commands TO platform_runtime,platform_worker;
GRANT INSERT ON runtime_commands TO platform_worker;
GRANT INSERT ON audit_events,strategy_evaluations TO platform_runtime,platform_worker;
GRANT UPDATE(slug) ON strategies TO platform_worker;
GRANT INSERT ON app_users,exchange_accounts,bot_config_versions,coin_ownership,strategies,strategy_versions TO platform_worker;
GRANT INSERT,UPDATE ON replay_runs,replay_instruments,replay_samples TO platform_worker;
GRANT INSERT,UPDATE ON system_incidents,notification_outbox,notification_attempts,notification_projected_events,notification_worker_health TO platform_notifier;
GRANT INSERT ON incident_events TO platform_notifier;
-- No service receives DELETE, TRUNCATE, DDL, role management, or token issuance rights.
-- Re-run after every migration; default privileges are deliberately not broad future-table grants.
COMMIT;
