import { useQuery } from '@tanstack/react-query';
import { api } from '../api/client';

export function usePortfolio() {
  return useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api.portfolio(false),
    refetchInterval: 30_000,           // 30s — the DB is refreshed by cron
    refetchIntervalInBackground: false,
    staleTime: 15_000,
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
    refetchInterval: 30_000,   // DB refreshed by the futures cron; mirror /portfolio
    refetchIntervalInBackground: false,
    staleTime: 15_000,
  });
}
