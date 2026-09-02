import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface Overview {
  openSignals: number;
  signalsLast24h: number;
  predictionsLast7d: number;
  portfolios: number;
  totalEquity: number;
}
export function useOverview() {
  return useQuery({ queryKey: ['overview'], queryFn: () => apiGet<Overview>('/overview') });
}
