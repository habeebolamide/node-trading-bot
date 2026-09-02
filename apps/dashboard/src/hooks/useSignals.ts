import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface SignalRow {
  id: string; tradingAgentId: string; symbol: string; domain: string;
  direction: string; compositeScore: string; confidence: string;
  state: string; createdAt: string; expiresAt: string; configVersion: number;
  fingerprint: string;
}
export function useSignals(params: { agentId?: string; state?: string; domain?: string; limit?: number }) {
  return useQuery({
    queryKey: ['signals', params],
    queryFn: () => apiGet<{ rows: SignalRow[] }>('/signals', params),
  });
}
