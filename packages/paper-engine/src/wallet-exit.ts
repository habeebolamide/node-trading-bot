/**
 * Wallet-exit live wiring (Part II §10 "Partial-exit awareness", Design 1 — audit #11).
 *
 * The accumulator math (`walletExitAccumulator`, exit.ts) existed since M6; this module is the
 * missing feed: the §10 mechanism that turns a live wallet-sell webhook into decremented
 * `current_held_fraction` rows, a logged observation, and — when the normalized accumulator
 * crosses `walletExitThreshold` — a binary full close with `exitReason = WALLET_EXIT`.
 *
 * §10 flow, verbatim shape:
 *   wallet sell webhook (parsed swap, with amount)
 *     → lookup this wallet's originating rows on open positions for that mint
 *     → fraction sold vs the wallet's tracked entry quantity, decrement currentHeldFraction
 *     → recompute cluster_weight_exited = Σ entryWeight × (1 − currentHeldFraction)
 *     → ÷ Σ entryWeight ≥ walletExitThreshold ?  NO → observation only; YES → full close.
 *
 * Design 1 is binary by decision: a partial that does not cross the threshold NEVER trims the
 * position (Design 2/3 explicitly deferred) — it is recorded in `wallet_sell_observation` for
 * the learning loop and nothing else moves.
 *
 * PRICING (§20 detection-lag pricing, rule 25): the close is priced at the wallet's own observed
 * execution price (`amountSol / tokenAmount` from the parsed swap) — an actual traded price at
 * the moment the system could act, never a fabricated last-price.
 *
 * IDEMPOTENCY (§29, rule 12): the unique index on (position, wallet, tx_signature) in
 * `wallet_sell_observation` is the guard. The observation insert happens BEFORE the held-fraction
 * decrement inside one transaction; a redelivered webhook conflicts on the insert and the whole
 * per-position unit is skipped — the fraction can never be decremented twice for one sell.
 *
 * This module stays event-bus-free (rule 19 layering: paper-engine mutates state, the worker
 * publishes). The caller gets rich results and emits `memecoin.wallet.exit.detected` + lifecycle
 * COOLDOWN for entries with `closed: true`.
 */
import { randomUUID } from 'node:crypto';
import { and, eq, inArray } from 'drizzle-orm';
import {
  paperPortfolio, paperPosition, paperPositionOriginatingWallet, scoringConfig,
  walletSellObservation, type Db,
} from '@tip/database';
import { walletExitAccumulator } from './exit.js';
import { closeRemaining, type FillClocks } from './position.js';

/** Placeholder default per Part II §4 — the seed-history analysis pass settles the real value. */
export const DEFAULT_WALLET_EXIT_THRESHOLD = 0.9;

export interface OriginatingWalletInput {
  positionId: string;
  walletId: string;
  clusterId?: string | null;
  entryUsd: number;
  entryWeight: number;
  entryScore?: number | null;
  /** The wallet's entry quantity in token units — from the buy webhook's `tokenAmount`. */
  entryTokenAmount?: number | null;
}

/**
 * Write the per-wallet tracking rows at position open (§10 / §13). The (future) memecoin
 * orchestrator calls this with every wallet that contributed to the entry signal. Idempotent on
 * the (positionId, walletId) PK — re-running an open is a no-op, never a reset to 1.0.
 */
export async function recordOriginatingWallets(db: Db, rows: readonly OriginatingWalletInput[]): Promise<void> {
  if (rows.length === 0) return;
  await db.insert(paperPositionOriginatingWallet).values(rows.map((r) => ({
    positionId: r.positionId,
    walletId: r.walletId,
    clusterId: r.clusterId ?? null,
    entryUsd: String(r.entryUsd),
    entryWeight: String(r.entryWeight),
    entryScore: r.entryScore === null || r.entryScore === undefined ? null : String(r.entryScore),
    entryTokenAmount: r.entryTokenAmount === null || r.entryTokenAmount === undefined ? null : String(r.entryTokenAmount),
  }))).onConflictDoNothing();
}

export interface WalletSellInput {
  wallet: string;
  mint: string;
  /** Idempotency key — the swap's tx signature (§29). */
  signature: string;
  /** UI-adjusted token quantity of the sell (parsed swap). */
  tokenAmount: number;
  /** SOL (quote) leg of the sell — with tokenAmount, the observed execution price. */
  amountSol: number;
  /** On-chain sell time (event clock, §20). */
  blockTime: Date;
  /** When the system could first act (processing clock, §20). */
  processingAt: Date;
}

export interface WalletExitOutcome {
  positionId: string;
  tradingAgentId: string;
  /** Normalized accumulator after this sell: cluster_weight_exited / Σ entryWeight, ∈ [0,1]. */
  accumulator: number;
  threshold: number;
  crossed: boolean;
  /** True when THIS call performed the full close (crossed and the position was still OPEN). */
  closed: boolean;
  closePrice: number | null;
  /** True when the observation already existed — redelivered webhook, nothing changed. */
  duplicate: boolean;
}

/**
 * Process one wallet sell against every open memecoin position where this wallet is an
 * originator. Returns one outcome per affected position (empty when the wallet originates
 * nothing that's open on this mint — the overwhelmingly common case).
 */
export async function processWalletSell(db: Db, input: WalletSellInput): Promise<WalletExitOutcome[]> {
  if (input.tokenAmount <= 0) return []; // unparseable amount — nothing measurable to accumulate

  // Open memecoin positions on this mint where the seller is an originating wallet.
  const targets = await db.select({
    positionId: paperPositionOriginatingWallet.positionId,
    portfolioId: paperPosition.portfolioId,
  })
    .from(paperPositionOriginatingWallet)
    .innerJoin(paperPosition, eq(paperPosition.id, paperPositionOriginatingWallet.positionId))
    .where(and(
      eq(paperPositionOriginatingWallet.walletId, input.wallet),
      eq(paperPosition.symbol, input.mint),
      eq(paperPosition.domain, 'memecoin'),
      eq(paperPosition.state, 'OPEN'),
    ));
  if (targets.length === 0) return [];

  // Portfolio → agent → active config, for walletExitThreshold (versioned read, rule 16).
  const portfolioIds = [...new Set(targets.map((t) => t.portfolioId))];
  const portfolios = await db.select({ id: paperPortfolio.id, tradingAgentId: paperPortfolio.tradingAgentId })
    .from(paperPortfolio).where(inArray(paperPortfolio.id, portfolioIds));
  const agentByPortfolio = new Map(portfolios.map((p) => [p.id, p.tradingAgentId]));

  const outcomes: WalletExitOutcome[] = [];
  for (const t of targets) {
    const tradingAgentId = agentByPortfolio.get(t.portfolioId);
    if (!tradingAgentId) continue; // orphaned portfolio row — nothing safe to do

    const cfgRow = (await db.select({ config: scoringConfig.config })
      .from(scoringConfig)
      .where(and(eq(scoringConfig.tradingAgentId, tradingAgentId), eq(scoringConfig.active, true)))
      .limit(1))[0];
    const threshold = (cfgRow?.config as { walletExitThreshold?: number } | undefined)?.walletExitThreshold
      ?? DEFAULT_WALLET_EXIT_THRESHOLD;

    const outcome = await processOnePosition(db, t.positionId, tradingAgentId, threshold, input);
    if (outcome) outcomes.push(outcome);
  }
  return outcomes;
}

/** One position's full unit of work, transactional. Null when the row vanished mid-flight. */
async function processOnePosition(
  db: Db, positionId: string, tradingAgentId: string, threshold: number, input: WalletSellInput,
): Promise<WalletExitOutcome | null> {
  return db.transaction(async (tx) => {
    // Lock this wallet's originating row — serializes concurrent sells from the same wallet.
    const mine = (await tx.select().from(paperPositionOriginatingWallet)
      .where(and(
        eq(paperPositionOriginatingWallet.positionId, positionId),
        eq(paperPositionOriginatingWallet.walletId, input.wallet),
      )).for('update').limit(1))[0];
    if (!mine) return null;

    const pos = (await tx.select().from(paperPosition).where(eq(paperPosition.id, positionId)).limit(1))[0];
    if (!pos || pos.state !== 'OPEN') return null; // closed while we were queued

    // Fraction of the wallet's ENTRY that this sell represents. Preference order (§10):
    //   1. tracked entry token quantity (exact),
    //   2. entryUsd / position entry price (same-quote conversion),
    //   3. unknown entry size → treat as the wallet's FULL remaining exit. Pessimistic on
    //      purpose (rule 25's spirit): when we can't measure, we assume thesis-death sooner,
    //      not later — the failure mode is an early exit, never a fabricated hold.
    const held = Number(mine.currentHeldFraction);
    const entryTokens = mine.entryTokenAmount !== null ? Number(mine.entryTokenAmount)
      : Number(mine.entryUsd) > 0 && Number(pos.entryPrice) > 0 ? Number(mine.entryUsd) / Number(pos.entryPrice)
      : null;
    const fractionOfEntry = entryTokens !== null && entryTokens > 0
      ? Math.min(held, input.tokenAmount / entryTokens)
      : held;
    const heldAfter = Math.max(0, held - fractionOfEntry);

    // Peer rows (this position's other originators) — needed for the normalized accumulator.
    const peers = await tx.select().from(paperPositionOriginatingWallet)
      .where(eq(paperPositionOriginatingWallet.positionId, positionId));
    const totalWeight = peers.reduce((s, r) => s + Number(r.entryWeight), 0);
    const exitedWeight = walletExitAccumulator(peers.map((r) => ({
      currentHeldFraction: r.walletId === input.wallet ? heldAfter : Number(r.currentHeldFraction),
      entryWeight: Number(r.entryWeight),
    })));
    const accumulator = totalWeight > 0 ? exitedWeight / totalWeight : 0;
    const crossed = accumulator >= threshold;

    // Observation BEFORE the decrement — the unique index is the §29 idempotency gate. A
    // redelivered webhook conflicts here and we bail with nothing mutated.
    const inserted = await tx.insert(walletSellObservation).values({
      id: randomUUID(),
      positionId,
      walletId: input.wallet,
      txSignature: input.signature,
      tokenAmount: String(input.tokenAmount),
      fractionOfEntry: String(fractionOfEntry),
      heldFractionAfter: String(heldAfter),
      accumulatorAfter: String(accumulator),
      crossedThreshold: crossed,
      observedAtEvent: input.blockTime,
      observedAtProcessing: input.processingAt,
    }).onConflictDoNothing().returning({ id: walletSellObservation.id });
    if (inserted.length === 0) {
      return {
        positionId, tradingAgentId, accumulator: 0, threshold,
        crossed: false, closed: false, closePrice: null, duplicate: true,
      };
    }

    await tx.update(paperPositionOriginatingWallet)
      .set({ currentHeldFraction: String(heldAfter) })
      .where(and(
        eq(paperPositionOriginatingWallet.positionId, positionId),
        eq(paperPositionOriginatingWallet.walletId, input.wallet),
      ));

    let closed = false;
    let closePrice: number | null = null;
    if (crossed) {
      // Binary action: close whatever is still held, priced at the wallet's own observed
      // execution price (§20 detection-lag pricing — an actual trade, not a fabrication).
      closePrice = input.amountSol / input.tokenAmount;
      const clocks: FillClocks = { fillAtEvent: input.blockTime, fillAtProcessing: input.processingAt };
      const row = await closeRemaining(tx as unknown as Db, {
        positionId, price: closePrice, reason: 'WALLET_EXIT', clocks,
      });
      closed = row.state === 'CLOSED' && row.closeReason === 'WALLET_EXIT';
    }

    return { positionId, tradingAgentId, accumulator, threshold, crossed, closed, closePrice, duplicate: false };
  });
}
