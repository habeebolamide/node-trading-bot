/**
 * Minimal structured logger (zero-dependency). Writes level-gated lines to the console AND appends
 * them to a log file (default `logs/app.log`) — the file-logger the previous bot had as `info.log`.
 * Errors/warnings go to stderr; info/debug to stdout; everything ≥ the configured level is also
 * appended to the file so there's a durable record.
 *
 * Configure once at app/script startup: `configureLogger({ level: config.LOG_LEVEL, file })`.
 * The logger does NOT read process.env itself (that's config.ts's job) — the level is injected.
 */
import { appendFileSync, mkdirSync } from 'node:fs';
import { dirname } from 'node:path';

export type LogLevel = 'debug' | 'info' | 'warn' | 'error';
const RANK: Record<LogLevel, number> = { debug: 10, info: 20, warn: 30, error: 40 };

let minLevel: LogLevel = 'info';
let logFile: string | null = 'logs/app.log';
let fileBroken = false;

export interface LoggerConfig {
  level?: LogLevel;
  /** Absolute or cwd-relative path. Pass null to disable file logging (console only). */
  file?: string | null;
}

/** Set the global level and log-file destination. Call once at startup. */
export function configureLogger(cfg: LoggerConfig): void {
  if (cfg.level) minLevel = cfg.level;
  if (cfg.file !== undefined) logFile = cfg.file;
  fileBroken = false;
}

export interface Logger {
  debug(msg: string, meta?: unknown): void;
  info(msg: string, meta?: unknown): void;
  warn(msg: string, meta?: unknown): void;
  error(msg: string, meta?: unknown): void;
  /** Child logger with an extra scope segment. */
  child(scope: string): Logger;
}

function safeMeta(meta: unknown): string {
  if (meta === undefined) return '';
  try {
    return ' ' + (typeof meta === 'string' ? meta : JSON.stringify(meta));
  } catch {
    return ' [unserializable meta]';
  }
}

function write(level: LogLevel, scope: string, msg: string, meta?: unknown): void {
  if (RANK[level] < RANK[minLevel]) return;
  const line = `${new Date().toISOString()} ${level.toUpperCase().padEnd(5)} [${scope}] ${msg}${safeMeta(meta)}`;
  (level === 'error' || level === 'warn' ? process.stderr : process.stdout).write(line + '\n');
  if (logFile && !fileBroken) {
    try {
      mkdirSync(dirname(logFile), { recursive: true });
      appendFileSync(logFile, line + '\n');
    } catch {
      fileBroken = true; // never let logging crash the app; fall back to console-only
    }
  }
}

/** Create a logger for a named scope (e.g. "backfill", "bybit-adapter"). */
export function createLogger(scope: string): Logger {
  return {
    debug: (m, meta) => write('debug', scope, m, meta),
    info: (m, meta) => write('info', scope, m, meta),
    warn: (m, meta) => write('warn', scope, m, meta),
    error: (m, meta) => write('error', scope, m, meta),
    child: (child) => createLogger(`${scope}:${child}`),
  };
}
