import { useQuery } from '@tanstack/react-query';
import { apiGet } from '@/lib/api';

export interface HeadlineMetrics {
  domain: string; configVersion: number; horizon: string;
  n: number; wins: number; accuracy: number | null;
  wilsonLower: number | null; wilsonUpper: number | null;
  medianReturn: number | null; meanReturn: number | null;
  meanAlpha: number | null; maxDrawdown: number | null;
}
export function useHeadline(params: { domain: string; configVersion: number; horizon: string }) {
  return useQuery({
    queryKey: ['metrics.headline', params],
    queryFn: () => apiGet<HeadlineMetrics | null>('/metrics/headline', params),
  });
}
export function useByHorizon(params: { domain: string; configVersion: number; horizons: string }) {
  return useQuery({
    queryKey: ['metrics.byHorizon', params],
    queryFn: () => apiGet<{ rows: HeadlineMetrics[] }>('/metrics/by-horizon', params),
  });
}
export interface ReliabilityBin {
  binIndex: number; lower: number; upper: number; midpoint: number;
  n: number; winRate: number | null; wilsonLower: number | null; wilsonUpper: number | null;
}
export interface CalibrationSummary {
  brier: number | null; ece: number | null; bins: ReliabilityBin[]; n: number;
}
export function useCalibration(params: { domain: string; configVersion: number; horizon: string; bins?: number }) {
  return useQuery({
    queryKey: ['metrics.calibration', params],
    queryFn: () => apiGet<CalibrationSummary>('/metrics/calibration', params),
  });
}
