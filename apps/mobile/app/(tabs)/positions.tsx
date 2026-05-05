import { useMemo, useState, useCallback } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  Text,
  View,
} from 'react-native';
import { FlashList } from '@shopify/flash-list';
import { router } from 'expo-router';
import * as Haptics from 'expo-haptics';
import type { EnrichedPosition, Platform } from '@consolidate/shared';
import { FilterPills } from '@/components/FilterPills';
import { PlatformBadge } from '@/components/PlatformBadge';
import { SegmentedControl } from '@/components/SegmentedControl';
import { usePortfolio } from '@/hooks/usePortfolio';
import { useCostView } from '@/hooks/useCostView';
import { fmtQty, fmtTHB, fmtUSD, safePctDisplay } from '@/lib/format';
import { colors, spacing, typography } from '@/theme/tokens';

type FilterValue = 'all' | Platform;
type SortValue = 'market' | 'pnl' | 'pnlPct' | 'symbol';

function dimeAvgUSD(p: EnrichedPosition): number {
  if (p.qty <= 0) return p.avgUSD;
  // Net-cash-invested per share — same identity as web Dashboard:
  //   dimeAvg = (costUSD - realizedUSD) / qty
  return (p.costUSD - p.realizedUSD) / p.qty;
}

// % over original net cash invested. Stays sane after partial sells.
function totalReturnPct(p: EnrichedPosition): string | null {
  const realizedTHBish = p.realizedUSD * (p.fxLocked || 0);
  const base = p.costTHB - realizedTHBish;
  return safePctDisplay(p.pnlTHB, base);
}

function PositionRow({
  p,
  costView,
}: {
  p: EnrichedPosition;
  costView: 'standard' | 'dime';
}) {
  const avg = costView === 'dime' && p.platform === 'DIME' ? dimeAvgUSD(p) : p.avgUSD;
  const pnlColor = p.pnlTHB >= 0 ? colors.green : colors.red;
  return (
    <Pressable
      onPress={() => {
        Haptics.selectionAsync();
        router.push(`/position/${p.symbol}?platform=${p.platform}`);
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
          alignItems: 'center',
          justifyContent: 'space-between',
          marginBottom: 4,
        }}
      >
        <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm, flex: 1 }}>
          <Text style={{ ...typography.bodyMedium, color: colors.text }}>{p.symbol}</Text>
          <PlatformBadge platform={p.platform} />
        </View>
        <Text style={{ ...typography.bodyMedium, ...typography.mono, color: colors.text }}>
          {fmtTHB(p.marketTHB)}
        </Text>
      </View>
      <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
        <Text
          style={{
            ...typography.caption,
            ...typography.mono,
            color: colors.textMuted,
          }}
          numberOfLines={1}
        >
          {fmtQty(p.qty)} @ {fmtUSD(avg)} → {fmtUSD(p.priceUSD)}
        </Text>
        <Text
          style={{
            ...typography.caption,
            ...typography.mono,
            color: pnlColor,
          }}
        >
          {p.pnlTHB >= 0 ? '+' : ''}
          {fmtTHB(p.pnlTHB)}
          {(() => {
            const pct = totalReturnPct(p);
            return pct ? ` · ${pct}` : '';
          })()}
        </Text>
      </View>
    </Pressable>
  );
}

export default function PositionsScreen() {
  const { data, isLoading, isRefetching, refetch } = usePortfolio();
  const [filter, setFilter] = useState<FilterValue>('all');
  const [sort, setSort] = useState<SortValue>('market');
  const [costView, setCostView] = useCostView();

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refetch();
  }, [refetch]);

  const { all, byPlatform, sorted } = useMemo(() => {
    if (!data) return { all: [] as EnrichedPosition[], byPlatform: new Map<Platform, number>(), sorted: [] };
    const all = [
      ...data.positions.dime,
      ...data.positions.binance,
      ...data.positions.onchain,
      ...data.positions.bank,
    ];
    const byPlatform = new Map<Platform, number>();
    for (const p of all) byPlatform.set(p.platform, (byPlatform.get(p.platform) ?? 0) + 1);
    const filtered = filter === 'all' ? all : all.filter((p) => p.platform === filter);
    const sorted = [...filtered].sort((a, b) => {
      switch (sort) {
        case 'market':
          return b.marketTHB - a.marketTHB;
        case 'pnl':
          return b.pnlTHB - a.pnlTHB;
        case 'pnlPct':
          return b.pnlPctTHB - a.pnlPctTHB;
        case 'symbol':
          return a.symbol.localeCompare(b.symbol);
      }
    });
    return { all, byPlatform, sorted };
  }, [data, filter, sort]);

  if (isLoading) {
    return (
      <View
        style={{
          flex: 1,
          backgroundColor: colors.bg,
          justifyContent: 'center',
          alignItems: 'center',
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
          { value: 'all', label: 'All', count: all.length },
          { value: 'DIME', label: 'DIME', count: byPlatform.get('DIME') },
          { value: 'Binance', label: 'Binance', count: byPlatform.get('Binance') },
          { value: 'OnChain', label: 'On-chain', count: byPlatform.get('OnChain') },
          { value: 'Bank', label: 'Bank', count: byPlatform.get('Bank') },
        ]}
      />
      <View style={{ paddingHorizontal: spacing.lg, paddingBottom: spacing.sm }}>
        <SegmentedControl
          value={sort}
          onChange={setSort}
          options={[
            { value: 'market', label: 'Value' },
            { value: 'pnl', label: 'PNL' },
            { value: 'pnlPct', label: '%' },
            { value: 'symbol', label: 'A-Z' },
          ]}
        />
      </View>
      <View
        style={{
          flexDirection: 'row',
          alignItems: 'center',
          justifyContent: 'space-between',
          paddingHorizontal: spacing.lg,
          paddingTop: spacing.sm,
          paddingBottom: spacing.xs,
        }}
      >
        <Text style={{ ...typography.micro, color: colors.textDim, textTransform: 'uppercase' }}>
          {sorted.length} position{sorted.length === 1 ? '' : 's'}
        </Text>
        <View style={{ width: 180 }}>
          <SegmentedControl
            value={costView}
            onChange={setCostView}
            options={[
              { value: 'standard', label: 'Avg cost' },
              { value: 'dime', label: 'DIME view' },
            ]}
          />
        </View>
      </View>
      <FlashList
        data={sorted}
        keyExtractor={(p) => `${p.platform}:${p.symbol}`}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
        renderItem={({ item }) => <PositionRow p={item} costView={costView} />}
        ListEmptyComponent={
          <View style={{ padding: spacing.xl, alignItems: 'center' }}>
            <Text style={{ ...typography.body, color: colors.textMuted }}>
              No positions in this view.
            </Text>
          </View>
        }
      />
    </View>
  );
}
