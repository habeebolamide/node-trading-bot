import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface ShadowGroupStats {
  n: number; wins: number; winRate: number | null;
  wilsonLower: number | null; wilsonUpper: number | null;
  medianReturn: number | null; meanReturn: number | null; maxDrawdown: number | null;
}
export function useShadowVsReal(params: { configVersion: number; horizon?: string }) {
  return useQuery({
    queryKey: ['shadow.vsReal', params],
    queryFn: () => apiGet<{ flipRealGroup: ShadowGroupStats; flipShadowGroup: ShadowGroupStats }>('/metrics/shadow/vs-real', params),
  });
}
export function useShadowVsBaseline(params: { domain: string; configVersion: number; horizon?: string }) {
  return useQuery({
    queryKey: ['shadow.vsBaseline', params],
    queryFn: () => apiGet<{ standAsideShadowGroup: ShadowGroupStats; baseline: ShadowGroupStats }>('/metrics/shadow/vs-baseline', params),
  });
}
