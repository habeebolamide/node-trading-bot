#!/usr/bin/env node
/**
 * Brain-seeding CLI (§30 pre-launch gate). Reads flags → runs `seedBrain` → prints gate report.
 *
 * Usage:
 *   npm run seed-brain --workspace @tip/scripts -- \
 *     --agent <tradingAgentId> --symbols BTCUSDT,ETHUSDT,SOLUSDT \
 *     --from 2026-01-01 --to 2026-07-01 [--dry-run] [--max-steps 50000]
 */
import { createDb, closeDb } from '@tip/database';
import { loadConfig, loadEnv, configureLogger } from '@tip/domain';
import { buildGateReport, formatGateReport, seedBrain } from '@tip/seeding';
import { and, eq } from 'drizzle-orm';
import { scoringConfig } from '@tip/database';

function parseArgs(argv: readonly string[]): Record<string, string | boolean> {
  const out: Record<string, string | boolean> = {};
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i];
    if (!a || !a.startsWith('--')) continue;
    const key = a.slice(2);
    const next = argv[i + 1];
    if (!next || next.startsWith('--')) { out[key] = true; }
    else { out[key] = next; i++; }
  }
  return out;
}

async function main(): Promise<void> {
  loadEnv();
  const cfg = loadConfig(process.env as Record<string, string>);
  configureLogger({ level: 'info', file: 'logs/seed-brain.log' });

  const args = parseArgs(process.argv.slice(2));
  const agent = String(args.agent ?? '').trim();
  const symbolsStr = String(args.symbols ?? '').trim();
  const from = args.from ? new Date(String(args.from)) : null;
  const to = args.to ? new Date(String(args.to)) : null;
  const dryRun = Boolean(args['dry-run']);
  const maxSteps = args['max-steps'] ? Number(args['max-steps']) : undefined;

  if (!agent || !symbolsStr || !from || !to) {
    // eslint-disable-next-line no-console
    console.error('Usage: seed-brain --agent <id> --symbols BTCUSDT,ETHUSDT,SOLUSDT --from YYYY-MM-DD --to YYYY-MM-DD [--dry-run] [--max-steps N]');
    process.exit(1);
  }
  if (isNaN(from.getTime()) || isNaN(to.getTime())) {
    console.error('--from and --to must be valid ISO dates');
    process.exit(1);
  }

  const db = createDb(cfg.DATABASE_URL);
  try {
    const symbols = symbolsStr.split(',').map((s) => s.trim()).filter(Boolean);

    // Look up the tradingAgent's configVersion for the gate report.
    const cfgRow = (await db.select().from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, agent), eq(scoringConfig.active, true)))
      .limit(1))[0];
    if (!cfgRow) { console.error('tradingAgent has no active scoringConfig'); process.exit(1); }

    const seedOpts = {
      db, tradingAgentId: agent, symbols, from, to, dryRun,
      ...(maxSteps !== undefined ? { maxStepsPerSymbol: maxSteps } : {}),
    };
    const { perSymbol } = await seedBrain(seedOpts);

    const report = await buildGateReport(db, {
      range: { from, to }, symbols, configVersion: cfgRow.version, perSymbol,
    });
    // eslint-disable-next-line no-console
    console.log('\n' + formatGateReport(report));
  } finally {
    await closeDb(db);
  }
}

main().catch((e) => { console.error(e); process.exit(1); });
