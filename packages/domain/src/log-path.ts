/**
 * Resolve `<repo-root>/logs/<scope>.log` from anywhere in the workspace tree. Walks upward
 * from a given anchor (`__dirname`) until it finds the file that marks the repo root — the
 * `package.json` with `"workspaces"` — then joins `logs/<scope>.log`.
 *
 * Callers pass `import.meta.url` (or dirname of it) so the walk starts from the CALLER'S file,
 * not from `process.cwd()` — cwd is whatever the operator ran the process from and shouldn't
 * decide log placement. The walk is bounded to 12 levels; if nothing matches we fall back to
 * a cwd-relative path (never throw — logging must not crash a running process).
 */
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve, join } from 'node:path';
import { fileURLToPath } from 'node:url';

export type LogScope = 'api' | 'worker' | 'dashboard' | (string & {});

function findRepoRoot(startDir: string): string {
  let dir = startDir;
  for (let i = 0; i < 12; i++) {
    const pkg = join(dir, 'package.json');
    if (existsSync(pkg)) {
      try {
        const j = JSON.parse(readFileSync(pkg, 'utf8')) as { workspaces?: unknown };
        if (j.workspaces !== undefined) return dir;
      } catch { /* keep walking */ }
    }
    const parent = dirname(dir);
    if (parent === dir) break;
    dir = parent;
  }
  return startDir; // last resort
}

/** Returns the absolute log-file path for the given scope. Anchor to `import.meta.url` in the
 *  caller so the walk starts from the compiled file, not cwd. */
export function logFilePathFor(scope: LogScope, anchorFileUrl: string): string {
  const anchor = dirname(fileURLToPath(anchorFileUrl));
  const root = findRepoRoot(anchor);
  return resolve(root, 'logs', `${scope}.log`);
}
