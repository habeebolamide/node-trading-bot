import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull } from 'drizzle-orm';
import { z, ZodError } from 'zod';
import {
  DomainError,
  botCreateSchema,
  botUpdateSchema,
  createLogger,
} from '../../../packages/core/src/index.js';
import {
  tokens,
  strategyVersions,
  strategies,
  type Database,
} from '../../../packages/database/src/index.js';
import {
  BotRepository,
  type Actor,
} from '../../../packages/database/src/bots.js';
import type { Pool } from 'pg';
export function createApp(db: Database, pool: Pool, log = createLogger('api')) {
  const app = express();
  const repo = new BotRepository(db);
  app.disable('x-powered-by');
  app.use(helmet());
  app.use((req, res, next) => {
    res.locals.correlationId = randomUUID();
    res.setHeader('X-Correlation-ID', res.locals.correlationId);
    res.on('finish', () =>
      log.info(
        {
          correlationId: res.locals.correlationId,
          method: req.method,
          status: res.statusCode,
        },
        'request completed',
      ),
    );
    next();
  });
  app.use(
    rateLimit({
      windowMs: 60000,
      limit: 120,
      standardHeaders: 'draft-8',
      legacyHeaders: false,
    }),
  );
  app.use(express.json({ limit: '32kb' }));
  app.get('/health/live', (_req, res) =>
    res.json({ status: 'alive', service: 'api' }),
  );
  app.get('/health/ready', async (_req, res) => {
    try {
      await pool.query(
        'select b.config_version from bots b, api_tokens t limit 0',
      );
      res.json({
        status: 'ready',
        executionMode: 'PAPER',
        capabilities: ['bot_configuration'],
        acceptsNewEntries: false,
      });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.use('/api', async (req, res, next) => {
    try {
      const match = /^Bearer ([A-Za-z0-9_-]{43})$/.exec(
        req.headers.authorization ?? '',
      );
      if (!match?.[1])
        throw new DomainError(
          'UNAUTHORIZED',
          'A valid bearer token is required',
          401,
        );
      const hash = createHash('sha256').update(match[1]).digest('hex');
      const [token] = await db
        .select()
        .from(tokens)
        .where(
          and(
            eq(tokens.tokenHash, hash),
            isNull(tokens.revokedAt),
            gt(tokens.expiresAt, new Date()),
          ),
        );
      if (!token)
        throw new DomainError(
          'UNAUTHORIZED',
          'A valid bearer token is required',
          401,
        );
      res.locals.actor = { userId: token.userId, role: token.role } satisfies {
        userId: string;
        role: string;
      };
      if (
        !['GET', 'HEAD', 'OPTIONS'].includes(req.method) &&
        token.role !== 'OWNER'
      )
        throw new DomainError('FORBIDDEN', 'Owner permission required', 403);
      next();
    } catch (e) {
      next(e);
    }
  });
  const actor = (res: Response) => res.locals.actor as Actor;
  const id = (req: Request) => z.uuid().parse(req.params.id);
  app.get('/api/strategies', async (_req, res) =>
    res.json({
      data: await db
        .select({
          id: strategyVersions.id,
          slug: strategies.slug,
          name: strategies.name,
          version: strategyVersions.version,
          status: strategyVersions.status,
          requirements: strategyVersions.requirements,
        })
        .from(strategyVersions)
        .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId)),
    }),
  );
  app.get('/api/account', async (_req, res) =>
    res.json({ data: await repo.account(actor(res)) }),
  );
  app.get('/api/bots', async (_req, res) =>
    res.json({ data: await repo.list(actor(res)) }),
  );
  app.post('/api/bots', async (req, res) =>
    res.status(201).json({
      data: await repo.create(
        actor(res),
        botCreateSchema.parse(req.body),
        res.locals.correlationId,
      ),
    }),
  );
  app.get('/api/bots/:id', async (req, res) =>
    res.json({ data: await repo.get(actor(res), id(req)) }),
  );
  app.get('/api/bots/:id/config-versions', async (req, res) =>
    res.json({ data: await repo.history(actor(res), id(req)) }),
  );
  app.patch('/api/bots/:id', async (req, res) =>
    res.json({
      data: await repo.update(
        actor(res),
        id(req),
        botUpdateSchema.parse(req.body),
        res.locals.correlationId,
      ),
    }),
  );
  app.use((_req, _res, next) =>
    next(new DomainError('NOT_FOUND', 'Route not found', 404)),
  );
  app.use(
    (error: unknown, _req: Request, res: Response, _next: NextFunction) => {
      let status = 500,
        code = 'INTERNAL_ERROR',
        message = 'Request failed';
      if (error instanceof DomainError) {
        status = error.status;
        code = error.code;
        message = error.message;
      } else if (error instanceof ZodError) {
        status = 400;
        code = 'VALIDATION_ERROR';
        message = error.issues
          .map((i) => `${i.path.join('.')}: ${i.message}`)
          .join('; ');
      } else {
        let dbError = error as {
          code?: string;
          constraint?: string;
          cause?: unknown;
          type?: string;
        };
        if (dbError.cause) dbError = dbError.cause as typeof dbError;
        if (dbError.code === '23505') {
          status = 409;
          code = 'CONFLICT';
          message =
            dbError.constraint === 'uq_active_coin_owner'
              ? 'Coin already assigned to a bot'
              : 'Record already exists';
        } else if (dbError.code === '23514') {
          status = 409;
          code = 'CONSTRAINT_VIOLATION';
          message =
            dbError.constraint === 'account_allocation_cap'
              ? 'Total target allocation cannot exceed 80%'
              : 'Operation violates platform constraints';
        } else if (dbError.type === 'entity.too.large') {
          status = 413;
          code = 'PAYLOAD_TOO_LARGE';
          message = 'Request body exceeds 32kb';
        } else if (dbError.type === 'entity.parse.failed') {
          status = 400;
          code = 'INVALID_JSON';
          message = 'Invalid JSON body';
        }
        if (status === 500)
          log.error(
            {
              correlationId: res.locals.correlationId,
              errorCode: dbError.code ?? 'unknown',
            },
            'request failed',
          );
      }
      res.status(status).json({
        error: { code, message, correlationId: res.locals.correlationId },
      });
    },
  );
  return app;
}
