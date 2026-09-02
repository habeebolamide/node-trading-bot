import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface PortfolioRow {
  id: string; tradingAgentId: string;
  startingCash: string; cash: string; equity: string; peakEquity: string;
  maxDrawdown: string; realizedPnl: string; createdAt: string; updatedAt: string;
}
export interface PositionRow {
  id: string; portfolioId: string; predictionId: string; symbol: string; domain: string;
  direction: string; state: string; entryPrice: string; size: string; remainingSize: string;
  currentStop: string; takeProfit: string | null; closedAt: string | null; closeReason: string | null;
  realizedPnl: string; mfe: string; mae: string;
  openedAtProcessing: string; openedAtEvent: string;
  isShadow: boolean;
}
export function usePortfolios(agentId?: string) {
  return useQuery({
    queryKey: ['portfolios', agentId],
    queryFn: () => apiGet<{ rows: PortfolioRow[] }>('/portfolios', agentId ? { agentId } : undefined),
  });
}
export function usePositions(portfolioId: string | undefined, state?: string) {
  return useQuery({
    enabled: !!portfolioId,
    queryKey: ['positions', portfolioId, state],
    queryFn: () => apiGet<{ rows: PositionRow[] }>(`/portfolios/${portfolioId!}/positions`, state ? { state } : undefined),
  });
}
