/**
 * Pool-reserves resolution for depth-aware memecoin fills (§20, Part II §7 — audit #6).
 *
 * §20 makes depth-aware fills a HARD provider requirement: a flat/last-price fill "will
 * manufacture returns that don't survive contact with a real order book." The AMM math already
 * lives in @tip/paper-engine (`memecoinBuyFill` / `memecoinSellFill`); it needs `{ xToken, ySol }`
 * reserves AT DETECTION TIME. This module resolves those.
 *
 * TWO PARTS, split by how testable each is:
 *   1. `resolveReservesViaRpc` — reads the two pool vault balances via Solana JSON-RPC
 *      (`getTokenAccountBalance`). Fully testable with an injected fetch. The Helius free-tier
 *      key includes an RPC endpoint (`https://mainnet.helius-rpc.com/?api-key=<key>`), so this
 *      needs no extra provider decision.
 *   2. `identifyPoolVaults` — a heuristic that picks the token + SOL vault accounts out of a
 *      swap's `accountData`. This is AMM-layout-dependent and MUST be validated against real
 *      Helius `accountData` samples before going live — it's behind the resolver seam so the
 *      fill path stays honest (no vaults identified → no reserves → NO_FILL, rule 25).
 */

const WSOL_MINT = 'So11111111111111111111111111111111111111112';

export interface PoolReserves { xToken: number; ySol: number; fee: number }

/** Minimal fetch shape — injected so the RPC reader is testable without network. */
export type FetchLike = (url: string, init: { method: string; headers: Record<string, string>; body: string }) => Promise<{ ok: boolean; json: () => Promise<unknown> }>;

interface TokenBalanceChange {
  userAccount?: string;
  tokenAccount?: string;
  mint?: string;
  rawTokenAmount?: { tokenAmount?: string; decimals?: number };
}
interface AccountDatum {
  account?: string;
  nativeBalanceChange?: number;
  tokenBalanceChanges?: TokenBalanceChange[];
}
export interface EnhancedTxWithAccounts {
  feePayer?: string;
  accountData?: AccountDatum[];
}

export interface IdentifiedVaults {
  tokenVault: string;   // the pool's target-token vault account
  solVault: string;     // the pool's wSOL vault account
  targetMint: string;
}

/**
 * Heuristic vault identification. In a SWAP, the POOL's vaults move OPPOSITE to the user: buying
 * the target token drains the pool's token vault and fills its SOL vault. The vaults are the
 * token accounts NOT owned by the swapping wallet with the largest absolute balance changes for
 * (a) the target mint and (b) wSOL.
 *
 * DOCUMENTED LIMITATION: real AMMs (Raydium/Orca/Pump.fun) lay accounts out differently, and a
 * routed swap can touch several pools. This picks the single largest non-user change per side,
 * which is correct for a direct single-pool swap but NOT validated against routed swaps. Returns
 * null when it can't confidently identify both vaults — the caller then NO_FILLs (rule 25).
 */
export function identifyPoolVaults(tx: EnhancedTxWithAccounts, targetMint: string): IdentifiedVaults | null {
  const user = tx.feePayer;
  if (!user || !tx.accountData) return null;
  let tokenVault: { acct: string; mag: number } | null = null;
  let solVault: { acct: string; mag: number } | null = null;

  for (const ad of tx.accountData) {
    for (const bc of ad.tokenBalanceChanges ?? []) {
      if (!bc.tokenAccount || !bc.mint) continue;
      if (bc.userAccount === user) continue; // skip the swapper's own accounts — vaults aren't user-owned
      const mag = Math.abs(Number(bc.rawTokenAmount?.tokenAmount ?? 0));
      if (mag === 0) continue;
      if (bc.mint === targetMint && (!tokenVault || mag > tokenVault.mag)) tokenVault = { acct: bc.tokenAccount, mag };
      if (bc.mint === WSOL_MINT && (!solVault || mag > solVault.mag)) solVault = { acct: bc.tokenAccount, mag };
    }
  }
  if (!tokenVault || !solVault) return null;
  return { tokenVault: tokenVault.acct, solVault: solVault.acct, targetMint };
}

/**
 * Read absolute reserves from the two vault accounts via Solana `getTokenAccountBalance`. Returns
 * null on any RPC error or missing balance — a null → NO_FILL upstream (rule 25).
 */
export async function resolveReservesViaRpc(input: {
  rpcUrl: string; vaults: IdentifiedVaults; fee: number; fetchImpl: FetchLike; tokenDecimals?: number;
}): Promise<PoolReserves | null> {
  const readBalance = async (account: string): Promise<number | null> => {
    try {
      const res = await input.fetchImpl(input.rpcUrl, {
        method: 'POST', headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'getTokenAccountBalance', params: [account] }),
      });
      if (!res.ok) return null;
      const body = (await res.json()) as { result?: { value?: { uiAmount?: number } } };
      const ui = body.result?.value?.uiAmount;
      return typeof ui === 'number' ? ui : null;
    } catch { return null; }
  };
  const [xToken, ySol] = await Promise.all([readBalance(input.vaults.tokenVault), readBalance(input.vaults.solVault)]);
  if (xToken === null || ySol === null || xToken <= 0 || ySol <= 0) return null;
  return { xToken, ySol, fee: input.fee };
}

/**
 * Full resolver seam the paper engine calls: identify vaults → read reserves. Returns null
 * (→ NO_FILL) whenever any step can't complete. `defaultFee` per AMM (Raydium 0.0025,
 * Pump.fun 0.01) — config, not hardcoded at the call site.
 */
export async function resolvePoolReserves(input: {
  tx: EnhancedTxWithAccounts; targetMint: string; rpcUrl: string; fee: number; fetchImpl: FetchLike;
}): Promise<PoolReserves | null> {
  const vaults = identifyPoolVaults(input.tx, input.targetMint);
  if (!vaults) return null;
  return resolveReservesViaRpc({ rpcUrl: input.rpcUrl, vaults, fee: input.fee, fetchImpl: input.fetchImpl });
}
