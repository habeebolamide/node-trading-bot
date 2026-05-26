// ─────────────────────────────────────────────
// Challenge mode types
// See guides/CHALLENGE_MODE.md for the user-facing spec.
// ─────────────────────────────────────────────

export type ChallengeStatus =
  | 'pending'    // user-created draft awaiting toggle-on
  | 'active'
  | 'passed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type ChallengeExecutionMode = 'paper' | 'live';

// Reason codes emitted by startChallenge() pre-flight checks when a session
// cannot be created. The reconciler flips challengeMode back to false and
// fires sendChallengeStartFailed(code, detail) on any rejection.
export type ChallengeStartFailureReason =
  | 'NO_PENDING_SESSION'   // toggle flipped on but no pending session row exists
  | 'BELOW_MIN_START'
  | 'INSUFFICIENT_FUNDS'
  | 'BUCKET_TOO_SMALL_FOR_LEVERAGE'
  | 'INVALID_TARGET'
  | 'TARGET_EXCEEDS_MAX_MULTIPLIER'
  | 'INVALID_DURATION'
  | 'SESSION_ALREADY_ACTIVE'
  | 'AGENT_HAS_OPEN_TRADE';

// ─────────────────────────────────────────────
// Session record — mirrors the ChallengeSession Prisma row.
// Use Prisma's generated types where possible; this is for hand-shaped
// passing between modules when we don't want to import Prisma client types.
// ─────────────────────────────────────────────

export interface ChallengeSessionRecord {
  id:               string;
  agentId:          string;
  startingCapital:  number;
  targetCapital:    number;
  durationDays:     number;
  maxDrawdownPct:   number;
  riskPercent:      number;
  leverage:         number;
  minNotionalFloor: number;
  startsAt:         Date | null;   // null until activated
  endsAt:           Date | null;   // null until activated
  executionMode:    ChallengeExecutionMode;
  status:           ChallengeStatus;
  endedAt:          Date | null;
  finalEquity:      number | null;
  finalReturnPct:   number | null;
  failReason:       string | null;
  result:           unknown | null;
  createdAt:        Date;
  updatedAt:        Date;
}

// ─────────────────────────────────────────────
// Per-tick portfolio view scoped to one challenge bucket.
// Mirrors Portfolio but with no reserve carve-out — every dollar in the
// bucket is deployable. totalValue == challengeEquity at this snapshot.
// ─────────────────────────────────────────────

export interface ChallengePortfolio {
  sessionId:       string;
  totalValue:      number;   // bucket equity = startingCapital + realised + unrealised
  availableValue:  number;   // not currently in an open trade
  allocatedValue:  number;   // notional locked in the open challenge trade
  reserveValue:    number;   // always 0 for challenges
  startingCapital: number;
  realisedPnL:     number;
  unrealisedPnL:   number;
  lastUpdatedAt:   Date;
}

// ─────────────────────────────────────────────
// Risk context passed into validateEntrySignal + calculatePositionSize
// when an agent is operating inside a challenge session. Swaps the global
// drawdown / allocation math for bucket-scoped equivalents.
// ─────────────────────────────────────────────

export interface ChallengeRiskContext {
  sessionId:        string;
  equity:           number;   // current bucket equity (realised + unrealised)
  startingCapital:  number;
  targetCapital:    number;
  leverage:         number;
  riskPercent:      number;   // % of equity to risk per trade
  maxDrawdownPct:   number;
  minNotionalFloor: number;
  endsAt:           Date;
  // Used by buildChallengeDrawdownState() to scope mode resolution to the
  // bucket only — never globally.
  realisedPnLPct:   number;   // (realised in bucket) / startingCapital
  drawdownPct:      number;   // shortfall from startingCapital, 0..1
}

// ─────────────────────────────────────────────
// What buildChallengeRiskContext returns for downstream consumers.
// The session record is bundled so callers don't refetch.
// ─────────────────────────────────────────────

export interface ChallengeContextBundle {
  session:  ChallengeSessionRecord;
  context:  ChallengeRiskContext;
}

// ─────────────────────────────────────────────
// Pre-flight result. On reject the reconciler flips challengeMode=false
// and notifies; on accept the session row is created.
// ─────────────────────────────────────────────

export type StartChallengeResult =
  | { ok: true;  session: ChallengeSessionRecord }
  | { ok: false; reason: ChallengeStartFailureReason; detail: string };

// ─────────────────────────────────────────────
// Evaluation outcome — what evaluateChallenge decided this tick.
// 'open' means session keeps running; the four terminals trigger endChallenge.
// ─────────────────────────────────────────────

export type ChallengeEvaluation =
  | { terminal: false }
  | { terminal: true;  status: 'passed';  reason: string }
  | { terminal: true;  status: 'failed';  reason: string; forceClose: boolean }
  | { terminal: true;  status: 'expired'; reason: string };
