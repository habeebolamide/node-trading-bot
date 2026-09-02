import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface HistoricalEdge {
  evidence: 'SUFFICIENT' | 'INSUFFICIENT';
  exactOccurrences: number;
  observedWinRate: number | null;
  fallback: string | null;
  fallbackWinRate: number | null;
  backoffDepth: number;
  effectiveN: number;
  ciWidth: number | null;
  medianReturn: number | null;
  score: number;
  historicalEvidence: number;
}
export function useBrainSetup(params: { domain: string; features: string }) {
  return useQuery({
    enabled: !!params.features,
    queryKey: ['brain.setup', params],
    queryFn: () => apiGet<HistoricalEdge>('/brain/setup', params),
  });
}
export interface BrainAgentRow {
  id: string; domain: string; agentKey: string; agentVersion: number;
  standaloneAccuracy: string | null; effectiveN: string; wilsonLower: string | null;
  wilsonUpper: string | null; evidence: string; occurrenceCount: number;
  sampleSince: string | null;
}
export function useBrainAgents(domain: string) {
  return useQuery({
    enabled: !!domain,
    queryKey: ['brain.agents', domain],
    queryFn: () => apiGet<{ rows: BrainAgentRow[] }>('/brain/agents', { domain }),
  });
}
export interface RegimeStats {
  regime: 'LOW' | 'MED' | 'HIGH';
  effectiveN: number; winRate: number | null;
  medianReturn: number | null;
  wilsonLower: number | null; wilsonUpper: number | null;
  evidence: string;
}
export function useMarketMemory(domain: string) {
  return useQuery({
    enabled: !!domain,
    queryKey: ['brain.market', domain],
    queryFn: () => apiGet<{ domain: string; byRegime: RegimeStats[]; asOf: string }>('/brain/market', { domain }),
  });
}
