CREATE TABLE IF NOT EXISTS "judge_decision" (
	"signal_id" text NOT NULL,
	"judge_version" integer NOT NULL,
	"judge_action" text NOT NULL,
	"det_confidence" numeric NOT NULL,
	"judge_confidence" numeric NOT NULL,
	"det_direction" text NOT NULL,
	"judge_direction" text NOT NULL,
	"gap" numeric NOT NULL,
	"config_version" integer NOT NULL,
	"flip_refused_by_planner" boolean DEFAULT false NOT NULL,
	"created_at" timestamp with time zone DEFAULT now() NOT NULL,
	CONSTRAINT "judge_decision_signal_id_judge_version_pk" PRIMARY KEY("signal_id","judge_version")
);
--> statement-breakpoint
CREATE INDEX IF NOT EXISTS "judge_decision_action_idx" ON "judge_decision" USING btree ("judge_action");