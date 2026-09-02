import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface AttributionResp {
  predictionId: string;
  features: { agentKey: string; agentVersion: number; score: string; confidence: string; features: unknown }[];
  risk: { riskLevel: string; riskFlags: string[]; evaluatedAt: string } | null;
  judge: {
    signalId: string; judgeVersion: number; judgeAction: string;
    detConfidence: string; judgeConfidence: string;
    detDirection: string; judgeDirection: string;
    gap: string; flipRefusedByPlanner: boolean; createdAt: string;
  } | null;
}
export function usePredictionAttribution(id: string | undefined) {
  return useQuery({
    enabled: !!id, queryKey: ['prediction.attribution', id],
    queryFn: () => apiGet<AttributionResp>(`/predictions/${id!}/attribution`),
  });
}

export function usePredictionAutopsy(id: string | undefined) {
  return useQuery({
    enabled: !!id, queryKey: ['prediction.autopsy', id],
    queryFn: () => apiGet<import('./useAutopsies').AutopsyRow>(`/predictions/${id!}/autopsy`).catch(() => null),
  });
}
