import { cpSync } from 'node:fs';
cpSync('packages/database/migrations', 'dist/packages/database/migrations', {
  recursive: true,
});
