import { describe, it, expect } from 'vitest';
import { parseHeliusWebhook, parseEnhancedTx, WSOL_MINT, type RawEnhancedTx } from './parse.js';

const WALLET = 'Wa11etAddr1111111111111111111111111111111111';
const TOKEN = 'To0ken1111111111111111111111111111111111111';
const OTHER = 'Other1111111111111111111111111111111111111';
const PT = '2026-09-01T00:00:00.000Z';

const buySwap: RawEnhancedTx = {
  type: 'SWAP',
  feePayer: WALLET,
  signature: 'SIG_BUY',
  slot: 123,
  timestamp: 1_700_000_000,
  tokenTransfers: [
    { toUserAccount: WALLET, mint: TOKEN, tokenAmount: 1000 },
    { fromUserAccount: WALLET, mint: WSOL_MINT, tokenAmount: 2 },
  ],
  nativeTransfers: [{ fromUserAccount: WALLET, amount: 2_000_000_000 }], // 2 SOL
};

describe('parseEnhancedTx', () => {
  it('parses a SOL→token SWAP as a BUY with amounts', () => {
    const n = parseEnhancedTx(buySwap, PT)!;
    expect(n.action).toBe('BUY');
    expect(n.mint).toBe(TOKEN);
    expect(n.tokenAmount).toBe('1000');
    expect(n.amountSol).toBe('2');
    expect(n.signature).toBe('SIG_BUY');
    expect(n.slot).toBe(123);
    expect(n.blockTime.getTime()).toBe(1_700_000_000_000);
    expect(n.wallet).toBe(WALLET);
  });

  it('parses a token→SOL SWAP as a SELL', () => {
    const sell: RawEnhancedTx = {
      type: 'SWAP',
      feePayer: WALLET,
      signature: 'SIG_SELL',
      timestamp: 1_700_000_100,
      tokenTransfers: [{ fromUserAccount: WALLET, mint: TOKEN, tokenAmount: 500 }],
      nativeTransfers: [{ toUserAccount: WALLET, amount: 1_500_000_000 }], // 1.5 SOL
    };
    const n = parseEnhancedTx(sell, PT)!;
    expect(n.action).toBe('SELL');
    expect(n.amountSol).toBe('1.5');
    expect(n.tokenAmount).toBe('500');
  });

  it('ignores routing dust — the largest token leg wins', () => {
    const withDust: RawEnhancedTx = {
      ...buySwap,
      tokenTransfers: [
        { toUserAccount: WALLET, mint: OTHER, tokenAmount: 0.0001 },
        { toUserAccount: WALLET, mint: TOKEN, tokenAmount: 1000 },
        { fromUserAccount: WALLET, mint: WSOL_MINT, tokenAmount: 2 },
      ],
    };
    expect(parseEnhancedTx(withDust, PT)!.mint).toBe(TOKEN);
  });

  it('falls back to the wSOL leg when there are no native transfers', () => {
    const wrapped: RawEnhancedTx = {
      type: 'SWAP',
      feePayer: WALLET,
      signature: 'SIG_W',
      timestamp: 1,
      tokenTransfers: [
        { toUserAccount: WALLET, mint: TOKEN, tokenAmount: 10 },
        { fromUserAccount: WALLET, mint: WSOL_MINT, tokenAmount: 3.25 },
      ],
    };
    expect(parseEnhancedTx(wrapped, PT)!.amountSol).toBe('3.25');
  });

  it('returns null for a non-SWAP type', () => {
    expect(parseEnhancedTx({ type: 'TRANSFER', feePayer: WALLET, signature: 'x' }, PT)).toBeNull();
  });

  it('returns null when no non-wSOL token leg involves the wallet', () => {
    expect(
      parseEnhancedTx(
        { type: 'SWAP', feePayer: WALLET, signature: 'x', tokenTransfers: [{ toUserAccount: 'someone', mint: TOKEN, tokenAmount: 1 }] },
        PT,
      ),
    ).toBeNull();
  });
});

describe('parseHeliusWebhook', () => {
  it('parses an array and drops unparseable entries', () => {
    const out = parseHeliusWebhook([buySwap, { type: 'TRANSFER' }], PT);
    expect(out).toHaveLength(1);
    expect(out[0]!.signature).toBe('SIG_BUY');
  });
  it('returns [] for a non-array payload', () => {
    expect(parseHeliusWebhook({ not: 'an array' }, PT)).toEqual([]);
    expect(parseHeliusWebhook(null, PT)).toEqual([]);
  });
});
