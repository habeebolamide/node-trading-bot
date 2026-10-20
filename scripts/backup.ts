import { parseArgs } from 'node:util';
import {
  backupDatabase,
  restoreDatabase,
} from '../packages/operations/src/backup.js';
const { values, positionals } = parseArgs({
  allowPositionals: true,
  options: { file: { type: 'string' }, 'confirm-target': { type: 'string' } },
});
if (!process.env.DATABASE_URL || !values.file)
  throw Error('DATABASE_URL and --file are required');
if (positionals[0] === 'backup') {
  await backupDatabase(process.env.DATABASE_URL, values.file);
  console.log('Private backup and checksum manifest created');
} else if (positionals[0] === 'restore') {
  await restoreDatabase(
    process.env.DATABASE_URL,
    values.file,
    values['confirm-target'] ?? '',
  );
  console.log('Backup restored transactionally to the empty target');
} else throw Error('Use backup or restore');
