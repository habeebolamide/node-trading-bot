// ─────────────────────────────────────────────
// Challenge mode types
// ─────────────────────────────────────────────

export type ChallengeStatus =
  | 'active'
  | 'passed'
  | 'failed'
  | 'expired'
  | 'cancelled';

export type ChallengeExecutionMode = 'paper' | 'live';

export interface StartChallengeConfig {
  startingCapital: number;
  targetCapital:   number;
  durationDays:    number;
  executionMode:   ChallengeExecutionMode;
  maxDrawdownPct?: number;
  riskPercent?:    number;
  leverage?:       number;
}

export interface ChallengeSessionRecord {
  id:              string;
  agentId:         string;
  startingCapital: number;
  targetCapital:   number;
  maxDrawdownPct:  number;
  startsAt:        Date;
  endsAt:          Date;
  executionMode:   ChallengeExecutionMode;
  status:          ChallengeStatus;
  endedAt:         Date | null;
  finalEquity:     number | null;
  finalReturnPct:  number | null;
  failReason:      string | null;
  riskPercent:     number | null;
  leverage:        number | null;
}

export interface ChallengePromptContext {
  startingCapital:  number;
  targetCapital:    number;
  currentEquity:    number;
  returnPct:        number;
  progressToTarget: number;
  daysLeft:         number;
  daysTotal:        number;
  executionMode:    ChallengeExecutionMode;
}

export interface ChallengeRiskContext {
  sessionId:        string;
  startingCapital:  number;
  targetCapital:    number;
  maxDrawdownPct:   number;
  endsAt:           Date;
  equity:           number;
  returnPct:        number;
  progressToTarget: number;
  daysLeft:         number;
}
