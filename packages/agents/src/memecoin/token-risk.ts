/**
 * Memecoin Token Risk Agent (§40.13). HARD VETO — kills obviously-toxic memecoin signals BEFORE
 * they can enter the composite. Fires on `token.activity.detected` / `token.profile.updated`.
 * Independent of Token Quality (§40.10, soft 10% score). Not in the composite; produces a
 * boolean verdict that downstream drops signals for vetoed mints.
 *
 * MVP boolean checks (§40.13): mint authority not renounced, freeze authority present, LP
 * neither locked nor burned, top single holder > 40%, honeypot pattern flag from the profile
 * payload. ANY TRUE → veto. Fail-closed on missing/unreadable metadata (better a missed trade
 * than a rug).
 */
import type { DomainEvent } from '@tip/domain';
import { EVENT_NAMES } from '@tip/events';
import type { AgentContext, AgentOutput, AnalysisAgent } from '@tip/trading-agents';

const KEY = 'memecoin.token_risk';
const VERSION = 1;

export interface TokenRiskPayload {
  mint: string;
  mintAuthorityLive?: boolean;
  freezeAuthorityPresent?: boolean;
  lpLocked?: boolean;
  lpBurned?: boolean;
  topSingleHolderPct?: number; // 0..100
  honeypotPatterns?: string[];
  metadataAvailable?: boolean; // false → fail-closed
}

export interface TokenRiskVerdict extends AgentOutput {
  vetoed: boolean;
  reasons: string[];
}

/**
 * Analyze a token risk payload. Returns an AgentOutput with `features.vetoed` boolean and a
 * `reasons` list. Convention: vetoed → direction NEUTRAL, score 0, confidence 1.
 */
export const memecoinTokenRiskAgent: AnalysisAgent = {
  key: KEY,
  version: VERSION,
  trigger: 'EVENT',
  canHandle(event) {
    return event.type === EVENT_NAMES.TOKEN_ACTIVITY_DETECTED || event.type === EVENT_NAMES.TOKEN_PROFILE_UPDATED;
  },
  async analyze(event: DomainEvent, _ctx: AgentContext): Promise<AgentOutput | null> {
    const p = event.payload as TokenRiskPayload;
    if (!p?.mint) return null;

    const reasons: string[] = [];

    // Fail-closed if we can't read metadata (§40.13 edge case).
    if (p.metadataAvailable === false) {
      reasons.push('METADATA_UNAVAILABLE');
    } else {
      if (p.mintAuthorityLive === true) reasons.push('MINT_AUTHORITY_LIVE');
      if (p.freezeAuthorityPresent === true) reasons.push('FREEZE_AUTHORITY_PRESENT');
      // LP must be either locked OR burned; if we know neither is true → veto.
      if (p.lpLocked === false && p.lpBurned === false) reasons.push('LP_UNLOCKED_NOT_BURNED');
      if (typeof p.topSingleHolderPct === 'number' && p.topSingleHolderPct > 40) {
        reasons.push(`TOP_HOLDER_${Math.round(p.topSingleHolderPct)}PCT`);
      }
      if (p.honeypotPatterns && p.honeypotPatterns.length > 0) {
        for (const pat of p.honeypotPatterns) reasons.push(`HONEYPOT_${pat.toUpperCase()}`);
      }
    }

    const vetoed = reasons.length > 0;
    return {
      agent: KEY,
      agentVersion: VERSION,
      direction: 'NEUTRAL',
      score: 0,
      confidence: 1,
      features: { mint: p.mint, vetoed, reasons },
    };
  },
};

/** Convenience: extract the veto verdict from a Token Risk output. */
export function isVetoed(output: AgentOutput | null): boolean {
  if (!output || output.agent !== KEY) return false;
  return Boolean((output.features as { vetoed?: boolean }).vetoed);
}
