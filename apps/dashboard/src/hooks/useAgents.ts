import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface AgentRow {
  id: string;
  name: string;
  domain: 'perp' | 'memecoin';
  tradingStyle: 'scalp' | 'day' | 'swing';
  status: string;
  activeConfigVersion: number;
  universe: string[];
  config: { agentWeights: Record<string, number>; [k: string]: unknown };
}

interface AgentListResp { tradingAgents: AgentRow[]; count: number }

export function useAgents() {
  return useQuery({
    queryKey: ['agents'],
    queryFn: async () => (await apiGet<AgentListResp>('/../trading-agents')).tradingAgents,
  });
}

export function useAgent(id: string | undefined) {
  return useQuery({ enabled: !!id, queryKey: ['agent', id], queryFn: () => apiGet<AgentRow>(`/../trading-agents/${id!}`) });
}
