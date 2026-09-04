import { describe, it, expect } from 'vitest';
import { diffWatchlist, type Watchlist } from './watchlist.js';

describe('diffWatchlist', () => {
  const empty: Watchlist = { perp: [], memecoinActive: false };

  it('empty → empty is a no-op', () => {
    const d = diffWatchlist(empty, empty);
    expect(d.perpAdded).toEqual([]);
    expect(d.perpRemoved).toEqual([]);
    expect(d.memecoinChanged).toBe(false);
  });

  it('empty → [BTC,ETH] flags both as added', () => {
    const d = diffWatchlist(empty, { perp: ['BTCUSDT', 'ETHUSDT'], memecoinActive: false });
    expect(d.perpAdded).toEqual(['BTCUSDT', 'ETHUSDT']);
    expect(d.perpRemoved).toEqual([]);
  });

  it('[BTC,ETH] → [BTC,SOL] adds SOL, removes ETH', () => {
    const d = diffWatchlist(
      { perp: ['BTCUSDT', 'ETHUSDT'], memecoinActive: false },
      { perp: ['BTCUSDT', 'SOLUSDT'], memecoinActive: false },
    );
    expect(d.perpAdded).toEqual(['SOLUSDT']);
    expect(d.perpRemoved).toEqual(['ETHUSDT']);
  });

  it('identical set is no-op regardless of order', () => {
    const d = diffWatchlist(
      { perp: ['BTCUSDT', 'ETHUSDT'], memecoinActive: false },
      { perp: ['ETHUSDT', 'BTCUSDT'], memecoinActive: false },
    );
    expect(d.perpAdded).toEqual([]);
    expect(d.perpRemoved).toEqual([]);
  });

  it('memecoinActive flip is signalled', () => {
    expect(diffWatchlist(empty, { perp: [], memecoinActive: true }).memecoinChanged).toBe(true);
    expect(diffWatchlist({ perp: [], memecoinActive: true }, { perp: [], memecoinActive: true }).memecoinChanged).toBe(false);
  });
});
