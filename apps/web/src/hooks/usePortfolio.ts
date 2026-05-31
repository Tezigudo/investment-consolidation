import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export function usePortfolio() {
  return useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api.portfolio(false),
    // 60s (was 30s) to trim Neon compute — the DB only refreshes every ~30 min
    // via cron, so faster polling just keeps the compute awake for nothing.
    // refetchIntervalInBackground:false lets the compute suspend when the tab
    // is hidden.
    refetchInterval: 60_000,
    refetchIntervalInBackground: false,
    staleTime: 30_000,
  });
}

export function useTrades() {
  return useQuery({
    queryKey: ['trades'],
    queryFn: () => api.trades({ limit: 50 }),
    staleTime: 60_000,
  });
}

export function useFuturesAnalytics(rangeDays = 30) {
  return useQuery({
    queryKey: ['futures-analytics', rangeDays],
    queryFn: () => api.futuresAnalytics(rangeDays),
    // 120s — the futures DB rows only update hourly (droplet push), so polling
    // faster wastes Neon compute with no fresher data.
    refetchInterval: 120_000,
    refetchIntervalInBackground: false,
    staleTime: 60_000,
  });
}
