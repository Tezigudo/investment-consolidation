import AsyncStorage from '@react-native-async-storage/async-storage';
import { useEffect, useState } from 'react';

export type CostView = 'standard' | 'dime';

const KEY = '@consolidate/costView';

// Same toggle as the web Dashboard. Standard = weighted-avg cost.
// DIME = net cash invested (matches what the DIME app shows).
export function useCostView(): [CostView, (v: CostView) => void] {
  const [view, setView] = useState<CostView>('standard');
  useEffect(() => {
    AsyncStorage.getItem(KEY).then((v) => {
      if (v === 'standard' || v === 'dime') setView(v);
    });
  }, []);
  const update = (v: CostView) => {
    setView(v);
    AsyncStorage.setItem(KEY, v);
  };
  return [view, update];
}
