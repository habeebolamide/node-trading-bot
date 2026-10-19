import {
  createExperiment,
  queueValidation,
} from '../packages/replay/src/validation.js';
import { readFileSync } from 'node:fs';
import { parseArgs } from 'node:util';
import { eq } from 'drizzle-orm';
import { connectDatabase, users } from '../packages/database/src/index.js';
import { enqueueReplay, executeReplay } from '../packages/replay/src/runner.js';
const { values } = parseArgs({
  options: {
    file: { type: 'string' },
    owner: { type: 'string' },
    run: { type: 'boolean', default: false },
    experiment: { type: 'boolean', default: false },
  },
});
if (!values.file || !values.owner || !process.env.DATABASE_URL)
  throw Error(
    'Usage: npm run backtest -- --file /absolute/input.json --owner owner@email [--run]',
  );
const { db, pool } = connectDatabase(process.env.DATABASE_URL);
try {
  const [user] = await db
    .select()
    .from(users)
    .where(eq(users.email, values.owner));
  if (!user) throw Error('Owner not found');
  const actor = { userId: user.id, role: 'OWNER' as const },
    input = JSON.parse(readFileSync(values.file, 'utf8'));
  if (values.experiment) {
    const experiment = await createExperiment(db, actor, input),
      variants = experiment.variants as { key: string }[],
      plan = experiment.plan as { tests: unknown[] };
    console.log(
      JSON.stringify({
        experimentId: experiment.id,
        holdout: 'LOCKED_UNTIL_REVIEWED_SELECTION',
      }),
    );
    for (const variant of variants)
      for (const stage of ['TRAIN', 'TEST'] as const)
        for (let n = 0; n < (stage === 'TRAIN' ? 1 : plan.tests.length); n++) {
          const run = await queueValidation(
            db,
            actor,
            experiment.id,
            variant.key,
            stage,
            n,
          );
          console.log(
            JSON.stringify({
              runId: run.id,
              variant: variant.key,
              stage,
              windowIndex: n,
            }),
          );
          if (values.run) {
            const report = await executeReplay(db, run.id);
            console.log(
              JSON.stringify({
                runId: run.id,
                status: report?.status,
                metrics: report?.metrics,
                warnings: report?.warnings,
              }),
            );
          }
        }
  } else {
    const run = await enqueueReplay(db, actor, input);
    console.log(JSON.stringify({ runId: run.id, inputHash: run.inputHash }));
    if (values.run)
      console.log(JSON.stringify(await executeReplay(db, run.id)));
  }
} finally {
  await pool.end();
}
