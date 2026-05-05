import { useQuery } from '@tanstack/react-query';
import { api } from '@/api/client';

export function usePortfolio() {
  return useQuery({
    queryKey: ['portfolio'],
    queryFn: () => api.portfolio(false),
    refetchInterval: 30_000,
  });
}

export function useSymbolHistory(
  symbol: string,
  days: number,
  kind: 'stock' | 'crypto',
) {
  return useQuery({
    queryKey: ['symbolHistory', symbol, days, kind],
    queryFn: () => api.symbolHistory(symbol, { days, kind }),
    enabled: !!symbol,
  });
}
