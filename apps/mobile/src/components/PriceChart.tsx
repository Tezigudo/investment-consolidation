import { useMemo } from 'react';
import { View } from 'react-native';
import Svg, {
  Circle,
  Defs,
  Line,
  LinearGradient,
  Path,
  Stop,
  Text as SvgText,
} from 'react-native-svg';
import { colors } from '@/theme/tokens';

export interface ChartTrade {
  ts: number;
  side: 'BUY' | 'SELL' | 'DIV';
  price_usd: number;
}

interface Props {
  series: { t: number; price: number }[];
  trades?: ChartTrade[];
  avgPriceUSD?: number;
  width: number;
  height: number;
}

// SVG sparkline + trade markers + avg-cost reference line.
//   - markers are drawn at (trade.ts, trade.price_usd); off-window
//     trades are filtered out so a 1W view doesn't show a 6mo BUY at
//     the wrong x.
//   - avg-cost line is dashed and labeled with the price so the user
//     can read it without a tooltip.
export function PriceChart({
  series,
  trades = [],
  avgPriceUSD,
  width,
  height,
}: Props) {
  const computed = useMemo(() => {
    if (series.length < 2) return null;
    const xs = series.map((p) => p.t);
    const ys = series.map((p) => p.price);
    const xMin = xs[0];
    const xMax = xs[xs.length - 1];
    const yPriceMin = Math.min(...ys);
    const yPriceMax = Math.max(...ys);
    // Expand the y-range to also include avg-cost line + trade prices,
    // so they aren't clipped off the top/bottom.
    const extraYs: number[] = [];
    if (avgPriceUSD && avgPriceUSD > 0) extraYs.push(avgPriceUSD);
    for (const t of trades) {
      if (t.ts >= xMin && t.ts <= xMax && t.price_usd > 0) {
        extraYs.push(t.price_usd);
      }
    }
    const yMin = Math.min(yPriceMin, ...extraYs);
    const yMax = Math.max(yPriceMax, ...extraYs);
    const xRange = Math.max(xMax - xMin, 1);
    const yRange = Math.max(yMax - yMin, 1e-9);
    const pad = height * 0.1;
    const px = (t: number) => ((t - xMin) / xRange) * width;
    const py = (p: number) =>
      height - pad - ((p - yMin) / yRange) * (height - 2 * pad);

    let line = `M ${px(xs[0]).toFixed(2)} ${py(ys[0]).toFixed(2)}`;
    for (let i = 1; i < series.length; i++) {
      line += ` L ${px(xs[i]).toFixed(2)} ${py(ys[i]).toFixed(2)}`;
    }
    const fill = `${line} L ${width.toFixed(2)} ${height.toFixed(2)} L 0 ${height.toFixed(2)} Z`;

    const markers = trades
      .filter((t) => t.ts >= xMin && t.ts <= xMax)
      .map((t) => ({
        cx: px(t.ts),
        cy: py(t.price_usd),
        side: t.side,
      }));

    const avgY =
      avgPriceUSD && avgPriceUSD > 0 && avgPriceUSD >= yMin && avgPriceUSD <= yMax
        ? py(avgPriceUSD)
        : null;

    return {
      linePath: line,
      fillPath: fill,
      isUp: ys[ys.length - 1] >= ys[0],
      markers,
      avgY,
    };
  }, [series, trades, avgPriceUSD, width, height]);

  if (!computed) return <View style={{ width, height }} />;

  const { linePath, fillPath, isUp, markers, avgY } = computed;
  const stroke = isUp ? colors.green : colors.red;

  const colorFor = (side: ChartTrade['side']) =>
    side === 'BUY' ? colors.green : side === 'SELL' ? colors.red : colors.amber;

  return (
    <Svg width={width} height={height}>
      <Defs>
        <LinearGradient id="grad" x1="0" y1="0" x2="0" y2="1">
          <Stop offset="0" stopColor={stroke} stopOpacity={0.25} />
          <Stop offset="1" stopColor={stroke} stopOpacity={0} />
        </LinearGradient>
      </Defs>
      <Path d={fillPath} fill="url(#grad)" />
      <Path d={linePath} stroke={stroke} strokeWidth={2} fill="none" />

      {avgY != null && avgPriceUSD != null && (
        <>
          <Line
            x1={0}
            x2={width}
            y1={avgY}
            y2={avgY}
            stroke={colors.textMuted}
            strokeWidth={1}
            strokeDasharray="4 4"
          />
          <SvgText
            x={width - 4}
            y={avgY - 4}
            fontSize={10}
            fill={colors.textMuted}
            textAnchor="end"
          >
            avg ${avgPriceUSD.toFixed(2)}
          </SvgText>
        </>
      )}

      {markers.map((m, i) => (
        <Circle
          key={i}
          cx={m.cx}
          cy={m.cy}
          r={4}
          fill={colorFor(m.side)}
          stroke={colors.bg}
          strokeWidth={1.5}
        />
      ))}
    </Svg>
  );
}
