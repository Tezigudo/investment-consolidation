import { useCallback, useState } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { useQuery, useQueryClient } from '@tanstack/react-query';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { Platform, TradeRow } from '@consolidate/shared';
import { api } from '@/api/client';
import { FilterPills } from '@/components/FilterPills';
import { PlatformBadge } from '@/components/PlatformBadge';
import { fmtDateTime, fmtQty, fmtUSD } from '@/lib/format';
import { colors, spacing, typography } from '@/theme/tokens';

type FilterValue = 'all' | Platform;

function TradeItem({ t }: { t: TradeRow }) {
  const sideColor =
    t.side === 'BUY' ? colors.green : t.side === 'SELL' ? colors.red : colors.amber;
  const valueUSD =
    t.qty * t.price_usd + (t.side === 'BUY' ? t.commission : -t.commission);
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        router.push(`/position/${t.symbol}?platform=${t.platform}`);
      }}
      style={({ pressed }) => ({
        paddingHorizontal: spacing.lg,
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
        backgroundColor: pressed ? colors.bgElevated : 'transparent',
      })}
    >
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          alignItems: 'center',
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
          <Text style={{ ...typography.bodyMedium, color: sideColor, width: 44 }}>
            {t.side}
          </Text>
          <Text style={{ ...typography.bodyMedium, color: colors.text }}>{t.symbol}</Text>
          <PlatformBadge platform={t.platform} />
        </View>
        <Text style={{ ...typography.bodyMedium, ...typography.mono, color: colors.text }}>
          {fmtUSD(valueUSD)}
        </Text>
      </View>
      <View
        style={{
          flexDirection: 'row',
          justifyContent: 'space-between',
          marginTop: 2,
        }}
      >
        <Text style={{ ...typography.caption, color: colors.textMuted }}>
          {fmtDateTime(t.ts)}
        </Text>
        <Text style={{ ...typography.caption, ...typography.mono, color: colors.textMuted }}>
          {fmtQty(t.qty)} @ {fmtUSD(t.price_usd)}
        </Text>
      </View>
    </Pressable>
  );
}

export default function ActivityScreen() {
  const [filter, setFilter] = useState<FilterValue>('all');
  const qc = useQueryClient();
  const trades = useQuery({
    queryKey: ['trades', filter],
    queryFn: () =>
      api.trades({ platform: filter === 'all' ? undefined : filter, limit: 200 }),
  });

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await qc.invalidateQueries({ queryKey: ['trades'] });
  }, [qc]);

  if (trades.isLoading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          alignItems: 'center',
          justifyContent: 'center',
        }}
      >
        <ActivityIndicator color={colors.accent} />
      </View>
    );
  }

  return (
    <View style={{ flex: 1, backgroundColor: colors.bg }}>
      <FilterPills
        value={filter}
        onChange={setFilter}
        options={[
          { value: 'all', label: 'All' },
          { value: 'DIME', label: 'DIME' },
          { value: 'Binance', label: 'Binance' },
          { value: 'OnChain', label: 'On-chain' },
        ]}
      />
      <FlashList
        data={trades.data ?? []}
        keyExtractor={(t) => String(t.id)}
        refreshControl={
          <RefreshControl
            refreshing={trades.isRefetching}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
        renderItem={({ item }) => <TradeItem t={item} />}
        ListEmptyComponent={
          <View style={{ padding: spacing.xl, alignItems: 'center' }}>
            <Text style={{ ...typography.body, color: colors.textMuted }}>
              No trades for this filter.
            </Text>
          </View>
        }
      />
    </View>
  );
}
