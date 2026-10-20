import { parseArgs } from 'node:util';
import { randomBytes, createHash, randomUUID } from 'node:crypto';
import { open, unlink } from 'node:fs/promises';
import { resolve } from 'node:path';
import { z } from 'zod';
import { connectDatabase } from '../packages/database/src/index.js';
const { values } = parseArgs({
  options: {
    action: { type: 'string' },
    owner: { type: 'string' },
    role: { type: 'string', default: 'VIEWER' },
    out: { type: 'string' },
    'token-id': { type: 'string' },
    reason: { type: 'string' },
  },
});
const action = z.enum(['issue', 'revoke']).parse(values.action),
  email = z.email().parse(values.owner),
  reason = z.string().trim().min(1).max(500).parse(values.reason);
if (!process.env.DATABASE_URL) throw Error('DATABASE_URL required');
const { pool } = connectDatabase(process.env.DATABASE_URL),
  client = await pool.connect();
let createdFile: string | undefined;
try {
  await client.query('BEGIN');
  const a = (
    await client.query(
      "SELECT a.* FROM exchange_accounts a JOIN app_users u ON u.id=a.owner_user_id WHERE u.email=$1 AND a.replay_scope='FORWARD' FOR UPDATE",
      [email],
    )
  ).rows[0];
  if (!a) throw Error('Forward owner account not found');
  let details: unknown;
  if (action === 'issue') {
    const role = z.enum(['OWNER', 'VIEWER']).parse(values.role);
    if (!values.out)
      throw Error('--out required; token is written once to a private file');
    const path = resolve(values.out),
      file = await open(path, 'wx', 0o600);
    createdFile = path;
    const raw = randomBytes(32).toString('base64url');
    try {
      await file.writeFile(raw + '\n');
      await file.sync();
    } finally {
      await file.close();
    }
    const token = (
      await client.query(
        "INSERT INTO api_tokens(user_id,token_hash,role,expires_at) VALUES($1,$2,$3,now()+interval '30 days') RETURNING id,expires_at",
        [a.owner_user_id, createHash('sha256').update(raw).digest('hex'), role],
      )
    ).rows[0];
    details = { tokenId: token.id, role, expiresAt: token.expires_at, reason };
  } else {
    const id = z.uuid().parse(values['token-id']);
    const changed = await client.query(
      'UPDATE api_tokens SET revoked_at=coalesce(revoked_at,now()) WHERE id=$1 AND user_id=$2 RETURNING id',
      [id, a.owner_user_id],
    );
    if (!changed.rowCount) throw Error('Token not found for owner');
    details = { tokenId: id, reason };
  }
  await client.query(
    'INSERT INTO audit_events(account_id,actor_id,event_type,correlation_id,details) VALUES($1,$2,$3,$4,$5)',
    [
      a.id,
      a.owner_user_id,
      `security.token.${action}`,
      randomUUID(),
      JSON.stringify(details),
    ],
  );
  await client.query('COMMIT');
  console.log(
    action === 'issue'
      ? 'Token issued to the private output file; expires in 30 days'
      : 'Token revoked',
  );
} catch (e) {
  await client.query('ROLLBACK');
  if (createdFile) await unlink(createdFile).catch(() => {});
  throw e;
} finally {
  client.release();
  await pool.end();
}
