CREATE TABLE "incident_events" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"incident_id" uuid NOT NULL,
	"actor_id" uuid,
	"kind" text NOT NULL,
	"evidence" jsonb NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_attempts" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"outbox_id" uuid NOT NULL,
	"attempt_no" integer NOT NULL,
	"result" text NOT NULL,
	"message_id" text,
	"retry_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_outbox" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"domain_event_id" text NOT NULL,
	"destination" text DEFAULT 'TELEGRAM' NOT NULL,
	"recipient_ref" text NOT NULL,
	"template_key" text NOT NULL,
	"payload_snapshot" jsonb NOT NULL,
	"dedupe_key" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'PENDING' NOT NULL,
	"available_at" timestamp with time zone DEFAULT now() NOT NULL,
	"attempt_count" integer DEFAULT 0 NOT NULL,
	"lease_token" uuid,
	"lease_until" timestamp with time zone,
	"last_error" text,
	"sent_at" timestamp with time zone,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "notification_outbox_dedupe_key_unique" UNIQUE("dedupe_key")
);
--> statement-breakpoint
CREATE TABLE "notification_preferences" (
	"scope" text PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL,
	"bot_id" uuid,
	"enabled" boolean DEFAULT false NOT NULL,
	"recipient_ref" text,
	"events" jsonb DEFAULT '["ENTRY","EXIT","PROTECTION","RECOVERY"]'::jsonb NOT NULL,
	"updated_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_worker_health" (
	"id" text PRIMARY KEY NOT NULL,
	"observed_at" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
CREATE TABLE "notification_projected_events" (
	"event_id" uuid PRIMARY KEY NOT NULL,
	"account_id" uuid NOT NULL
);
--> statement-breakpoint
CREATE TABLE "system_incidents" (
	"id" uuid PRIMARY KEY DEFAULT gen_random_uuid() NOT NULL,
	"account_id" uuid NOT NULL,
	"fingerprint" text NOT NULL,
	"severity" text NOT NULL,
	"status" text DEFAULT 'ACTIVE' NOT NULL,
	"title" text NOT NULL,
	"affected_bots" jsonb NOT NULL,
	"evidence" jsonb NOT NULL,
	"occurrence_count" integer DEFAULT 1 NOT NULL,
	"first_seen" timestamp with time zone DEFAULT now() NOT NULL,
	"last_seen" timestamp with time zone DEFAULT now() NOT NULL
);
--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_incident_id_system_incidents_id_fk" FOREIGN KEY ("incident_id") REFERENCES "public"."system_incidents"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "incident_events" ADD CONSTRAINT "incident_events_actor_id_app_users_id_fk" FOREIGN KEY ("actor_id") REFERENCES "public"."app_users"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_attempts" ADD CONSTRAINT "notification_attempts_outbox_id_notification_outbox_id_fk" FOREIGN KEY ("outbox_id") REFERENCES "public"."notification_outbox"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_outbox" ADD CONSTRAINT "notification_outbox_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_preferences" ADD CONSTRAINT "notification_preferences_bot_id_bots_id_fk" FOREIGN KEY ("bot_id") REFERENCES "public"."bots"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projected_events" ADD CONSTRAINT "notification_projected_events_event_id_runtime_events_id_fk" FOREIGN KEY ("event_id") REFERENCES "public"."runtime_events"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "notification_projected_events" ADD CONSTRAINT "notification_projected_events_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
ALTER TABLE "system_incidents" ADD CONSTRAINT "system_incidents_account_id_exchange_accounts_id_fk" FOREIGN KEY ("account_id") REFERENCES "public"."exchange_accounts"("id") ON DELETE no action ON UPDATE no action;--> statement-breakpoint
CREATE UNIQUE INDEX "notification_attempt_number" ON "notification_attempts" USING btree ("outbox_id","attempt_no");--> statement-breakpoint
CREATE UNIQUE INDEX "notification_event_destination" ON "notification_outbox" USING btree ("domain_event_id","recipient_ref","template_key");--> statement-breakpoint
CREATE UNIQUE INDEX "incident_fingerprint" ON "system_incidents" USING btree ("account_id","fingerprint");--> statement-breakpoint
CREATE INDEX notification_due ON notification_outbox(status,available_at) WHERE status IN ('PENDING','SENDING');
CREATE INDEX notification_unprojected ON runtime_events(event_time,id);
ALTER TABLE notification_outbox ADD CONSTRAINT delivery_status CHECK(status IN ('PENDING','SENDING','SENT','DEAD')),
 ADD CONSTRAINT delivery_attempts_bounded CHECK(attempt_count BETWEEN 0 AND 5),
 ADD CONSTRAINT delivery_channel CHECK(destination='TELEGRAM'),
 ADD CONSTRAINT delivery_severity CHECK(severity IN ('INFO','WARN','HIGH','CRITICAL'));
ALTER TABLE system_incidents ADD CONSTRAINT incident_status CHECK(status IN ('ACTIVE','ACKNOWLEDGED','RECOVERING','RESOLVED')),
 ADD CONSTRAINT incident_severity CHECK(severity IN ('WARN','HIGH','CRITICAL'));
ALTER TABLE notification_preferences ADD CONSTRAINT preference_scope CHECK(scope=coalesce(bot_id,account_id)::text),
 ADD CONSTRAINT preference_recipient CHECK((NOT enabled OR recipient_ref IS NOT NULL) AND (recipient_ref IS NULL OR recipient_ref ~ '^-?[0-9]{1,20}$')),
 ADD CONSTRAINT preference_bot_account FOREIGN KEY(bot_id,account_id) REFERENCES bots(id,exchange_account_id);
CREATE FUNCTION phase7_append_only() RETURNS trigger LANGUAGE plpgsql AS $$ BEGIN RAISE EXCEPTION 'observability evidence is append only' USING ERRCODE='23514'; END $$;
CREATE TRIGGER incident_event_immutable BEFORE UPDATE OR DELETE ON incident_events FOR EACH ROW EXECUTE FUNCTION phase7_append_only();
