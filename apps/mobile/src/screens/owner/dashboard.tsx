/**
 * O1 Dashboard (T4.8, UI/plan-2/07-OWNER.md §O1). The role's condition:
 * Sunday evening, reviewing the week, wanting the answer — is the
 * business running, and is anything wrong with the money? — without
 * opening four screens.
 *
 * **One job, two densities** (the card-vs-row rule — the review
 * checkpoint this phase measures every screen by; density comes from
 * context, set once by NavShell, never a platform check here):
 *
 * - **Phone (`field`):** four stat CARDS stacked, `display` 32 Condensed,
 *   label beneath; the two charts full width at 180 tall; then Needs
 *   attention as rows.
 * - **Desk (`desk`):** a 4-up stat ROW at `displayLg` 44 — figures on a
 *   desk are a row, not a card grid; the charts side by side at 320
 *   tall; Needs attention as a table to the right.
 *
 * **Charts: two only** (`charts.tsx`) — bars for jobs per day, a line for
 * revenue per week; slate.900 data, slate.200 grid, accent on the
 * current period alone.
 *
 * **Needs attention earns the screen.** An empty feed says so
 * explicitly — "Nothing needs attention." — because blank space reads as
 * a broken screen and the owner must be able to tell "no problems" from
 * "not loaded". The three states are distinct elements: loading renders
 * skeletons at the content's exact geometry (200ms delay, §7), a failed
 * read renders the error with Retry, an empty feed renders the line.
 *
 * **Offline (web):** the danger banner, and the figures grey to
 * `text.disabled` (§O1 States) — this owner is online-only, so offline
 * means the numbers are not live.
 *
 * Motion: figures and charts appear with their data at full opacity and
 * only a *changed* value cross-fades 140ms — no count-up, no draw-in.
 *
 * Pure UI over injected data; `useOwnerDashboard` owns the reads.
 */
import { useEffect, useRef } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { DESK, DURATION, EASING, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, EmptyState, PageHeader, Panel, Skeleton, pageContentStyle, useDensity } from '../../components/ui';
import { useSkeleton } from '../../components/ui/Skeleton';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import { AttentionRows } from './AttentionRows';
import { AttentionTable } from './AttentionTable';
import { CHART_HEIGHT_DESK, CHART_HEIGHT_PHONE } from './charts';
// The two long-view charts come through the web/native seam (OW.5):
// Recharts on the desk, the hand-drawn pair on a phone.
import { JobsPerDayBarChart, RevenuePerWeekLineChart } from './trendCharts';
import type { AttentionRowVm, JobsPerDayPoint, OwnerFigure, RevenuePerWeekPoint } from './model';

/** §O1: the empty feed's words, verbatim — never paraphrased, never blank. */
export const NOTHING_NEEDS_ATTENTION = 'Nothing needs attention.';

/** §O1 States/offline: the banner's words — the owner's figures are not live. */
export const OFFLINE_BANNER_MESSAGE = 'No connection. Figures are not live.';

/**
 * The console greets the owner by name (owner, 2026-09-17). "Welcome
 * back" and not "Good morning": the owner opens this console at whatever
 * hour his day ended, and a clock-dependent greeting is wrong exactly
 * when he is tired. Empty when the name has not resolved yet — the
 * header's shape must not jump when it lands.
 */
export function welcomeGreeting(name: string): string {
  const trimmed = name.trim();
  return trimmed === '' ? '' : `Welcome back, ${trimmed}`;
}

export interface OwnerDashboardDeps {
  /** Injectable clock — chart captions and relative times are judged by it. */
  now: Date;
  /** The signed-in owner's name, for the header's greeting. Empty until it resolves. */
  ownerName: string;
  offline: boolean;
  /** The four figures, display-formatted; null = not loaded yet. */
  figures: OwnerFigure[] | null;
  jobsPerDay: JobsPerDayPoint[] | null;
  revenuePerWeek: RevenuePerWeekPoint[] | null;
  /**
   * The performance charts (OW.3) — passed in by the route because that
   * section owns its own read and its own range. A slot keeps this screen
   * pure and its tests unchanged.
   */
  performanceSlot?: React.ReactNode;
  /** The figures and charts share one read; they fail together. */
  dashboardError: string | null;
  /** Consequence-ordered attention rows; null = not loaded, [] = genuinely clear. */
  attention: AttentionRowVm[] | null;
  attentionError: string | null;
  onRetry: () => void;
  onOpenRow: (target: string) => void;
}

/**
 * One figure. Phone: a stat card — raised ground, hairline border, square
 * corners (the docket's signature) — value in `display` 32 Condensed
 * tabular, label beneath, then the caption naming what populates it
 * (what a new deployment's `0` sits on). Desk: a cell of the 4-up stat
 * row, `displayLg` 44, no card — a row, never a grid of cards.
 */
function Figure({
  figure,
  desk,
  offline,
}: {
  figure: OwnerFigure;
  desk: boolean;
  offline: boolean;
}): React.ReactNode {
  const colour = offline ? SEMANTIC.text.disabled : SEMANTIC.text.primary;

  const enter = easing(EASING.enter);
  const opacity = useSharedValue(1);
  const lastValue = useRef(figure.value);

  useEffect(() => {
    if (lastValue.current === figure.value) return;
    lastValue.current = figure.value;
    opacity.value = 0;
    opacity.value = withTiming(1, { duration: DURATION.quick, easing: enter });
  }, [enter, figure.value, opacity]);

  const fade = useAnimatedStyle(() => ({ opacity: opacity.value }));

  return (
    <Animated.View
      testID={`owner-figure-${figure.key}`}
      style={[desk ? styles.figureCell : styles.statCard, fade]}
    >
      <Text
        testID={`owner-figure-${figure.key}-value`}
        style={{
          ...textStyle(desk ? 'displayLg' : 'display'),
          color: colour,
          fontVariant: ['tabular-nums'],
        }}
      >
        {figure.value}
      </Text>
      <Text testID={`owner-figure-${figure.key}-label`} style={styles.figureLabel}>
        {figure.label}
      </Text>
      <Text testID={`owner-figure-${figure.key}-caption`} style={styles.figureCaption}>
        {figure.caption}
      </Text>
    </Animated.View>
  );
}

function FigureSkeleton({ desk }: { desk: boolean }): React.ReactNode {
  if (desk) {
    return (
      <View style={{ flexDirection: 'row', gap: SPACE[6] }} testID="owner-figures-skeleton">
        {['a', 'b', 'c', 'd'].map((k) => (
          <Skeleton key={k} width={`${100 / 4 - 2}%`} height={72} radius={0} testID={`owner-figure-skeleton-${k}`} />
        ))}
      </View>
    );
  }
  return (
    <View style={{ gap: SPACE[3] }} testID="owner-figures-skeleton">
      {['a', 'b', 'c', 'd'].map((k) => (
        <Skeleton key={k} width="100%" height={72} radius={0} testID={`owner-figure-skeleton-${k}`} />
      ))}
    </View>
  );
}

/** The section that earns the screen. Three states, three distinct elements. */
function AttentionSection({
  deps,
  desk,
  showSkeleton,
}: {
  deps: OwnerDashboardDeps;
  desk: boolean;
  showSkeleton: boolean;
}): React.ReactNode {
  return (
    <Panel testID="owner-attention">
      <Text style={styles.sectionLabel} testID="owner-attention-heading">
        NEEDS ATTENTION
      </Text>
      {deps.attentionError !== null ? (
        // A failed read is NOT an empty feed: the error says what broke and
        // offers Retry — "no problems" and "not loaded" must not look alike.
        <EmptyState
          message={deps.attentionError}
          actionLabel="Retry"
          onAction={deps.onRetry}
          testID="owner-attention-error"
        />
      ) : showSkeleton ? (
        <View style={{ gap: SPACE[2] }} testID="owner-attention-skeleton">
          <Skeleton width="100%" height={56} radius={0} testID="owner-attention-skeleton-row" />
          <Skeleton width="100%" height={56} radius={0} testID="owner-attention-skeleton-row" />
          <Skeleton width="100%" height={56} radius={0} testID="owner-attention-skeleton-row" />
        </View>
      ) : deps.attention !== null && deps.attention.length === 0 ? (
        <EmptyState message={NOTHING_NEEDS_ATTENTION} testID="owner-attention-empty" />
      ) : deps.attention !== null ? (
        desk ? (
          // The bound keeps an 80-row feed from stretching the page into
          // a blank half-screen beside the short charts column — the
          // table scrolls inside its card instead (2026-09-16 walk).
          <View style={{ height: 560 }}>
            <AttentionTable rows={deps.attention} onOpen={deps.onOpenRow} />
          </View>
        ) : (
          <AttentionRows rows={deps.attention} onOpen={deps.onOpenRow} testIDPrefix="owner-attention-row" />
        )
      ) : null}
    </Panel>
  );
}

/**
 * "Monday, 16 September" — the console answers for a day, and saying
 * which one is the difference between a figure and a figure you trust.
 * IST, like every business date in the product.
 */
function dashboardSubtitle(now: Date): string {
  return new Intl.DateTimeFormat('en-IN', {
    timeZone: 'Asia/Kolkata',
    weekday: 'long',
    day: 'numeric',
    month: 'long',
  }).format(now);
}

export function OwnerDashboardScreen(deps: OwnerDashboardDeps): React.ReactNode {
  const desk = useDensity() === 'desk';
  const nowYear = deps.now.getFullYear();
  const chartHeight = desk ? CHART_HEIGHT_DESK : CHART_HEIGHT_PHONE;

  const figuresLoading = deps.figures === null && deps.dashboardError === null;
  const chartsLoading = deps.jobsPerDay === null && deps.revenuePerWeek === null && deps.dashboardError === null;
  const attentionLoading = deps.attention === null && deps.attentionError === null;
  const showFigureSkeleton = useSkeleton(figuresLoading);
  const showChartSkeleton = useSkeleton(chartsLoading);
  const showAttentionSkeleton = useSkeleton(attentionLoading);

  const charts =
    deps.jobsPerDay === null || deps.revenuePerWeek === null ? null : (
      <View
        testID="owner-charts"
        style={desk ? { flexDirection: 'row', gap: DESK.page.gap } : { gap: SPACE[5] }}
      >
        <View style={desk ? { flex: 1 } : null} testID="owner-chart-jobs-block">
          <Panel title="Jobs per day — 30 days">
            <JobsPerDayBarChart
              points={deps.jobsPerDay}
              height={chartHeight}
              nowYear={nowYear}
              testID="owner-chart-jobs"
            />
          </Panel>
        </View>
        <View style={desk ? { flex: 1 } : null} testID="owner-chart-revenue-block">
          <Panel title="Revenue per week — 12 weeks">
            <RevenuePerWeekLineChart
              points={deps.revenuePerWeek}
              height={chartHeight}
              nowYear={nowYear}
              testID="owner-chart-revenue"
            />
          </Panel>
        </View>
      </View>
    );

  const greeting = welcomeGreeting(deps.ownerName);

  return (
    <ScrollView
      testID="owner-dashboard"
      // On the desk the page ground is the shell's (NavShell paints it);
      // on a phone this screen still owns its background.
      style={{ flex: 1, backgroundColor: desk ? 'transparent' : SEMANTIC.bg.app }}
      contentContainerStyle={pageContentStyle(desk)}
    >
      <PageHeader
        title="Dashboard"
        greeting={greeting === '' ? undefined : greeting}
        subtitle={dashboardSubtitle(deps.now)}
        testID="owner"
      />

      {deps.offline ? (
        <Banner tone="danger" message={OFFLINE_BANNER_MESSAGE} testID="owner-offline-banner" />
      ) : null}

      {deps.dashboardError !== null ? (
        <EmptyState
          message={deps.dashboardError}
          actionLabel="Retry"
          onAction={deps.onRetry}
          testID="owner-dashboard-error"
        />
      ) : null}

      {showFigureSkeleton ? (
        <FigureSkeleton desk={desk} />
      ) : deps.figures !== null ? (
        <View
          testID="owner-figures"
          style={desk ? { flexDirection: 'row', gap: DESK.page.gap } : { gap: SPACE[3] }}
        >
          {deps.figures.map((figure) =>
            desk ? (
              // Each figure on its own card: fourwhite  cards on the page's
              // slate ground is the row that used to be four bare numbers
              // floating in white space.
              <View key={figure.key} style={{ flex: 1 }}>
                <Panel>
                  <Figure figure={figure} desk={desk} offline={deps.offline} />
                </Panel>
              </View>
            ) : (
              <Figure key={figure.key} figure={figure} desk={desk} offline={deps.offline} />
            ),
          )}
        </View>
      ) : null}

      {deps.performanceSlot ?? null}

      {/* Both densities agree now: the charts, then Needs attention in its
      own full-width row beneath them. The desk used to hold the feed in a
      600px column beside the charts, which read as a sidebar rather than
      the section that earns the screen — and it starved the charts of the
      width they were just given (owner, 2026-09-17). */}
      {showChartSkeleton ? (
        <Skeleton width="100%" height={chartHeight} radius={0} testID="owner-charts-skeleton" />
      ) : (
        charts
      )}
      <AttentionSection deps={deps} desk={desk} showSkeleton={showAttentionSkeleton} />
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  statCard: {
    alignSelf: 'stretch',
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    padding: SPACE[4],
    gap: 2,
  },
  figureCell: {
    flex: 1,
    alignItems: 'flex-start',
    gap: 2,
  },
  figureLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.primary,
  },
  figureCaption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  section: {
    alignSelf: 'stretch',
    gap: SPACE[1],
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  chartLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginBottom: SPACE[2],
  },
});
