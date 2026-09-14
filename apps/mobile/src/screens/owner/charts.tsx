/**
 * The O1 charts (T4.8, UI/plan-2/07-OWNER.md §O1). Two only — bars for
 * jobs per day, a line for revenue per week — drawn as plain Views: no
 * chart library, no SVG (a new native module is a Tier T3 event, this
 * task is T1), no gradient, no draw-in.
 *
 * §O1's chart rules, structural here:
 *
 * - `slate.900` for the data (`SEMANTIC.bg.dark` is that token's fill
 *   alias — screens reference aliases, never raw hex), `slate.200` for
 *   the grid (`SEMANTIC.line.default`), and the accent on EXACTLY ONE
 *   element per chart — the current period's bar, the current week's
 *   dot. The two-uses rule, counted by test.
 * - The chart appears WITH its data: the first render is static at full
 *   opacity. Only a *changed* value cross-fades (140ms, `quick`) — the
 *   same pattern the figures run, so a Sunday-evening review never waits
 *   out a performance, and a refresh that returns the same numbers moves
 *   nothing at all.
 * - Height is the spec's: 180 on the phone, 320 on the desk. Width is
 *   always the container's — bars flex, so 360dp and 412dp lay out
 *   identically; the line's chords need pixels and measure via
 *   onLayout, but the dots render percentage-positioned before the
 *   measure lands, so the data is on screen first paint.
 */
import { useEffect, useRef, useState } from 'react';
import { Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { COLORS, DURATION, EASING, RADII, SEMANTIC, SPACE } from '@servgrid/shared';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import type { JobsPerDayPoint, RevenuePerWeekPoint } from './model';

/** §O1 anatomy: charts 180 tall on the phone, 320 on the desk. */
export const CHART_HEIGHT_PHONE = 180;
export const CHART_HEIGHT_DESK = 320;

const GRID_STEPS = [1, 2, 3]; // interior gridlines at 25 / 50 / 75%; the baseline is the border

/**
 * The one change motion on this screen: opacity 1 on arrival — no
 * draw-in, no count-up — and a 140ms cross-fade when (and only when) the
 * value behind the chart changed. Same contract as the dispatcher's
 * figures (§D1) and the rep's MoneyFigure (§S1).
 */
function useChangeFade(signature: string): { value: number } {
  const opacity = useSharedValue(1);
  const last = useRef(signature);
  useEffect(() => {
    if (last.current === signature) return;
    last.current = signature;
    opacity.value = 0;
    opacity.value = withTiming(1, { duration: DURATION.quick, easing: easing(EASING.enter) });
  }, [signature, opacity]);
  return opacity;
}

function GridLines({ testID }: { testID: string }): React.ReactNode {
  return (
    <View style={{ position: 'absolute', left: 0, right: 0, top: 0, bottom: 0 }} pointerEvents="none">
      {GRID_STEPS.map((step) => (
        <View
          key={step}
          testID={`${testID}-grid-${step}`}
          style={{
            position: 'absolute',
            left: 0,
            right: 0,
            bottom: `${step * 25}%`,
            height: 1,
            backgroundColor: SEMANTIC.line.default, // slate.200 — the grid
          }}
        />
      ))}
    </View>
  );
}

function RangeCaption({ left, right }: { left: string; right: string }): React.ReactNode {
  return (
    <View style={{ flexDirection: 'row', justifyContent: 'space-between', marginTop: SPACE[1] }}>
      <Text style={rangeCaptionStyle}>{left}</Text>
      <Text style={rangeCaptionStyle}>{right}</Text>
    </View>
  );
}

const rangeCaptionStyle = {
  ...textStyle('caption'),
  color: SEMANTIC.text.secondary,
} as const;

/** One bar per day, oldest first; the current day's bar is the chart's single accent. */
export function JobsPerDayBarChart({
  points,
  height,
  nowYear,
  testID,
}: {
  points: JobsPerDayPoint[];
  height: number;
  nowYear: number;
  testID: string;
}): React.ReactNode {
  const max = Math.max(1, ...points.map((p) => p.jobs));
  const opacity = useChangeFade(points.map((p) => p.jobs).join(','));
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const last = points.length - 1;

  return (
    <Animated.View testID={testID} style={fade}>
      <View style={{ height }}>
        <GridLines testID={testID} />
        <View
          style={{
            flexDirection: 'row',
            alignItems: 'flex-end',
            height: '100%',
            gap: 2,
            borderBottomWidth: 1,
            borderBottomColor: SEMANTIC.line.default,
          }}
        >
          {points.map((point, i) => (
            <View
              key={point.date}
              testID={`${testID}-bar-${i}`}
              style={{
                flex: 1,
                height: `${Math.max(0, (point.jobs / max) * 100)}%`,
                // slate.900 for the data; ACCENT on the current day alone.
                backgroundColor: i === last ? COLORS.accent : SEMANTIC.bg.dark,
              }}
            />
          ))}
        </View>
      </View>
      <RangeCaption left={formatDateEnIN(points[0]?.date ?? '', nowYear)} right="today" />
    </Animated.View>
  );
}

// ── the line ────────────────────────────────────────────────────────────────

export interface LineDot {
  x: number;
  y: number;
}

export interface LineSegment {
  left: number;
  top: number;
  width: number;
  /** Radians — the chord's slope, applied as a rotate around the centre. */
  angle: number;
}

export interface LineGeometry {
  dots: LineDot[];
  segments: LineSegment[];
}

/**
 * Pure geometry for the revenue line: one dot per week centred on its
 * x-slot, chords between consecutive dots. Exported so tests can assert
 * the shape without measuring a view.
 */
export function lineGeometry(values: number[], height: number, width: number, pad = 8): LineGeometry {
  const max = Math.max(1, ...values);
  const n = Math.max(1, values.length);
  const xOf = (i: number): number => ((i + 0.5) / n) * width;
  const yOf = (v: number): number => pad + (1 - v / max) * (height - 2 * pad);
  const dots = values.map((v, i) => ({ x: xOf(i), y: yOf(v) }));
  const segments = dots.slice(0, -1).map((d, i) => {
    const e = dots[i + 1]!;
    const dx = e.x - d.x;
    const dy = e.y - d.y;
    const length = Math.hypot(dx, dy);
    return { left: (d.x + e.x) / 2 - length / 2, top: (d.y + e.y) / 2 - 1, width: length, angle: Math.atan2(dy, dx) };
  });
  return { dots, segments };
}

const DOT = 8;
const DOT_RADIUS = RADII.control; // 4 on an 8px square — the dot reads as a point

/** One dot per week (the current week's is the single accent), chords in slate.900. */
export function RevenuePerWeekLineChart({
  points,
  height,
  nowYear,
  testID,
}: {
  points: RevenuePerWeekPoint[];
  height: number;
  nowYear: number;
  testID: string;
}): React.ReactNode {
  const [width, setWidth] = useState<number | null>(null);
  const values = points.map((p) => Number(p.revenue));
  const opacity = useChangeFade(values.join(','));
  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));
  const last = values.length - 1;

  // Dots position by percentage until the measure lands, so the data is
  // on screen first paint; chords need px, and arrive with it.
  const max = Math.max(1, ...values);
  const yOf = (v: number): number => 8 + (1 - v / max) * (height - 16);
  const geo = width === null ? null : lineGeometry(values, height, width);

  return (
    <Animated.View testID={testID} style={fade}>
      <View
        style={{ height }}
        onLayout={(event) => {
          const measured = event.nativeEvent.layout.width;
          if (measured > 0 && measured !== width) setWidth(measured);
        }}
      >
        <GridLines testID={testID} />
        {points.map((point, i) => (
          <View
            key={point.weekStart}
            testID={`${testID}-dot-${i}`}
            style={{
              position: 'absolute',
              left: geo === null ? `${((i + 0.5) / points.length) * 100}%` : geo.dots[i]!.x - DOT / 2,
              marginLeft: geo === null ? -DOT / 2 : 0,
              top: (geo === null ? yOf(values[i] ?? 0) : geo.dots[i]!.y) - DOT / 2,
              width: DOT,
              height: DOT,
              borderRadius: DOT_RADIUS,
              // slate.900 for the data; ACCENT on the current week alone.
              backgroundColor: i === last ? COLORS.accent : SEMANTIC.bg.dark,
            }}
          />
        ))}
        {geo?.segments.map((segment, i) => (
          <View
            key={i}
            testID={`${testID}-seg-${i}`}
            style={{
              position: 'absolute',
              left: segment.left,
              top: segment.top,
              width: segment.width,
              height: 2,
              backgroundColor: SEMANTIC.bg.dark, // slate.900 — the line is data too
              transform: [{ rotate: `${segment.angle}rad` }],
            }}
          />
        ))}
      </View>
      <RangeCaption left={formatDateEnIN(points[0]?.weekStart ?? '', nowYear)} right="this week" />
    </Animated.View>
  );
}
