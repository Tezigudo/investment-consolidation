import { useMemo, useCallback } from 'react';
import {
  ActivityIndicator,
  Pressable,
  RefreshControl,
  ScrollView,
  Text,
  View,
} from 'react-native';
import { useQueryClient } from '@tanstack/react-query';
import * as Haptics from 'expo-haptics';
import { router } from 'expo-router';
import type { EnrichedPosition, Totals } from '@consolidate/shared';
import { Card } from '@/components/Card';
import { Stat } from '@/components/Stat';
import { PlatformBadge } from '@/components/PlatformBadge';
import { usePortfolio } from '@/hooks/usePortfolio';
import { fmtAge, fmtPct, fmtTHB, fmtTHBDetail, safePctDisplay } from '@/lib/format';
import { colors, spacing, typography } from '@/theme/tokens';

function tone(n: number): 'pos' | 'neg' | 'muted' {
  if (n > 0) return 'pos';
  if (n < 0) return 'neg';
  return 'muted';
}

function pctOfCost(t: Totals): number {
  return t.costTHB > 0 ? t.pnlTHB / t.costTHB : 0;
}

// Total-return base: cost of remaining shares + cost the user already
// got back via realized PNL. This stays stable across partial sells, so
// the % doesn't blow up when most of a position has been closed.
function totalReturnPct(p: EnrichedPosition): string | null {
  const realizedTHBish = p.realizedUSD * (p.fxLocked || 0);
  const base = p.costTHB - realizedTHBish; // ≈ original net cash invested
  return safePctDisplay(p.pnlTHB, base);
}

function PlatformRow({
  totals,
  badge,
}: {
  totals: Totals;
  badge: React.ReactNode;
}) {
  if (totals.marketTHB <= 0 && totals.costTHB <= 0) return null;
  const pct = pctOfCost(totals);
  return (
    <View
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        justifyContent: 'space-between',
        paddingVertical: spacing.md,
        borderBottomWidth: 1,
        borderBottomColor: colors.border,
      }}
    >
      <View>{badge}</View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text style={{ ...typography.bodyMedium, ...typography.mono, color: colors.text }}>
          {fmtTHB(totals.marketTHB)}
        </Text>
        <Text
          style={{
            ...typography.caption,
            ...typography.mono,
            color: totals.pnlTHB >= 0 ? colors.green : colors.red,
          }}
        >
          {totals.pnlTHB >= 0 ? '+' : ''}
          {fmtTHB(totals.pnlTHB)} · {fmtPct(pct)}
        </Text>
      </View>
    </View>
  );
}

function MoverRow({ p }: { p: EnrichedPosition }) {
  return (
    <Pressable
      onPress={() => router.push(`/position/${p.symbol}?platform=${p.platform}`)}
      style={({ pressed }) => ({
        flexDirection: 'row',
        justifyContent: 'space-between',
        alignItems: 'center',
        paddingVertical: spacing.sm,
        opacity: pressed ? 0.6 : 1,
      })}
    >
      <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
        <Text style={{ ...typography.bodyMedium, color: colors.text, minWidth: 64 }}>
          {p.symbol}
        </Text>
        <PlatformBadge platform={p.platform} />
      </View>
      <View style={{ alignItems: 'flex-end' }}>
        <Text
          style={{
            ...typography.bodyMedium,
            ...typography.mono,
            color: p.pnlTHB >= 0 ? colors.green : colors.red,
          }}
        >
          {p.pnlTHB >= 0 ? '+' : ''}
          {fmtTHB(p.pnlTHB)}
        </Text>
        {(() => {
          const pct = totalReturnPct(p);
          return pct ? (
            <Text style={{ ...typography.caption, ...typography.mono, color: colors.textMuted }}>
              {pct}
            </Text>
          ) : null;
        })()}
      </View>
    </Pressable>
  );
}

export default function PortfolioScreen() {
  const { data, isLoading, isRefetching, refetch, error } = usePortfolio();
  const qc = useQueryClient();

  const onRefresh = useCallback(async () => {
    Haptics.impactAsync(Haptics.ImpactFeedbackStyle.Light);
    await refetch();
    qc.invalidateQueries({ queryKey: ['portfolio'] });
  }, [refetch, qc]);

  const movers = useMemo(() => {
    if (!data) return { up: [] as EnrichedPosition[], down: [] as EnrichedPosition[] };
    const all = [
      ...data.positions.dime,
      ...data.positions.binance,
      ...data.positions.onchain,
    ].filter((p) => Math.abs(p.pnlTHB) > 0);
    const up = [...all].sort((a, b) => b.pnlTHB - a.pnlTHB).slice(0, 3);
    const down = [...all].sort((a, b) => a.pnlTHB - b.pnlTHB).slice(0, 3);
    return { up, down };
  }, [data]);

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

  if (error || !data) {
    return (
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{ padding: spacing.lg }}
        refreshControl={
          <RefreshControl
            refreshing={isRefetching}
            onRefresh={onRefresh}
            tintColor={colors.accent}
          />
        }
      >
        <Card>
          <Text style={{ ...typography.h2, color: colors.red, marginBottom: spacing.sm }}>
            Couldn't load portfolio
          </Text>
          <Text style={{ ...typography.body, color: colors.textMuted }}>
            {(error as Error)?.message ??
              'API unreachable. Check Settings → Server URL and your Wi-Fi.'}
          </Text>
        </Card>
      </ScrollView>
    );
  }

  const t = data.totals.all;
  const marketPnlTHB = t.pnlTHB - t.fxContribTHB;

  return (
    <ScrollView
      style={{ flex: 1, backgroundColor: colors.bg }}
      contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      refreshControl={
        <RefreshControl
          refreshing={isRefetching}
          onRefresh={onRefresh}
          tintColor={colors.accent}
        />
      }
    >
      <View style={{ marginBottom: spacing.xl }}>
        <Text style={{ ...typography.micro, color: colors.textDim, textTransform: 'uppercase' }}>
          Net worth · USDTHB {data.fx.usdthb.toFixed(2)}
        </Text>
        <Text
          style={{
            ...typography.hero,
            ...typography.mono,
            color: colors.text,
            marginTop: spacing.xs,
          }}
        >
          {fmtTHB(t.marketTHB)}
        </Text>
        <Text
          style={{
            ...typography.bodyMedium,
            ...typography.mono,
            color: t.pnlTHB >= 0 ? colors.green : colors.red,
            marginTop: spacing.xs,
          }}
        >
          {t.pnlTHB >= 0 ? '+' : ''}
          {fmtTHB(t.pnlTHB)} ({fmtPct(pctOfCost(t))})
        </Text>
        <Text style={{ ...typography.caption, color: colors.textDim, marginTop: spacing.sm }}>
          Updated {fmtAge(data.asOf)}
        </Text>
      </View>

      <Card style={{ marginBottom: spacing.lg }}>
        <Text
          style={{
            ...typography.micro,
            color: colors.textDim,
            textTransform: 'uppercase',
            marginBottom: spacing.md,
          }}
        >
          Unrealized PNL breakdown
        </Text>
        <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
          <Stat label="Market" value={fmtTHB(marketPnlTHB)} tone={tone(marketPnlTHB)} />
          <Stat
            label="FX"
            value={fmtTHB(t.fxContribTHB)}
            tone={tone(t.fxContribTHB)}
            align="right"
          />
        </View>
        <View
          style={{
            flexDirection: 'row',
            justifyContent: 'space-between',
            marginTop: spacing.lg,
            paddingTop: spacing.lg,
            borderTopWidth: 1,
            borderTopColor: colors.border,
          }}
        >
          <Stat
            label="Realized THB"
            value={fmtTHBDetail(t.realizedTHB)}
            sub={`FX ${fmtTHB(t.realizedFxContribTHB)}`}
            tone={tone(t.realizedTHB)}
          />
          <Stat label="Cost basis" value={fmtTHB(t.costTHB)} tone="muted" align="right" />
        </View>
      </Card>

      <Card style={{ marginBottom: spacing.lg }}>
        <Text
          style={{
            ...typography.micro,
            color: colors.textDim,
            textTransform: 'uppercase',
            marginBottom: spacing.sm,
          }}
        >
          By platform
        </Text>
        <PlatformRow totals={data.totals.dime} badge={<PlatformBadge platform="DIME" />} />
        <PlatformRow totals={data.totals.binance} badge={<PlatformBadge platform="Binance" />} />
        <PlatformRow totals={data.totals.onchain} badge={<PlatformBadge platform="OnChain" />} />
        <PlatformRow totals={data.totals.bank} badge={<PlatformBadge platform="Bank" />} />
      </Card>

      {movers.up.length > 0 && movers.up[0].pnlTHB > 0 && (
        <Card style={{ marginBottom: spacing.lg }}>
          <Text
            style={{
              ...typography.micro,
              color: colors.textDim,
              textTransform: 'uppercase',
              marginBottom: spacing.sm,
            }}
          >
            Top winners
          </Text>
          {movers.up
            .filter((p) => p.pnlTHB > 0)
            .map((p) => (
              <MoverRow key={`${p.platform}:${p.symbol}`} p={p} />
            ))}
        </Card>
      )}

      {movers.down.length > 0 && movers.down[0].pnlTHB < 0 && (
        <Card>
          <Text
            style={{
              ...typography.micro,
              color: colors.textDim,
              textTransform: 'uppercase',
              marginBottom: spacing.sm,
            }}
          >
            Top losers
          </Text>
          {movers.down
            .filter((p) => p.pnlTHB < 0)
            .map((p) => (
              <MoverRow key={`${p.platform}:${p.symbol}`} p={p} />
            ))}
        </Card>
      )}
    </ScrollView>
  );
}
