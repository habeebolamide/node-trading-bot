import { configFromEnv } from '../packages/core/src/index.js';
import { connectDatabase } from '../packages/database/src/index.js';
import { registerResearchStrategies } from '../packages/database/src/strategies.js';
const { db, pool } = connectDatabase(configFromEnv().DATABASE_URL);
try {
  console.log(
    JSON.stringify(
      {
        validation: 'RESEARCH_UNVALIDATED',
        registered: await registerResearchStrategies(db),
      },
      null,
      2,
    ),
  );
} finally {
  await pool.end();
}
