import { QueryClient } from '@tanstack/react-query';

export const queryClient = new QueryClient({
  defaultOptions: {
    queries: {
      // Same cadence as the web dashboard: poll every 30s while focused.
      // refetchInterval is set per-hook so we don't spam dormant screens.
      staleTime: 25_000,
      gcTime: 5 * 60_000,
      retry: 1,
      refetchOnWindowFocus: false,
    },
  },
});
