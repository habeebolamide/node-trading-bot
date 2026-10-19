import { and, eq, gte, lt, lte, asc, sql } from 'drizzle-orm';
import { Decimal } from 'decimal.js';
import {
  instruments,
  instrumentVersions,
  candles,
  marketGaps,
  marketCheckpoints,
  type Database,
} from './index.js';
import {
  candleSchema,
  durations,
  type Candle,
  type CandleRepository,
  type Instrument,
  type Timeframe,
  type Gap,
} from '../../market-data/src/contracts.js';
const financialFields = ['open', 'high', 'low', 'close', 'volume'] as const;
export class PostgresCandleRepository implements CandleRepository {
  constructor(private db: Database) {}
  async saveInstrument(instrument: Instrument) {
    await this.db.transaction(async (tx) => {
      const [row] = await tx
        .insert(instruments)
        .values({
          canonicalMarketId: instrument.marketKey,
          exchange: instrument.market.exchange,
          marketType: instrument.market.marketType,
          symbol: instrument.symbol,
          baseAsset: instrument.market.baseAsset,
          quoteAsset: instrument.market.quoteAsset,
          specVersion: instrument.specVersion,
          spec: instrument,
          verifiedAt: instrument.verifiedAt,
          expiresAt: instrument.expiresAt,
        })
        .onConflictDoUpdate({
          target: instruments.canonicalMarketId,
          set: {
            specVersion: instrument.specVersion,
            spec: instrument,
            verifiedAt: instrument.verifiedAt,
            expiresAt: instrument.expiresAt,
          },
          setWhere: lte(instruments.verifiedAt, instrument.verifiedAt),
        })
        .returning();
      if (!row) return;
      await tx
        .insert(instrumentVersions)
        .values({
          instrumentId: row.id,
          specVersion: instrument.specVersion,
          spec: instrument,
          observedAt: instrument.verifiedAt,
        })
        .onConflictDoNothing();
    });
  }
  async instrument(key: string) {
    const [row] = await this.db
      .select()
      .from(instruments)
      .where(eq(instruments.canonicalMarketId, key));
    return row?.spec as Instrument | undefined;
  }
  private async instrumentId(key: string) {
    const [row] = await this.db
      .select({ id: instruments.id })
      .from(instruments)
      .where(eq(instruments.canonicalMarketId, key));
    if (!row) throw Error('Instrument not registered');
    return row.id;
  }
  async read(
    key: string,
    timeframe: Timeframe,
    start: number,
    end: number,
    asOf: number,
  ): Promise<Candle[]> {
    const instrumentId = await this.instrumentId(key);
    const rows = await this.db
      .select()
      .from(candles)
      .where(
        and(
          eq(candles.instrumentId, instrumentId),
          eq(candles.timeframe, timeframe),
          gte(candles.openTime, start),
          lt(candles.openTime, end),
          lte(candles.closeTime, asOf),
          lte(candles.availableAt, asOf),
        ),
      )
      .orderBy(asc(candles.openTime));
    return rows.map(({ id, instrumentId, ...c }) =>
      candleSchema.parse({ ...c, marketKey: key }),
    );
  }
  async store(input: Candle[]) {
    if (!input.length) return;
    const validated = input.map((c) => candleSchema.parse(c));
    // One bounded batch per native timeframe; financial values stay decimal strings.
    if (validated.length > 100000) throw Error('Candle batch exceeds bound');
    const first = validated[0]!;
    if (
      validated.some(
        (c) =>
          c.marketKey !== first.marketKey || c.timeframe !== first.timeframe,
      )
    )
      throw Error('Mixed candle series');
    const instrumentId = await this.instrumentId(first.marketKey);
    await this.db.transaction(async (tx) => {
      // Serializes storage/checkpoint writes across processes for this series only.
      const streamKey = `${first.marketKey}:${first.timeframe}`;
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${streamKey},0))`,
      );
      for (let i = 0; i < validated.length; i += 500) {
        const batch = validated.slice(i, i + 500);
        await tx
          .insert(candles)
          .values(batch.map(({ marketKey, ...c }) => ({ ...c, instrumentId })))
          .onConflictDoNothing();
        const from = Math.min(...batch.map((c) => c.openTime)),
          to = Math.max(...batch.map((c) => c.closeTime));
        const existing = await tx
          .select()
          .from(candles)
          .where(
            and(
              eq(candles.instrumentId, instrumentId),
              eq(candles.timeframe, first.timeframe),
              gte(candles.openTime, from),
              lt(candles.openTime, to),
            ),
          );
        const byTime = new Map(existing.map((c) => [c.openTime, c]));
        for (const c of batch) {
          const old = byTime.get(c.openTime);
          if (
            !old ||
            financialFields.some((f) => !new Decimal(old[f]).eq(c[f]))
          )
            throw Error(
              'CANDLE_CORRECTION: immutable closed candle differs from source',
            );
        }
      }
      const latest = validated.reduce((a, b) =>
        b.openTime > a.openTime ? b : a,
      );
      await tx
        .insert(marketCheckpoints)
        .values({
          streamKey,
          instrumentId,
          lastOpenTime: latest.openTime,
          lastEventTime: latest.closeTime,
          observedAt: latest.observedAt,
          state: { kind: 'CANDLE_STORED' },
        })
        .onConflictDoUpdate({
          target: marketCheckpoints.streamKey,
          set: {
            lastOpenTime: latest.openTime,
            lastEventTime: latest.closeTime,
            observedAt: latest.observedAt,
            state: { kind: 'CANDLE_STORED' },
          },
          setWhere: sql`${marketCheckpoints.lastOpenTime} IS NULL OR ${marketCheckpoints.lastOpenTime}<${latest.openTime}`,
        });
    });
  }
  async gaps(
    key: string,
    timeframe: Timeframe,
    start: number,
    end: number,
    missing: Gap[],
    observedAt: number,
  ) {
    const instrumentId = await this.instrumentId(key);
    await this.db.transaction(async (tx) => {
      await tx.execute(
        sql`select pg_advisory_xact_lock(hashtextextended(${`${key}:${timeframe}`},0))`,
      );
      const old = await tx
        .select()
        .from(marketGaps)
        .where(
          and(
            eq(marketGaps.instrumentId, instrumentId),
            eq(marketGaps.stream, timeframe),
            eq(marketGaps.status, 'OPEN'),
            gte(marketGaps.startTime, start),
            lte(marketGaps.endTime, end),
          ),
        );
      for (const gap of old)
        if (
          !missing.some((m) => m.start < gap.endTime && m.end > gap.startTime)
        )
          await tx
            .update(marketGaps)
            .set({
              status: 'RESOLVED',
              resolvedAt: observedAt,
              evidence: { coverageVerified: true, checkedAt: observedAt },
            })
            .where(eq(marketGaps.id, gap.id));
      for (const gap of missing) {
        if (
          old.some(
            (previous) =>
              previous.startTime <= gap.start && previous.endTime >= gap.end,
          )
        )
          continue;
        await tx
          .insert(marketGaps)
          .values({
            instrumentId,
            stream: timeframe,
            startTime: gap.start,
            endTime: gap.end,
            status: 'OPEN',
            observedAt,
            evidence: { kind: 'MISSING_CLOSED_CANDLES' },
          })
          .onConflictDoUpdate({
            target: [
              marketGaps.instrumentId,
              marketGaps.stream,
              marketGaps.startTime,
              marketGaps.endTime,
            ],
            set: {
              status: 'OPEN',
              resolvedAt: null,
              observedAt,
              evidence: { kind: 'MISSING_CLOSED_CANDLES' },
            },
          });
      }
    });
  }
  async interruption(
    key: string,
    start: number,
    end: number,
    observedAt: number,
  ) {
    const instrumentId = await this.instrumentId(key);
    await this.db
      .insert(marketGaps)
      .values({
        instrumentId,
        stream: 'PUBLIC_TRADES',
        startTime: start,
        endTime: Math.max(start + 1, end),
        status: 'UNCERTAIN',
        observedAt,
        evidence: {
          reason:
            'Connection interruption; complete historical trade replay unavailable',
          candleRepairDoesNotProveTickOrdering: true,
        },
      })
      .onConflictDoNothing();
  }
  async checkpoint(key: string) {
    const [row] = await this.db
      .select()
      .from(marketCheckpoints)
      .where(eq(marketCheckpoints.streamKey, key));
    return row as Record<string, unknown> | undefined;
  }
  async health(
    key: string,
    payload: Record<string, unknown>,
    observedAt: number,
  ) {
    const instrumentId = await this.instrumentId(key);
    await this.db
      .insert(marketCheckpoints)
      .values({
        streamKey: `${key}:health`,
        instrumentId,
        observedAt,
        state: payload,
      })
      .onConflictDoUpdate({
        target: marketCheckpoints.streamKey,
        set: { observedAt, state: payload },
        setWhere: lte(marketCheckpoints.observedAt, observedAt),
      });
  }
}
