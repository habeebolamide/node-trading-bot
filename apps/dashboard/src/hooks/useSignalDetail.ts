import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface SignalDetail {
  signal: import('./useSignals').SignalRow;
  features: { agentKey: string; agentVersion: number; score: string; confidence: string; features: unknown }[];
  risk: { riskLevel: string; riskFlags: string[] } | null;
  noTrade: { reason: string; detail: string | null; vetoedAt: string } | null;
  judge: { judgeAction: string; detConfidence: string; judgeConfidence: string } | null;
}
export function useSignalDetail(id: string | undefined) {
  return useQuery({
    enabled: !!id, queryKey: ['signal', id],
    queryFn: () => apiGet<SignalDetail>(`/signals/${id!}`),
  });
}
