import { useEffect, useState } from 'react';

// 640px catches iPhones (~390-430px wide) without grabbing iPad portrait
// (820px wide) — the desktop dashboard works fine on iPad.
const QUERY = '(max-width: 640px)';

export function useIsMobile(): boolean {
  const [match, setMatch] = useState<boolean>(() => {
    if (typeof window === 'undefined') return false;
    return window.matchMedia(QUERY).matches;
  });

  useEffect(() => {
    const mq = window.matchMedia(QUERY);
    const onChange = (e: MediaQueryListEvent) => setMatch(e.matches);
    mq.addEventListener('change', onChange);
    return () => mq.removeEventListener('change', onChange);
  }, []);

  return match;
}
