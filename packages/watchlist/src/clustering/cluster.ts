/**
 * Pure funder-clustering (Part II §5 interim heuristic). Given wallets tagged with their first-hop
 * funder + funder timestamp, group wallets that share a funder within a sliding time window
 * (default 48h — middle of §5's stated 24–72h range). Deterministic; no I/O.
 *
 * Only clusters of size ≥ 2 are returned — a singleton isn't a cluster.
 */
import { randomUUID } from 'node:crypto';

export interface FunderTaggedWallet {
  walletId: string;
  funder: string;
  fundedAt: Date;
}

export interface ClusterMember {
  walletId: string;
  fundedAt: Date;
}

export interface Cluster {
  clusterId: string; // uuid, stable within a run
  funder: string;
  members: ClusterMember[];
  firstAt: Date;
  lastAt: Date;
}

export interface ClusterOptions {
  windowHours?: number; // default 48
  /** Optional deterministic id factory — tests can inject to get stable ids. */
  makeId?: () => string;
}

export function cluster(rows: readonly FunderTaggedWallet[], opts: ClusterOptions = {}): Cluster[] {
  const windowMs = (opts.windowHours ?? 48) * 60 * 60 * 1000;
  const makeId = opts.makeId ?? (() => randomUUID());

  // Group by funder.
  const byFunder = new Map<string, FunderTaggedWallet[]>();
  for (const r of rows) {
    if (!byFunder.has(r.funder)) byFunder.set(r.funder, []);
    byFunder.get(r.funder)!.push(r);
  }

  const clusters: Cluster[] = [];
  for (const [funder, group] of byFunder) {
    // Sort funding events chronologically.
    const sorted = [...group].sort((a, b) => a.fundedAt.getTime() - b.fundedAt.getTime());

    // Sliding window: start a new session when the gap from the LAST included row exceeds the window.
    let session: FunderTaggedWallet[] = [];
    const flush = (): void => {
      if (session.length >= 2) {
        // Dedup members by walletId (a wallet appearing twice in the same session is unusual but safe).
        const seen = new Set<string>();
        const members: ClusterMember[] = [];
        for (const s of session) {
          if (seen.has(s.walletId)) continue;
          seen.add(s.walletId);
          members.push({ walletId: s.walletId, fundedAt: s.fundedAt });
        }
        if (members.length >= 2) {
          clusters.push({
            clusterId: makeId(),
            funder,
            members,
            firstAt: members[0]!.fundedAt,
            lastAt: members[members.length - 1]!.fundedAt,
          });
        }
      }
      session = [];
    };

    for (const row of sorted) {
      if (session.length === 0) {
        session.push(row);
        continue;
      }
      const gap = row.fundedAt.getTime() - session[session.length - 1]!.fundedAt.getTime();
      if (gap <= windowMs) session.push(row);
      else {
        flush();
        session.push(row);
      }
    }
    flush();
  }

  return clusters;
}
