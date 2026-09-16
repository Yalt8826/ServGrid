/**
 * The owner's performance charts — WEB (OW.3, 2026-09-16).
 *
 * Recharts, imported from a `.web.tsx` file exactly as `maplibre-gl` is
 * for the map: Metro resolves this file for web alone, so the library
 * never reaches the Android bundle and this stays a T1 change.
 *
 * The owner asked for charts he can hover: a stacked bar per day, one
 * segment per person, a tooltip naming every person's value and the day's
 * total, and a filter that drops the stack to one person without moving
 * the axis — so the two readings compare.
 */
import { View } from 'react-native';
import {
  Bar,
  BarChart,
  CartesianGrid,
  Legend,
  ResponsiveContainer,
  Tooltip,
  XAxis,
  YAxis,
} from 'recharts';

import type { CSSProperties } from 'react';

import { DESK, SEMANTIC, TYPE, formatMoneyEnIN } from '@servgrid/shared';
import type { PerfPerson, StackRow } from './performance';

/**
 * The tooltip and legend are DOM, not react-native-web views, so they
 * take CSS — `textStyle()` returns a React Native TextStyle and cannot
 * cross that line. The type ramp still decides the sizes: these read the
 * same tokens, in the units the browser wants.
 */
function domText(step: 'label' | 'caption', color: string): CSSProperties {
  return {
    fontSize: TYPE[step].size,
    lineHeight: `${TYPE[step].lineHeight}px`,
    fontWeight: TYPE[step].weight as CSSProperties['fontWeight'],
    color,
  };
}

export interface PerformanceChartProps {
  rows: StackRow[];
  people: PerfPerson[];
  /** Money formats as rupees; a count is a bare integer. */
  kind: 'money' | 'count';
  height: number;
  testID?: string;
}

const AXIS_FONT = 12;

function colourFor(index: number): string {
  const series = DESK.chart.series;
  return series[index % series.length] ?? SEMANTIC.text.primary;
}

/** `₹1,200` on an axis, `₹1,200.00` in a tooltip — the axis is a scale, the tooltip is the figure. */
function axisValue(value: number, kind: 'money' | 'count'): string {
  if (kind === 'count') return String(value);
  return `₹${formatMoneyEnIN(String(Math.round(value)))}`;
}

function exactValue(value: number, kind: 'money' | 'count'): string {
  if (kind === 'count') return `${value} ${value === 1 ? 'job' : 'jobs'}`;
  return `₹${formatMoneyEnIN(value.toFixed(2))}`;
}

interface TooltipEntry {
  name?: string;
  value?: number;
  color?: string;
}

/**
 * The tooltip the owner asked for: every person on that day with their
 * figure, and the day's total under them. Zero-valued segments are left
 * out — a list of eight people where six did nothing that day is a list
 * nobody reads.
 */
function ChartTooltip({
  active,
  payload,
  label,
  kind,
}: {
  active?: boolean;
  payload?: TooltipEntry[];
  label?: string;
  kind: 'money' | 'count';
}): React.ReactNode {
  if (active !== true || payload === undefined || payload.length === 0) return null;
  const entries = payload.filter((e) => (e.value ?? 0) > 0);
  const total = payload.reduce((sum, e) => sum + (e.value ?? 0), 0);
  return (
    <div
      style={{
        background: DESK.card.bg,
        border: `1px solid ${DESK.card.border}`,
        borderRadius: DESK.card.radius,
        boxShadow: DESK.card.webShadowHover,
        padding: '10px 12px',
        minWidth: 180,
      }}
    >
      <div style={{ ...domText('label', SEMANTIC.text.primary), marginBottom: 6 }}>{label}</div>
      {entries.length === 0 ? (
        <div style={domText('caption', SEMANTIC.text.secondary)}>Nothing on this day</div>
      ) : (
        entries.map((entry) => (
          <div
            key={entry.name}
            style={{ display: 'flex', alignItems: 'center', gap: 8, justifyContent: 'space-between' }}
          >
            <span style={{ display: 'flex', alignItems: 'center', gap: 6, minWidth: 0 }}>
              <span
                style={{ width: 8, height: 8, borderRadius: 2, background: entry.color, flexShrink: 0 }}
                aria-hidden
              />
              <span style={domText('caption', SEMANTIC.text.secondary)}>{entry.name}</span>
            </span>
            <span style={{ ...domText('caption', SEMANTIC.text.primary), fontVariant: 'tabular-nums' }}>
              {exactValue(entry.value ?? 0, kind)}
            </span>
          </div>
        ))
      )}
      {entries.length > 1 ? (
        <div
          style={{
            display: 'flex',
            justifyContent: 'space-between',
            gap: 8,
            marginTop: 6,
            paddingTop: 6,
            borderTop: `1px solid ${DESK.card.border}`,
          }}
        >
          <span style={domText('caption', SEMANTIC.text.secondary)}>Total</span>
          <span style={{ ...domText('label', SEMANTIC.text.primary), fontVariant: 'tabular-nums' }}>
            {exactValue(total, kind)}
          </span>
        </div>
      ) : null}
    </div>
  );
}

export function PerformanceChart({ rows, people, kind, height, testID }: PerformanceChartProps): React.ReactNode {
  const data = rows.map((row) => ({ label: row.label, ...row.values }));
  return (
    <View testID={testID} style={{ height, width: '100%' }}>
      <ResponsiveContainer width="100%" height="100%">
        <BarChart data={data} margin={{ top: 4, right: 8, bottom: 0, left: 8 }} barCategoryGap="20%">
          <CartesianGrid stroke={DESK.chart.grid} vertical={false} />
          <XAxis
            dataKey="label"
            tick={{ fill: DESK.chart.axis, fontSize: AXIS_FONT }}
            axisLine={{ stroke: DESK.chart.grid }}
            tickLine={false}
            interval="preserveStartEnd"
            minTickGap={16}
          />
          <YAxis
            width={kind === 'money' ? 72 : 40}
            tick={{ fill: DESK.chart.axis, fontSize: AXIS_FONT }}
            axisLine={false}
            tickLine={false}
            allowDecimals={kind === 'count' ? false : true}
            tickFormatter={(value: number) => axisValue(value, kind)}
          />
          <Tooltip
            cursor={{ fill: SEMANTIC.bg.pressed }}
            content={({ active, payload, label }) => (
              <ChartTooltip
                active={active}
                payload={payload as unknown as TooltipEntry[] | undefined}
                label={label as string | undefined}
                kind={kind}
              />
            )}
          />
          {/* One person is their own legend — the panel's filter already says who. */}
          {people.length > 1 ? (
            <Legend
              verticalAlign="bottom"
              height={28}
              iconType="square"
              iconSize={9}
              formatter={(value: string) => (
                <span style={domText('caption', SEMANTIC.text.secondary)}>{value}</span>
              )}
            />
          ) : null}
          {people.map((person, index) => (
            <Bar
              key={person.id}
              dataKey={person.id}
              name={person.name}
              stackId="people"
              fill={colourFor(index)}
              radius={[2, 2, 0, 0]}
              isAnimationActive={false}
            />
          ))}
        </BarChart>
      </ResponsiveContainer>
    </View>
  );
}
