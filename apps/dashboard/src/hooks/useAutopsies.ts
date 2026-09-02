import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface AutopsyRow {
  id: string; predictionId: string; setupId: string; outcome: 'WIN' | 'LOSS';
  rootCause: string | null; failureCategory: string | null; successFactor: string | null;
  explanation: string | null;
  contributingFactors: string[] | null;
  agentFailures: { agent: string; assessment: string; impact: string }[] | null;
  lesson: string | null; recommendation: string | null;
  autopsyVersion: number; llmCallLogId: string | null; status: 'SUCCESS' | 'FAILED_LLM';
  createdAt: string;
}
export function useAutopsies(params: { setupId?: string; status?: string; outcome?: string; limit?: number } = {}) {
  return useQuery({
    queryKey: ['autopsies', params],
    queryFn: () => apiGet<{ rows: AutopsyRow[] }>('/autopsies', params),
  });
}
