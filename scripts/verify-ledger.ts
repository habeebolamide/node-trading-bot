import { connectDatabase } from '../packages/database/src/index.js';
import { verifyFinancialIntegrity } from '../packages/operations/src/integrity.js';
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const { pool } = connectDatabase(process.env.DATABASE_URL);
try {
  console.log(JSON.stringify(await verifyFinancialIntegrity(pool)));
} finally {
  await pool.end();
}
