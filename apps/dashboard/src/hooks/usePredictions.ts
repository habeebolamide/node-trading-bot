import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface PredictionRow {
  id: string; tradingAgentId: string; agentName: string; signalId: string;
  domain: string; symbol: string; direction: string;
  score: string; confidence: string; horizon: string;
  entry: string; stopLoss: string; takeProfit: string | null;
  positionSize: string; notional: string;
  leverage: string | null; requiredMargin: string | null;
  riskReward: string; thesis: string | null;
  isShadow: boolean; shadowOf: string | null;
  configVersion: number; createdAt: string;
  // Position outcome (LIVE path — the entry orchestrator opened a paper position).
  positionState: 'OPEN' | 'CLOSED' | 'PENDING_ENTRY' | 'EXPIRED' | null;
  closeReason: 'STOP_LOSS' | 'TAKE_PROFIT' | 'HORIZON_EXPIRY' | 'WALLET_EXIT' | 'LIMIT_EXPIRY' | null;
  closedAt: string | null;
  realizedPnl: string | null;
  // Seeded-outcome fallback (SEEDED path — prediction_outcome only, no position).
  outcomeWon: boolean | null;
  outcomeReturnPct: string | null;
  outcomeHitTarget: boolean | null;
  outcomeResolution: 'TICK' | 'CANDLE_1M_CONSERVATIVE' | null;
  outcomeResolvedAt: string | null;
}

export interface PaperPositionRow {
  id: string; portfolioId: string; predictionId: string;
  symbol: string; domain: string; direction: string; state: string;
  entryPrice: string; size: string; remainingSize: string;
  currentStop: string; takeProfit: string | null;
  openedAtEvent: string; openedAtProcessing: string;
  closedAt: string | null; closeReason: string | null;
  realizedPnl: string; mfe: string; mae: string;
  isShadow: boolean;
}

export interface PredictionsListResponse {
  rows: PredictionRow[];
  total: number;
  limit: number;
  offset: number;
}

export function usePredictions(params: { agentId?: string; domain?: string; limit?: number; offset?: number }) {
  return useQuery({
    queryKey: ['predictions', params],
    queryFn: () => apiGet<PredictionsListResponse>('/predictions', params as Record<string, string | number | undefined>),
    placeholderData: (prev) => prev, // keep previous page visible while the next loads
  });
}
export function usePrediction(id: string | undefined) {
  return useQuery({
    enabled: !!id, queryKey: ['prediction', id],
    queryFn: () => apiGet<{ prediction: PredictionRow; outcomes: unknown[]; position: PaperPositionRow | null }>(`/predictions/${id!}`),
  });
}
