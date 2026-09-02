/**
 * The Brain facade (§15) — one instance PER DOMAIN, not per TradingAgent.
 *
 * §15 resolved this: "wallet score, token score, and setup-outcome history are facts about the
 * market, not opinions belonging to any one agent. Re-deriving them per agent would be wasteful
 * and would let two agents disagree about a fact, which shouldn't be possible." What IS
 * per-agent is config + that agent's own outcome history, which lives in `@tip/trading-agents`.
 *
 * EVERY method takes `asOf`. That uniformity is the structural enforcement of rule 21, not a
 * convention: there is no overload without it, so replay code cannot accidentally reach a live
 * variant. This is the same discipline `@tip/evaluation`'s `AsOfMarketData` applies to candles —
 * "the backtest data-access layer must not expose a 'current score' method that could be called
 * by mistake — enforce this structurally, not by convention."
 *
 * This object is what M7 hands the Judge as its evidence source.
 */
import type { Db } from '@tip/database';
import { ValidationError } from '@tip/domain';
import type { Domain, FeatureTuple } from './fingerprint.js';
import { historicalEdge, type HistoricalEdge } from './historical-edge.js';
import { marketMemory, type MarketMemory } from './market-memory.js';
import { tokenMemoryAsOf, type TokenMemory } from './token-memory.js';
import { walletMemoryAsOf, type WalletMemory } from './wallet-memory.js';

export interface Brain {
  readonly domain: Domain;
  /** Memecoin only — throws on a perp Brain. */
  wallet(walletId: string, asOf: Date): Promise<WalletMemory>;
  /** Memecoin only — throws on a perp Brain. */
  token(mint: string, asOf: Date): Promise<TokenMemory | null>;
  setup(features: FeatureTuple, asOf: Date): Promise<HistoricalEdge>;
  market(asOf: Date): Promise<MarketMemory>;
}

export function createBrain(db: Db, domain: Domain): Brain {
  /**
   * A perp code path asking for wallet or token memory is a BUG, not an empty result. Returning
   * null would let the mistake propagate silently into a composite; throwing surfaces it at the
   * call site where it can be fixed.
   */
  const memecoinOnly = (method: string): void => {
    if (domain !== 'memecoin') {
      throw new ValidationError(
        `Brain.${method}() is memecoin-only — the perp domain has no ${method} memory (Part III §6)`,
      );
    }
  };

  return {
    domain,
    async wallet(walletId, asOf) {
      memecoinOnly('wallet');
      return walletMemoryAsOf(db, walletId, asOf);
    },
    async token(mint, asOf) {
      memecoinOnly('token');
      return tokenMemoryAsOf(db, mint, asOf);
    },
    async setup(features, asOf) {
      return historicalEdge(db, domain, features, asOf);
    },
    async market(asOf) {
      return marketMemory(db, domain, asOf);
    },
  };
}

/**
 * Compile-time enforcement of rule 21 for the facade.
 *
 * CLAUDE.md: "The backtest data-access layer must not expose a 'current score' method that could
 * be called by mistake — enforce this structurally, not by convention." A doc comment saying
 * "always pass asOf" is convention. This is structure: if any Brain read is ever changed to make
 * `asOf` optional or to drop it, the assignment below stops compiling and `npm run typecheck`
 * fails. A reviewer cannot miss it.
 */
type EndsWithRequiredDate<T> = T extends (...args: infer A) => unknown
  ? A extends [...unknown[], Date]
    ? true
    : false
  : false;

interface AsOfGuard {
  wallet: EndsWithRequiredDate<Brain['wallet']>;
  token: EndsWithRequiredDate<Brain['token']>;
  setup: EndsWithRequiredDate<Brain['setup']>;
  market: EndsWithRequiredDate<Brain['market']>;
}

const ASOF_GUARD: AsOfGuard = { wallet: true, token: true, setup: true, market: true };

/** Always true — reading it is what keeps the guard above from being tree-shaken as unused. */
export const BRAIN_ASOF_ENFORCED =
  ASOF_GUARD.wallet && ASOF_GUARD.token && ASOF_GUARD.setup && ASOF_GUARD.market;
