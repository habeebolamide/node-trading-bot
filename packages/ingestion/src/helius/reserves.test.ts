import { describe, it, expect, vi } from 'vitest';
import { identifyPoolVaults, resolveReservesViaRpc, resolvePoolReserves, type EnhancedTxWithAccounts, type FetchLike } from './reserves.js';

const WSOL = 'So11111111111111111111111111111111111111112';
const MINT = 'TargetMint1111111111111111111111111111111111';
const USER = 'UserWallet11111111111111111111111111111111';

/** A direct single-pool BUY: user sends wSOL, receives target token. Pool vaults move opposite. */
const buyTx: EnhancedTxWithAccounts = {
  feePayer: USER,
  accountData: [
    // user's token account gains the target token (user-owned — skipped as a vault)
    { account: 'userTokenAcct', tokenBalanceChanges: [{ userAccount: USER, tokenAccount: 'userTokenAcct', mint: MINT, rawTokenAmount: { tokenAmount: '1000000', decimals: 6 } }] },
    // pool token vault DRAINS (not user-owned) — this is the target-token vault
    { account: 'poolTokenVault', tokenBalanceChanges: [{ userAccount: 'poolAuthority', tokenAccount: 'poolTokenVault', mint: MINT, rawTokenAmount: { tokenAmount: '-1000000', decimals: 6 } }] },
    // pool wSOL vault FILLS (not user-owned) — the SOL vault
    { account: 'poolSolVault', tokenBalanceChanges: [{ userAccount: 'poolAuthority', tokenAccount: 'poolSolVault', mint: WSOL, rawTokenAmount: { tokenAmount: '100000', decimals: 9 } }] },
  ],
};

describe('identifyPoolVaults (§20 / #6)', () => {
  it('picks the non-user token + wSOL vaults', () => {
    const v = identifyPoolVaults(buyTx, MINT);
    expect(v).not.toBeNull();
    expect(v!.tokenVault).toBe('poolTokenVault');
    expect(v!.solVault).toBe('poolSolVault');
  });
  it('returns null when the swapper is the only account touched (no vaults)', () => {
    const onlyUser: EnhancedTxWithAccounts = { feePayer: USER, accountData: [
      { tokenBalanceChanges: [{ userAccount: USER, tokenAccount: 'u', mint: MINT, rawTokenAmount: { tokenAmount: '1', decimals: 6 } }] },
    ] };
    expect(identifyPoolVaults(onlyUser, MINT)).toBeNull();
  });
  it('returns null when there is no wSOL leg (token↔token swap, out of scope)', () => {
    const noSol: EnhancedTxWithAccounts = { feePayer: USER, accountData: [
      { tokenBalanceChanges: [{ userAccount: 'x', tokenAccount: 'v', mint: MINT, rawTokenAmount: { tokenAmount: '-100', decimals: 6 } }] },
    ] };
    expect(identifyPoolVaults(noSol, MINT)).toBeNull();
  });
});

describe('resolveReservesViaRpc', () => {
  it('reads both vault balances into reserves', async () => {
    const fetchImpl: FetchLike = vi.fn(async (_url, init) => {
      const body = JSON.parse(init.body) as { params: string[] };
      const acct = body.params[0];
      const ui = acct === 'poolTokenVault' ? 5_000_000 : 500; // token reserve vs sol reserve
      return { ok: true, json: async () => ({ result: { value: { uiAmount: ui } } }) };
    });
    const r = await resolveReservesViaRpc({ rpcUrl: 'https://rpc', vaults: { tokenVault: 'poolTokenVault', solVault: 'poolSolVault', targetMint: MINT }, fee: 0.0025, fetchImpl });
    expect(r).toEqual({ xToken: 5_000_000, ySol: 500, fee: 0.0025 });
  });
  it('returns null when a balance read fails', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: false, json: async () => ({}) }));
    const r = await resolveReservesViaRpc({ rpcUrl: 'https://rpc', vaults: { tokenVault: 'a', solVault: 'b', targetMint: MINT }, fee: 0.0025, fetchImpl });
    expect(r).toBeNull();
  });
  it('returns null on zero/negative reserves', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, json: async () => ({ result: { value: { uiAmount: 0 } } }) }));
    const r = await resolveReservesViaRpc({ rpcUrl: 'https://rpc', vaults: { tokenVault: 'a', solVault: 'b', targetMint: MINT }, fee: 0.0025, fetchImpl });
    expect(r).toBeNull();
  });
});

describe('resolvePoolReserves (full seam)', () => {
  it('identify → read → reserves for a clean buy', async () => {
    const fetchImpl: FetchLike = vi.fn(async (_u, init) => {
      const acct = (JSON.parse(init.body) as { params: string[] }).params[0];
      return { ok: true, json: async () => ({ result: { value: { uiAmount: acct === 'poolTokenVault' ? 1_000_000 : 100 } } }) };
    });
    const r = await resolvePoolReserves({ tx: buyTx, targetMint: MINT, rpcUrl: 'https://rpc', fee: 0.0025, fetchImpl });
    expect(r).toEqual({ xToken: 1_000_000, ySol: 100, fee: 0.0025 });
  });
  it('NO reserves (→ NO_FILL upstream) when vaults cannot be identified', async () => {
    const fetchImpl: FetchLike = vi.fn(async () => ({ ok: true, json: async () => ({ result: { value: { uiAmount: 1 } } }) }));
    const r = await resolvePoolReserves({ tx: { feePayer: USER, accountData: [] }, targetMint: MINT, rpcUrl: 'https://rpc', fee: 0.0025, fetchImpl });
    expect(r).toBeNull();
    expect(fetchImpl).not.toHaveBeenCalled(); // short-circuits before any RPC
  });
});
