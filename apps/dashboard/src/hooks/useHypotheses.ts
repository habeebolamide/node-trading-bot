import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface HypothesisRow {
  id: string; setupId: string; domain: string; category: string; categoryKind: string;
  evidenceCount: string; proposedChange: { kind: string; agentKey?: string; delta?: number } | Record<string, unknown>;
  status: string; backtestResult: unknown; oosResult: unknown;
  fromConfigVersion: number | null; toConfigVersion: number | null;
  createdAt: string; resolvedAt: string | null;
}
export function useHypotheses(params: { status?: string; setupId?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ['hypotheses', params],
    queryFn: () => apiGet<{ rows: HypothesisRow[] }>('/hypotheses', params),
  });
}
