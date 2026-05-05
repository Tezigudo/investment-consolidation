import { useLocalSearchParams, Stack } from 'expo-router';
import { useMemo, useState } from 'react';
import {
  ActivityIndicator,
  Dimensions,
  ScrollView,
  Text,
  View,
} from 'react-native';
import type { Platform } from '@consolidate/shared';
import { Card } from '@/components/Card';
import { PriceChart } from '@/components/PriceChart';
import { SegmentedControl } from '@/components/SegmentedControl';
import { Stat } from '@/components/Stat';
import { PlatformBadge } from '@/components/PlatformBadge';
import { useSymbolHistory, usePortfolio } from '@/hooks/usePortfolio';
import { useCostView } from '@/hooks/useCostView';
import {
  fmtDate,
  fmtQty,
  fmtTHB,
  fmtTHBDetail,
  fmtUSD,
  safePctDisplay,
} from '@/lib/format';
import { priceKind } from '@/lib/kind';
import { colors, spacing, typography } from '@/theme/tokens';

type TF = '1W' | '1M' | '6M' | '1Y' | 'ALL';
const DAYS_FOR: Record<TF, number> = {
  '1W': 7,
  '1M': 30,
  '6M': 180,
  '1Y': 365,
  ALL: 1825,
};

function tone(n: number): 'pos' | 'neg' | 'muted' {
  if (n > 0.01) return 'pos';
  if (n < -0.01) return 'neg';
  return 'muted';
}

function LegendDot({
  color,
  label,
  dashed,
}: {
  color: string;
  label: string;
  dashed?: boolean;
}) {
  return (
    <View style={{ flexDirection: 'row', alignItems: 'center', gap: 6 }}>
      <View
        style={{
          width: 10,
          height: 10,
          borderRadius: dashed ? 0 : 5,
          borderTopWidth: dashed ? 1 : 0,
          borderTopColor: color,
          backgroundColor: dashed ? 'transparent' : color,
        }}
      />
      <Text style={{ ...typography.caption, color: colors.textMuted }}>{label}</Text>
    </View>
  );
}

export default function PositionDetailScreen() {
  const { symbol, platform } = useLocalSearchParams<{
    symbol: string;
    platform: Platform;
  }>();
  const [tf, setTf] = useState<TF>('6M');
  const [costView, setCostView] = useCostView();

  const kind = priceKind(platform ?? 'Binance');
  const days = DAYS_FOR[tf];
  const history = useSymbolHistory(symbol ?? '', days, kind);
  const portfolio = usePortfolio();

  const position = useMemo(() => {
    if (!portfolio.data || !symbol) return null;
    const all = [
      ...portfolio.data.positions.dime,
      ...portfolio.data.positions.binance,
      ...portfolio.data.positions.onchain,
    ];
    return all.find((p) => p.symbol === symbol && p.platform === platform) ?? null;
  }, [portfolio.data, symbol, platform]);

  const chartWidth = Dimensions.get('window').width - spacing.lg * 2;

  const dimeAvg = position
    ? position.qty > 0
      ? (position.costUSD - position.realizedUSD) / position.qty
      : position.avgUSD
    : 0;
  const displayAvg =
    position && costView === 'dime' && position.platform === 'DIME'
      ? dimeAvg
      : position?.avgUSD ?? 0;

  return (
    <>
      <Stack.Screen options={{ title: symbol ?? '' }} />
      <ScrollView
        style={{ flex: 1, backgroundColor: colors.bg }}
        contentContainerStyle={{ padding: spacing.lg, paddingBottom: spacing.xxl }}
      >
        <View style={{ marginBottom: spacing.lg }}>
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
            <Text style={{ ...typography.h1, color: colors.text }}>{symbol}</Text>
            {platform ? <PlatformBadge platform={platform as Platform} /> : null}
          </View>
          {position?.name ? (
            <Text style={{ ...typography.body, color: colors.textMuted, marginTop: 2 }}>
              {position.name}
            </Text>
          ) : null}
        </View>

        <Card style={{ marginBottom: spacing.lg }}>
          <View
            style={{
              flexDirection: 'row',
              justifyContent: 'space-between',
              alignItems: 'flex-end',
              marginBottom: spacing.md,
            }}
          >
            <View>
              <Text style={{ ...typography.micro, color: colors.textDim, textTransform: 'uppercase' }}>
                Last price
              </Text>
              <Text
                style={{
                  ...typography.h1,
                  ...typography.mono,
                  color: colors.text,
                  marginTop: spacing.xs,
                }}
              >
                {fmtUSD(history.data?.todayUSD ?? position?.priceUSD ?? 0)}
              </Text>
            </View>
            {position ? (
              <View style={{ alignItems: 'flex-end' }}>
                <Text
                  style={{
                    ...typography.bodyMedium,
                    ...typography.mono,
                    color: position.pnlUSD >= 0 ? colors.green : colors.red,
                  }}
                >
                  {position.pnlUSD >= 0 ? '+' : ''}
                  {fmtUSD(position.pnlUSD)}
                </Text>
                {(() => {
                  const realizedTHBish = position.realizedUSD * (position.fxLocked || 0);
                  const pct = safePctDisplay(
                    position.pnlTHB,
                    position.costTHB - realizedTHBish,
                  );
                  return pct ? (
                    <Text
                      style={{
                        ...typography.caption,
                        ...typography.mono,
                        color: colors.textMuted,
                      }}
                    >
                      {pct}
                    </Text>
                  ) : null;
                })()}
              </View>
            ) : null}
          </View>

          {history.isLoading ? (
            <View
              style={{
                height: 180,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <ActivityIndicator color={colors.accent} />
            </View>
          ) : history.data && history.data.series.length > 1 ? (
            <>
              <PriceChart
                series={history.data.series}
                trades={history.data.trades}
                avgPriceUSD={displayAvg > 0 ? displayAvg : undefined}
                width={chartWidth - 2}
                height={180}
              />
              <View
                style={{
                  flexDirection: 'row',
                  gap: spacing.md,
                  marginTop: spacing.sm,
                  flexWrap: 'wrap',
                }}
              >
                <LegendDot color={colors.green} label="BUY" />
                <LegendDot color={colors.red} label="SELL" />
                <LegendDot color={colors.amber} label="DIV" />
                <LegendDot color={colors.textMuted} label={`avg $${displayAvg.toFixed(2)}`} dashed />
              </View>
            </>
          ) : (
            <View
              style={{
                height: 180,
                alignItems: 'center',
                justifyContent: 'center',
              }}
            >
              <Text style={{ ...typography.caption, color: colors.textMuted }}>
                No price history available.
              </Text>
            </View>
          )}

          <View style={{ marginTop: spacing.md }}>
            <SegmentedControl
              value={tf}
              onChange={setTf}
              options={[
                { value: '1W', label: '1W' },
                { value: '1M', label: '1M' },
                { value: '6M', label: '6M' },
                { value: '1Y', label: '1Y' },
                { value: 'ALL', label: 'ALL' },
              ]}
            />
          </View>
        </Card>

        {position ? (
          <Card style={{ marginBottom: spacing.lg }}>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                alignItems: 'center',
                marginBottom: spacing.md,
              }}
            >
              <Text
                style={{
                  ...typography.micro,
                  color: colors.textDim,
                  textTransform: 'uppercase',
                }}
              >
                Position
              </Text>
              {position.platform === 'DIME' ? (
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
              ) : null}
            </View>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Stat label="Qty" value={fmtQty(position.qty)} />
              <Stat
                label={costView === 'dime' && position.platform === 'DIME' ? 'Net cash / share' : 'Avg cost'}
                value={fmtUSD(displayAvg)}
                align="right"
              />
            </View>
            <View
              style={{
                flexDirection: 'row',
                justifyContent: 'space-between',
                marginTop: spacing.lg,
              }}
            >
              <Stat label="Market" value={fmtTHB(position.marketTHB)} sub={fmtUSD(position.marketUSD)} />
              <Stat
                label="Cost"
                value={fmtTHB(position.costTHB)}
                sub={fmtUSD(position.costUSD)}
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
                label="PNL THB"
                value={fmtTHB(position.pnlTHB)}
                sub={`Mkt ${fmtTHB(position.pnlTHB - position.fxContribTHB)}`}
                tone={tone(position.pnlTHB)}
              />
              <Stat
                label="FX contribution"
                value={fmtTHB(position.fxContribTHB)}
                tone={tone(position.fxContribTHB)}
                align="right"
              />
            </View>
            {history.data && (history.data.realizedUSD !== 0 || history.data.realizedTHB !== 0) ? (
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
                  label="Realized USD"
                  value={fmtUSD(history.data.realizedUSD)}
                  tone={tone(history.data.realizedUSD)}
                />
                <Stat
                  label="Realized THB"
                  value={fmtTHBDetail(history.data.realizedTHB)}
                  sub={`FX ${fmtTHB(history.data.realizedFxContribTHB)}`}
                  tone={tone(history.data.realizedTHB)}
                  align="right"
                />
              </View>
            ) : null}
          </Card>
        ) : null}

        {history.data && history.data.earned && history.data.earned.count > 0 ? (
          <Card style={{ marginBottom: spacing.lg }}>
            <Text
              style={{
                ...typography.micro,
                color: colors.textDim,
                textTransform: 'uppercase',
                marginBottom: spacing.md,
              }}
            >
              Earn rewards · {history.data.earned.count} payouts
            </Text>
            <View style={{ flexDirection: 'row', justifyContent: 'space-between' }}>
              <Stat
                label="Total earned"
                value={fmtQty(history.data.earned.qty)}
                sub={`${symbol} accrued`}
                tone="pos"
              />
              <Stat
                label="Value at receipt"
                value={fmtTHB(history.data.earned.valueTHB)}
                sub={fmtUSD(history.data.earned.valueUSD)}
                tone="pos"
                align="right"
              />
            </View>
            {history.data.earned.firstTs > 0 ? (
              <Text
                style={{
                  ...typography.caption,
                  color: colors.textDim,
                  marginTop: spacing.sm,
                }}
              >
                {fmtDate(history.data.earned.firstTs)} → {fmtDate(history.data.earned.lastTs)}
              </Text>
            ) : null}
          </Card>
        ) : null}

        {history.data && history.data.trades.length > 0 ? (
          <Card>
            <Text
              style={{
                ...typography.micro,
                color: colors.textDim,
                textTransform: 'uppercase',
                marginBottom: spacing.md,
              }}
            >
              Trades · {history.data.trades.length}
            </Text>
            {history.data.trades.map((t) => {
              const sideColor =
                t.side === 'BUY'
                  ? colors.green
                  : t.side === 'SELL'
                    ? colors.red
                    : colors.amber;
              const valueUSD =
                t.qty * t.price_usd + (t.side === 'BUY' ? t.commission : -t.commission);
              return (
                <View
                  key={t.id}
                  style={{
                    flexDirection: 'row',
                    justifyContent: 'space-between',
                    paddingVertical: spacing.sm,
                    borderBottomWidth: 1,
                    borderBottomColor: colors.border,
                  }}
                >
                  <View>
                    <View style={{ flexDirection: 'row', alignItems: 'center', gap: spacing.sm }}>
                      <Text
                        style={{
                          ...typography.bodyMedium,
                          color: sideColor,
                          width: 44,
                        }}
                      >
                        {t.side}
                      </Text>
                      <Text style={{ ...typography.caption, color: colors.textMuted }}>
                        {fmtDate(t.ts)}
                      </Text>
                    </View>
                    <Text
                      style={{
                        ...typography.caption,
                        ...typography.mono,
                        color: colors.textMuted,
                        marginTop: 2,
                      }}
                    >
                      {fmtQty(t.qty)} @ {fmtUSD(t.price_usd)}
                      {t.commission ? ` · fee ${fmtUSD(t.commission)}` : ''}
                    </Text>
                  </View>
                  <View style={{ alignItems: 'flex-end' }}>
                    <Text
                      style={{
                        ...typography.bodyMedium,
                        ...typography.mono,
                        color: colors.text,
                      }}
                    >
                      {fmtUSD(valueUSD)}
                    </Text>
                    <Text
                      style={{
                        ...typography.caption,
                        ...typography.mono,
                        color: colors.textDim,
                      }}
                    >
                      FX {t.fx_at_trade.toFixed(2)}
                    </Text>
                  </View>
                </View>
              );
            })}
          </Card>
        ) : null}
      </ScrollView>
    </>
  );
}
