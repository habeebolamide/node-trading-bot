import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface PredictionRow {
  id: string; tradingAgentId: string; signalId: string;
  domain: string; symbol: string; direction: string;
  score: string; confidence: string; horizon: string;
  entry: string; stopLoss: string; takeProfit: string | null;
  positionSize: string; notional: string;
  leverage: string | null; requiredMargin: string | null;
  riskReward: string; thesis: string | null;
  isShadow: boolean; shadowOf: string | null;
  configVersion: number; createdAt: string;
}

export function usePredictions(params: { agentId?: string; domain?: string; limit?: number }) {
  return useQuery({
    queryKey: ['predictions', params],
    queryFn: () => apiGet<{ rows: PredictionRow[]; total: number }>('/predictions', params),
  });
}
export function usePrediction(id: string | undefined) {
  return useQuery({
    enabled: !!id, queryKey: ['prediction', id],
    queryFn: () => apiGet<{ prediction: PredictionRow; outcomes: unknown[] }>(`/predictions/${id!}`),
  });
}
