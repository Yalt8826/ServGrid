/**
 * The dashboard's two long-view charts, rebuilt on the same engine as the
 * four performance charts (OW.5, 2026-09-16).
 *
 * They were hand-drawn Views from T4.8 — no axis labels you could read a
 * value off, no hover, and a different visual language from the charts
 * beside them, which is exactly what made the dashboard look like two
 * products stacked. Same Recharts, same grid, same tooltip, same
 * palette; only the shapes differ, because what they say differs: jobs
 * per day is a count you compare bar to bar, revenue per week is a
 * movement you follow.
 *
 * Web only, like every other Recharts import here.
 */
import { View } from 'react-native';
import {
  Area,
  AreaChart,
  Bar,
  BarChart,
  CartesianGrid,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import { DESK, SEMANTIC } from '@servgrid/shared';
import { ChartTooltip, type TooltipEntry } from './performanceChart.web';
import type { JobsPerDayPoint, RevenuePerWeekPoint } from './model';

const AXIS_FONT = 12;

/** `14 Sep` — parsed literally, never through `new Date()`, or an IST day drifts west. */
const MONTHS = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'] as const;

function shortDate(iso: string): string {
  const [, m = '01', d = '01'] = iso.split('-');
  return `${Number(d)} ${MONTHS[Number(m) - 1] ?? m}`;
}

export interface TrendChartProps<T> {
  points: T[];
  height: number;
  /** Kept for call-site compatibility with the hand-drawn charts. */
  nowYear?: number;
  testID?: string;
}

const AXIS_TICK = { fill: DESK.chart.axis, fontSize: AXIS_FONT };

export function JobsPerDayBarChart({ points, height, testID }: TrendChartProps<JobsPerDayPoint>): React.ReactNode {
  const data = points.map((point) => ({ label: shortDate(point.date), Jobs: point.jobs }));
  return (
    <View testID={testID} style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 0 }} barCategoryGap="15%">
          <CartesianGrid stroke={DESK.chart.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            axisLine={{ stroke: DESK.chart.grid }}
            tickLine={false}
            // Thirty labels do not fit; the ends and a readable spread do.
            interval="preserveStartEnd"
            minTickGap={28}
          />
          <YAxis width={36} tick={AXIS_TICK} axisLine={false} tickLine={false} allowDecimals={false} />
          <Tooltip
            cursor={{ fill: SEMANTIC.bg.pressed }}
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                payload={payload as unknown as TooltipEntry[] | undefined}
                label={label as string | undefined}
                kind="count"
              />
            )}
          />
          <Bar dataKey="Jobs" fill={DESK.chart.series[0]} radius={[2, 2, 0, 0]} isAnimationActive={false} />
        </BarChart>
      </ResponsiveContainer>
    </View>
  );
}

export function RevenuePerWeekLineChart({
  points,
  height,
  testID,
}: TrendChartProps<RevenuePerWeekPoint>): React.ReactNode {
  const data = points.map((point) => ({
    label: shortDate(point.weekStart),
    Revenue: Number(point.revenue),
  }));
  return (
    <View testID={testID} style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <AreaChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }}>
          <defs>
            {/* The one gradient in the product, and it earns its place: a
                line across twelve weeks reads as a movement, and the fill
                is what gives the movement a body without adding ink. */}
            <linearGradient id="revenueFill" x1="0" y1="0" x2="0" y2="1">
              <stop offset="0%" stopColor={DESK.chart.series[0]} stopOpacity={0.35} />
              <stop offset="100%" stopColor={DESK.chart.series[0]} stopOpacity={0.02} />
            </linearGradient>
          </defs>
          <CartesianGrid stroke={DESK.chart.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={AXIS_TICK}
            axisLine={{ stroke: DESK.chart.grid }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={24}
          />
          <YAxis
            width={72}
            tick={AXIS_TICK}
            axisLine={false}
            tickLine={false}
            tickFormatter={(value: number) => `₹${Math.round(value).toLocaleString('en-IN')}`}
          />
          <Tooltip
            cursor={{ stroke: DESK.chart.grid }}
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                payload={payload as unknown as TooltipEntry[] | undefined}
                label={label === undefined ? undefined : `Week of ${label as string}`}
                kind="money"
              />
            )}
          />
          <Area
            type="monotone"
            dataKey="Revenue"
            stroke={DESK.chart.series[0]}
            strokeWidth={2}
            fill="url(#revenueFill)"
            dot={{ r: 2, fill: DESK.chart.series[0], strokeWidth: 0 }}
            activeDot={{ r: 4 }}
            isAnimationActive={false}
          />
        </AreaChart>
      </ResponsiveContainer>
    </View>
  );
}
