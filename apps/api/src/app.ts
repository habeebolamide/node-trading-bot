import { resolve } from 'node:path';
import { dashboardRoutes } from './dashboard.js';
import {
  createExperiment,
  queueValidation,
  selectVariant,
} from '../../../packages/replay/src/validation.js';
import {
  enqueueReplay,
  readReplay,
} from '../../../packages/replay/src/runner.js';
import {
  replayRuns,
  replayExperiments,
} from '../../../packages/database/src/index.js';
import { PaperCapitalRepository } from '../../../packages/database/src/capital.js';
import express, {
  type Request,
  type Response,
  type NextFunction,
} from 'express';
import helmet from 'helmet';
import { rateLimit } from 'express-rate-limit';
import { createHash, randomUUID } from 'node:crypto';
import { and, eq, gt, isNull, desc, sql, getTableColumns } from 'drizzle-orm';
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
  marketCheckpoints,
  evaluations,
} from '../../../packages/database/src/index.js';
import {
  BotRepository,
  type Actor,
} from '../../../packages/database/src/bots.js';
import type { Pool } from 'pg';
import { RuntimeControlRepository } from '../../../packages/database/src/runtime.js';
import {
  runtimeCommands,
  runtimeActions,
  runtimeEvents,
  tradeLifecycles,
} from '../../../packages/database/src/index.js';
export function createApp(db: Database, pool: Pool, log = createLogger('api')) {
  const app = express();
  const repo = new BotRepository(db);
  const controls = new RuntimeControlRepository(db);
  app.disable('x-powered-by');
  app.disable('etag');
  if (process.env.NODE_ENV === 'production') app.set('trust proxy', 'loopback');
  app.use('/api', (_req, res, next) => {
    res.setHeader('Cache-Control', 'no-store');
    next();
  });
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
        'select b.config_version from bots b, api_tokens t, notification_outbox n limit 0',
      );
      res.json({
        status: 'ready',
        executionMode: 'PAPER',
        capabilities: [
          'bot_configuration',
          'durable_commands',
          'paper_reports',
          'incidents',
          'notifications',
        ],
        acceptsNewEntries: false,
      });
    } catch {
      res.status(503).json({ status: 'unavailable' });
    }
  });
  app.use(express.static(resolve('apps/web/dist')));
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
  dashboardRoutes(app, pool, (res) => repo.account(actor(res)), actor);
  app.get('/api/backtest-experiments/:id', async (req, res) => {
    const [experiment] = await db
      .select()
      .from(replayExperiments)
      .where(
        and(
          eq(replayExperiments.id, id(req)),
          eq(replayExperiments.ownerUserId, actor(res).userId),
        ),
      );
    if (!experiment)
      throw new DomainError(
        'EXPERIMENT_NOT_FOUND',
        'Experiment not found',
        404,
      );
    const runs = await db
      .select({
        id: replayRuns.id,
        status: replayRuns.status,
        stage: replayRuns.stage,
        variant: replayRuns.variant,
        windowIndex: replayRuns.windowIndex,
      })
      .from(replayRuns)
      .where(eq(replayRuns.experimentId, experiment.id));
    res.json({
      data: {
        id: experiment.id,
        plan: experiment.plan,
        selectedVariant: experiment.selectedVariant,
        selectionReason: experiment.selectionReason,
        variants: (experiment.variants as { key: string }[]).map((v) => v.key),
        runs,
      },
    });
  });
  app.post('/api/backtest-experiments', async (req, res) =>
    res
      .status(201)
      .json({ data: await createExperiment(db, actor(res), req.body) }),
  );
  app.post('/api/backtest-experiments/:id/runs', async (req, res) => {
    const body = z
      .object({
        variant: z.string().min(1),
        stage: z.enum(['TRAIN', 'TEST', 'HOLDOUT']),
        windowIndex: z.number().int().nonnegative().default(0),
      })
      .strict()
      .parse(req.body);
    res.status(202).json({
      data: await queueValidation(
        db,
        actor(res),
        id(req),
        body.variant,
        body.stage,
        body.windowIndex,
      ),
    });
  });
  app.post('/api/backtest-experiments/:id/selection', async (req, res) => {
    const body = z
      .object({
        variant: z.string().min(1),
        reason: z.string().trim().min(1).max(500),
      })
      .strict()
      .parse(req.body);
    res.json({
      data: await selectVariant(
        db,
        actor(res),
        id(req),
        body.variant,
        body.reason,
      ),
    });
  });
  app.post('/api/backtests', async (req, res) =>
    res
      .status(202)
      .json({ data: await enqueueReplay(db, actor(res), req.body) }),
  );
  app.get('/api/backtests', async (_req, res) =>
    res.json({
      data: await db
        .select({
          id: replayRuns.id,
          status: replayRuns.status,
          checkpoint: replayRuns.checkpoint,
          inputHash: replayRuns.inputHash,
          createdAt: replayRuns.createdAt,
        })
        .from(replayRuns)
        .where(eq(replayRuns.ownerUserId, actor(res).userId))
        .orderBy(desc(replayRuns.createdAt))
        .limit(50),
    }),
  );
  app.get('/api/backtests/:id', async (req, res) => {
    const run = await readReplay(db, actor(res), id(req));
    res.json({
      data: {
        id: run.id,
        status: run.status,
        inputHash: run.inputHash,
        checkpoint: run.checkpoint,
        manifest: (run.input as { manifest: unknown }).manifest,
        report: run.report,
        error: run.error,
        experimentId: run.experimentId,
        stage: run.stage,
        variant: run.variant,
        windowIndex: run.windowIndex,
      },
    });
  });
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
          codeHash: strategyVersions.codeHash,
        })
        .from(strategyVersions)
        .innerJoin(strategies, eq(strategies.id, strategyVersions.strategyId)),
    }),
  );
  app.get('/api/market-data/health', async (_req, res) => {
    const ownBots = await repo.list(actor(res));
    const rows = (await db.select().from(marketCheckpoints)).filter((r) =>
      ownBots.some((b) => r.streamKey === b.canonicalMarketId + ':health'),
    );
    const now = Date.now();
    res.json({
      data: rows
        .filter((r) => r.streamKey.endsWith(':health'))
        .map((row) => {
          const state = row.state as Record<string, unknown>;
          // Projections expire even if a dead runtime cannot update their persisted state.
          const stale = now - row.observedAt > 15000;
          return {
            ...state,
            canEvaluate: !stale && state.canEvaluate === true,
            state: stale ? 'DEGRADED' : state.state,
            reason: stale ? 'Runtime health projection stale' : state.reason,
            projectionObservedAt: row.observedAt,
          };
        }),
    });
  });
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
  for (const [path, kind] of [
    ['start', 'START'],
    ['pause', 'PAUSE'],
    ['resume', 'RESUME'],
    ['stop', 'STOP'],
  ] as const)
    app.post(`/api/bots/:id/${path}`, async (req, res) => {
      const key = z.uuid().parse(req.headers['idempotency-key']);
      const body = z
        .object({ reason: z.string().trim().min(1).max(500) })
        .strict()
        .parse(req.body);
      const command = await controls.enqueue(
        actor(res),
        id(req),
        kind,
        key,
        body.reason,
        res.locals.correlationId,
      );
      res.status(202).json({
        data: command,
        executionBackend: 'PAPER',
        commandProcessed: command.status !== 'PENDING',
      });
    });
  app.get('/api/bots/:id/runtime', async (req, res) => {
    const bot = await repo.get(actor(res), id(req));
    const [commands, trades, events, actions, checkpoint] = await Promise.all([
      db
        .select()
        .from(runtimeCommands)
        .where(eq(runtimeCommands.botId, bot.id))
        .orderBy(desc(runtimeCommands.sequence))
        .limit(20),
      db
        .select()
        .from(tradeLifecycles)
        .where(eq(tradeLifecycles.botId, bot.id))
        .orderBy(desc(tradeLifecycles.createdAt))
        .limit(20),
      db
        .select()
        .from(runtimeEvents)
        .where(eq(runtimeEvents.botId, bot.id))
        .orderBy(desc(runtimeEvents.eventTime))
        .limit(50),
      db
        .select()
        .from(runtimeActions)
        .where(eq(runtimeActions.botId, bot.id))
        .orderBy(desc(runtimeActions.createdAt))
        .limit(50),
      pool.query('SELECT * FROM runtime_checkpoints WHERE bot_id=$1', [bot.id]),
    ]);
    res.json({
      data: {
        actions,
        checkpoint: checkpoint.rows[0] ?? null,
        executionBackend:
          trades.find((t) =>
            ['PENDING_ENTRY', 'OPEN', 'CLOSING', 'UNRESOLVED'].includes(
              t.state,
            ),
          )?.executionBackend ?? 'PAPER',
        operationalStatus: bot.operationalStatus,
        tradingState: bot.tradingState,
        commands,
        trades,
        events,
      },
    });
  });
  app.post('/api/bots/:id/initial-funding', async (req, res) => {
    const body = z
      .object({ reason: z.string().trim().min(1).max(500) })
      .strict()
      .parse(req.body);
    res.json({
      data: await new PaperCapitalRepository(db).fundInitial(
        actor(res),
        id(req),
        body.reason,
        res.locals.correlationId,
      ),
    });
  });
  app.get('/api/account/capital', async (_req, res) => {
    const account = await repo.account(actor(res));
    res.json({
      data: {
        environment: 'PAPER',
        equityBaseline: account.equityBaseline,
        bots: await new PaperCapitalRepository(db).snapshot(account.id),
      },
    });
  });
  app.get('/api/bots/:id/evaluations', async (req, res) => {
    const bot = await repo.get(actor(res), id(req));
    const limit = z.coerce
      .number()
      .int()
      .min(1)
      .max(100)
      .default(20)
      .parse(req.query.limit);
    res.json({
      data: await db
        .select({
          ...getTableColumns(evaluations),
          snapshot: sql<unknown>`${evaluations.snapshot} #- '{context,candles}'`,
        })
        .from(evaluations)
        .where(
          and(
            eq(evaluations.botId, bot.id),
            eq(evaluations.accountId, bot.accountId),
          ),
        )
        .orderBy(desc(evaluations.eventTime))
        .limit(limit),
    });
  });
  app.get('/api/bots/:id/evaluations/:evaluationId', async (req, res) => {
    const bot = await repo.get(actor(res), id(req));
    const evaluationId = z.uuid().parse(req.params.evaluationId);
    const [evaluation] = await db
      .select()
      .from(evaluations)
      .where(
        and(
          eq(evaluations.id, evaluationId),
          eq(evaluations.botId, bot.id),
          eq(evaluations.accountId, bot.accountId),
        ),
      );
    if (!evaluation)
      throw new DomainError(
        'EVALUATION_NOT_FOUND',
        'Evaluation not found',
        404,
      );
    res.json({ data: evaluation });
  });
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
