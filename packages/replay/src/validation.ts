import { z } from 'zod';
import { and, eq } from 'drizzle-orm';
import {
  replayExperiments,
  replayRuns,
  type Database,
} from '../../database/src/index.js';
import type { Actor } from '../../database/src/bots.js';
import { DomainError } from '../../core/src/index.js';
import { enqueueReplay, implementationHash } from './runner.js';
import { parseInput, digest, type ReplayInput } from './contracts.js';
import { walkForward, windowInput, type Window } from './experiments.js';
const window = z
  .object({
    start: z.number().int().nonnegative(),
    end: z.number().int().nonnegative(),
  })
  .strict();
const schema = z
  .object({
    plan: z
      .object({
        training: window,
        tests: z.array(window).min(1).max(20),
        holdout: window,
      })
      .strict(),
    variants: z
      .array(
        z
          .object({
            key: z.string().regex(/^[a-zA-Z0-9_-]{1,50}$/),
            input: z.unknown(),
          })
          .strict(),
      )
      .min(2)
      .max(10),
  })
  .strict();
export async function createExperiment(
  db: Database,
  actor: Actor,
  raw: unknown,
) {
  if (actor.role !== 'OWNER')
    throw new DomainError('FORBIDDEN', 'Owner permission required', 403);
  const value = schema.parse(raw),
    plan = walkForward(value.plan),
    variants = value.variants.map((v) => ({
      key: v.key,
      input: parseInput(v.input),
    }));
  if (new Set(variants.map((v) => v.key)).size !== variants.length)
    throw Error('Duplicate variant');
  const first = variants[0]!.input;
  if (
    variants.some(
      (v) =>
        digest(v.input.dataset) !== digest(first.dataset) ||
        v.input.seed !== first.seed ||
        v.input.equityBaseline !== first.equityBaseline,
    )
  )
    throw Error('A/B data, seed and baseline must match');
  const [experiment] = await db
    .insert(replayExperiments)
    .values({
      ownerUserId: actor.userId,
      plan: { ...plan, engine: implementationHash() },
      variants,
    })
    .returning();
  return experiment!;
}
export async function queueValidation(
  db: Database,
  actor: Actor,
  id: string,
  variant: string,
  stage: 'TRAIN' | 'TEST' | 'HOLDOUT',
  index = 0,
) {
  if (actor.role !== 'OWNER')
    throw new DomainError('FORBIDDEN', 'Owner permission required', 403);
  return db.transaction(async (tx) => {
    const [experiment] = await tx
      .select()
      .from(replayExperiments)
      .where(
        and(
          eq(replayExperiments.id, id),
          eq(replayExperiments.ownerUserId, actor.userId),
        ),
      )
      .for('update');
    if (!experiment)
      throw new DomainError(
        'EXPERIMENT_NOT_FOUND',
        'Experiment not found',
        404,
      );
    const plan = experiment.plan as {
        training: Window;
        tests: Window[];
        holdout: Window;
        engine: string;
      },
      variants = experiment.variants as { key: string; input: ReplayInput }[];
    if (plan.engine !== implementationHash())
      throw Error('Validation implementation changed');
    const chosen = variants.find((v) => v.key === variant);
    if (!chosen) throw Error('Unknown variant');
    if (stage === 'HOLDOUT' && experiment.selectedVariant !== variant)
      throw new DomainError(
        'HOLDOUT_LOCKED',
        'Select a variant after all training/test reports before touching holdout',
        409,
      );
    if (experiment.selectedVariant && stage !== 'HOLDOUT')
      throw new DomainError(
        'SELECTION_FROZEN',
        'Training/test selection is frozen',
        409,
      );
    const target =
      stage === 'TRAIN'
        ? plan.training
        : stage === 'TEST'
          ? plan.tests[index]
          : plan.holdout;
    if (!target || ((stage === 'TRAIN' || stage === 'HOLDOUT') && index !== 0))
      throw Error('Invalid validation window');
    const [old] = await tx
      .select()
      .from(replayRuns)
      .where(
        and(
          eq(replayRuns.experimentId, id),
          eq(replayRuns.stage, stage),
          eq(replayRuns.variant, variant),
          eq(replayRuns.windowIndex, index),
        ),
      );
    if (old) return old;
    return enqueueReplay(tx, actor, windowInput(chosen.input, target), {
      experimentId: id,
      stage,
      variant,
      windowIndex: index,
    });
  });
}
export async function selectVariant(
  db: Database,
  actor: Actor,
  id: string,
  variant: string,
  reason: string,
) {
  if (actor.role !== 'OWNER')
    throw new DomainError('FORBIDDEN', 'Owner permission required', 403);
  return db.transaction(async (tx) => {
    const [experiment] = await tx
      .select()
      .from(replayExperiments)
      .where(
        and(
          eq(replayExperiments.id, id),
          eq(replayExperiments.ownerUserId, actor.userId),
        ),
      )
      .for('update');
    if (!experiment)
      throw new DomainError(
        'EXPERIMENT_NOT_FOUND',
        'Experiment not found',
        404,
      );
    if (experiment.selectedVariant)
      throw new DomainError(
        'SELECTION_FROZEN',
        'A selected holdout variant cannot be replaced',
        409,
      );
    const variants = experiment.variants as { key: string }[],
      plan = experiment.plan as { tests: Window[] };
    if (!variants.some((v) => v.key === variant) || !reason.trim())
      throw Error('Selection and reason required');
    const runs = await tx
      .select()
      .from(replayRuns)
      .where(eq(replayRuns.experimentId, id));
    for (const v of variants) {
      for (const [stage, count] of [
        ['TRAIN', 1],
        ['TEST', plan.tests.length],
      ] as const)
        for (let n = 0; n < count; n++)
          if (
            !runs.some(
              (r) =>
                r.stage === stage &&
                r.variant === v.key &&
                r.windowIndex === n &&
                r.status === 'COMPLETED',
            )
          )
            throw new DomainError(
              'VALIDATION_INCOMPLETE',
              'Complete every training/test window and resolve uncertainty before selection',
              409,
            );
    }
    const [selected] = await tx
      .update(replayExperiments)
      .set({ selectedVariant: variant, selectionReason: reason })
      .where(eq(replayExperiments.id, id))
      .returning();
    return selected!;
  });
}
