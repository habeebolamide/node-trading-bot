import { z } from 'zod';
import { randomUUID } from 'node:crypto';
import pino from 'pino';

export class DomainError extends Error {
  constructor(
    public code: string,
    message: string,
    public status = 400,
  ) {
    super(message);
  }
}
export interface Clock {
  now(): Date;
}
export const systemClock: Clock = { now: () => new Date() };
export const operationalStates = [
  'STOPPED',
  'STARTING',
  'WARMING_UP',
  'RUNNING',
  'PAUSED',
  'STOP_REQUESTED',
  'RECONCILING',
  'RISK_SUSPENDED',
  'ERROR',
] as const;
export const tradingStates = [
  'IDLE',
  'PENDING_ENTRY',
  'IN_TRADE',
  'CLOSING',
  'UNRESOLVED',
] as const;
export const asset = z
  .string()
  .trim()
  .toUpperCase()
  .regex(/^[A-Z0-9]{2,15}$/)
  .transform((v) => (v === 'XBT' ? 'BTC' : v));
export const marketSchema = z
  .object({
    exchange: z.literal('bybit'),
    marketType: z.enum(['SPOT', 'LINEAR_PERPETUAL']),
    baseAsset: asset,
    quoteAsset: asset,
  })
  .strict()
  .refine((m) => m.baseAsset !== m.quoteAsset, 'Base and quote must differ');
export const allocation = z
  .string()
  .regex(/^(?:0|[1-9]\d?)(?:\.\d{1,6})?$/)
  .refine((v) => Number(v) <= 80, 'Allocation must be <=80%');
export const botCreateSchema = z
  .object({
    name: z.string().trim().min(1).max(100),
    market: marketSchema,
    strategyVersionId: z.uuid(),
    executionMode: z.enum(['PAPER', 'SIGNAL_ONLY']).default('PAPER'),
    riskProfile: z
      .enum(['CONSERVATIVE', 'MODERATE', 'AGGRESSIVE'])
      .default('CONSERVATIVE'),
    allocationTargetPercent: allocation.default('0'),
  })
  .strict()
  .refine(
    (v) =>
      v.executionMode !== 'SIGNAL_ONLY' ||
      Number(v.allocationTargetPercent) === 0,
    'Signal-only bots have no capital allocation',
  );
export const botUpdateSchema = z
  .object({
    name: z.string().trim().min(1).max(100).optional(),
    allocationTargetPercent: allocation.optional(),
    expectedVersion: z.number().int().positive(),
    reason: z.string().trim().min(1).max(500),
  })
  .strict()
  .refine(
    (v) => v.name !== undefined || v.allocationTargetPercent !== undefined,
    'Provide a configuration change',
  );
export type BotInput = z.infer<typeof botCreateSchema>;
export function marketKey(m: BotInput['market']): string {
  return `${m.exchange}:${m.marketType}:${m.baseAsset}/${m.quoteAsset}`;
}
export function configFromEnv(env: NodeJS.ProcessEnv = process.env) {
  return z
    .object({
      NODE_ENV: z
        .enum(['development', 'test', 'production'])
        .default('development'),
      DATABASE_URL: z
        .url()
        .refine((v) => /^postgres(?:ql)?:/.test(v), 'PostgreSQL URL required'),
      API_HOST: z.string().default('127.0.0.1'),
      API_PORT: z.coerce.number().int().min(1).max(65535).default(3000),
      RUNTIME_HEALTH_PORT: z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .default(3001),
      WORKER_HEALTH_PORT: z.coerce
        .number()
        .int()
        .min(1)
        .max(65535)
        .default(3002),
      LOG_LEVEL: z
        .enum(['fatal', 'error', 'warn', 'info', 'debug', 'trace', 'silent'])
        .default('info'),
      EXECUTION_MODE: z.literal('PAPER').default('PAPER'),
    })
    .parse(env);
}
export function createLogger(service: string, level = 'info') {
  return pino({
    name: service,
    level,
    redact: [
      'req.headers.authorization',
      'token',
      'password',
      'databaseUrl',
      'DATABASE_URL',
      'secret',
    ],
  });
}
export interface EventRecorder {
  record(event: {
    eventId: string;
    eventType: string;
    correlationId: string;
    eventTime: Date;
    details: Readonly<Record<string, unknown>>;
  }): Promise<void>;
}
export const correlationId = () => randomUUID();
