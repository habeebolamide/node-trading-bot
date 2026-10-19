import type {
  ManagementPolicy,
  EntryDecision,
  StrategyContext,
  PositionAssessment,
} from '../../strategies/src/contracts.js';
import type { Market, PriceEvent } from '../../market-data/src/contracts.js';
export type Operational =
  | 'STOPPED'
  | 'STARTING'
  | 'WARMING_UP'
  | 'RUNNING'
  | 'PAUSED'
  | 'STOP_REQUESTED'
  | 'RECONCILING'
  | 'RISK_SUSPENDED'
  | 'ERROR';
export type Trading =
  'IDLE' | 'PENDING_ENTRY' | 'IN_TRADE' | 'CLOSING' | 'UNRESOLVED';
export type Trade = {
  id: string;
  botId: string;
  accountId: string;
  evaluationId: string;
  state:
    | 'PENDING_ENTRY'
    | 'OPEN'
    | 'CLOSING'
    | 'UNRESOLVED'
    | 'CLOSED'
    | 'CANCELLED'
    | 'EXPIRED';
  side: 'LONG' | 'SHORT';
  orderType: 'MARKET' | 'LIMIT';
  requestedQuantity: string;
  filledQuantity: string;
  closedQuantity: string;
  entryReference: string;
  averageEntry: string | null;
  initialStop: string;
  desiredStop: string;
  submittedStop: string | null;
  confirmedStop: string | null;
  takeProfit: string;
  protectedQuantity: string;
  protectionRevision: number;
  confirmedRevision: number;
  protectionStatus: 'UNCONFIRMED' | 'REQUESTED' | 'CONFIRMED' | 'UNKNOWN';
  entryTerminal: boolean;
  expiresAt: number;
  openedAt: number | null;
  createdAt: number;
  closedAt: number | null;
  closeReason: string | null;
  closeGeneration: number;
  pendingCancelReason: string | null;
  trailingDistance: string | null;
  policy: ManagementPolicy;
  executionBackend: 'FAKE_CONTRACT' | 'PAPER';
};
export type ActionKind =
  'ENTRY' | 'CANCEL_ENTRY' | 'CLOSE' | 'PROTECT' | 'AMEND_STOP';
export type Action = {
  id: string;
  botId: string;
  tradeId: string;
  key: string;
  kind: ActionKind;
  state:
    | 'CREATED'
    | 'SUBMITTING'
    | 'OPEN'
    | 'CONFIRMED'
    | 'FILLED'
    | 'CANCELLED'
    | 'REJECTED'
    | 'UNKNOWN';
  quantity: string;
  price: string | null;
  stopPrice: string | null;
  takeProfit: string | null;
  revision: number;
  reason: string;
  createdAt: number;
};
export type Lease = { botId: string; ownerId: string; token: number };
export type View = {
  botId: string;
  accountId: string;
  market: Market;
  marketKey: string;
  strategyVersionId: string;
  configVersion: number;
  executionMode: 'PAPER' | 'SIGNAL_ONLY';
  operational: Operational;
  trading: Trading;
  desired: 'RUNNING' | 'PAUSED' | 'STOPPED';
  trade: Trade | null;
  actions: Action[];
  lastPriceTime: number;
  lastCandleTime: number;
  lastEvaluationId: string | null;
  fault: string | null;
};
export type Change = {
  view: View;
  actions: Action[];
  kind: string;
  details: Record<string, unknown>;
  commandId?: string;
  commandError?: string;
};
export type CommandKind = 'START' | 'PAUSE' | 'RESUME' | 'STOP';
export type Command = { id: string; kind: CommandKind; requestedAt: number };
export type Report = {
  eventId: string;
  actionId: string;
  tradeId: string;
  botId: string;
  kind:
    | 'ENTRY_OPEN'
    | 'ENTRY_FILL'
    | 'ENTRY_CANCELLED'
    | 'ENTRY_REJECTED'
    | 'CLOSE_OPEN'
    | 'EXIT_FILL'
    | 'STOP_CONFIRMED'
    | 'REJECTED'
    | 'UNKNOWN';
  eventTime: number;
  quantity?: string;
  fee?: string;
  price?: string;
  stopPrice?: string;
  revision?: number;
  terminal?: boolean;
};
export interface ExecutionAdapter {
  readonly backend: 'FAKE_CONTRACT' | 'PAPER';
  onPrice?(event: Price, authorization: Lease): Promise<Report[]>;
  submit(action: Action, authorization: Lease): Promise<Report[]>;
  reconcile(botId: string): Promise<Report[]>;
}
export interface RuntimeRepository {
  acquire(
    botId: string,
    ownerId: string,
    ttlMs?: number,
  ): Promise<Lease | null>;
  renew(lease: Lease, ttlMs?: number): Promise<boolean>;
  release(lease: Lease): Promise<void>;
  load(botId: string): Promise<View>;
  transact(
    lease: Lease,
    key: string,
    eventTime: number,
    reduce: (view: View) => Change,
  ): Promise<View>;
  markSubmitting(
    lease: Lease,
    actionId: string,
    observedAt?: number,
  ): Promise<Action | null>;
}
export type Price = PriceEvent & { late: boolean };
export type EntryProposal = Extract<EntryDecision, { action: 'PROPOSE_ENTRY' }>;
export type PositionInput = {
  context: StrategyContext;
  assessment: PositionAssessment;
};
