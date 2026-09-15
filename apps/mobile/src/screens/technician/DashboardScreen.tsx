/**
 * T1 Dashboard (UI/plan-2/04-TECHNICIAN.md §T1, 02-MOTION.md §6).
 * "What am I doing now, and is anything wrong?" in under three seconds,
 * first thing in the morning, in a van.
 *
 * Anatomy, exactly: greeting · **three figures only**
 * (today's open, done today, overdue — `display` 32 Condensed, tabular;
 * not six, not a chart) · the `TrackingHealthChip`, always visible ·
 * NEXT — the single next job as a full `JobCard` with *Navigate*
 * (secondary) and *Start job* / *Arrive* (primary, the screen's ONE
 * accent) · LATER TODAY as compact rows.
 *
 * **The server's work read is the source** (PLAN-FRONTEND.md §4,
 * online-only): jobs arrive as props from the route's in-memory query,
 * and this screen renders only once they have. A missing health answer
 * raises **no banner** — the chip degrades — and a lost connection is
 * the no-connection gate's to show, never this screen's. Pull to refresh
 * reads the server again.
 *
 * Not on this screen, deliberately: revenue, charts, team activity,
 * motivational copy, an earnings figure — §T1 names the dashboard as
 * where the read-back temptation lands first, and `dashboard.test.tsx`
 * holds the whole tree against any currency symbol.
 *
 * Motion (§T1): the figures count up from zero on **first focus only**,
 * 380ms `enter`, tabular so nothing reflows; on subsequent focus they
 * are already correct. The NEXT card does not animate in. The count-up
 * is the one piece of motion here that is not load-bearing — if it is
 * ever janky, delete it (the screens do not depend on it).
 */
import { useEffect, useRef } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useDerivedValue, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import type { TrackingHealth } from '@servgrid/shared';
import { DURATION, EASING, SEMANTIC, SPACE } from '@servgrid/shared';
import { TrackingHealthChip, type LadderTarget } from '../../components/domain/TrackingHealthChip';
import { JobCard } from '../../components/domain/JobCard';
import { Button, EmptyState } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import {
  dashboardFigures,
  istGreeting,
  laterTodayOf,
  nextJobOf,
  primaryActionOf,
  type JobView,
} from './jobView';

const ENTER_EASING = easing(EASING.enter);

export interface DashboardDeps {
  /** His name, for the greeting. */
  name: string;
  /** His jobs from the server's work read, joined to their customers. */
  jobs: JobView[];
  /** Job id → when the server closed a completed job. */
  completedAtById: Record<string, string>;
  /** Last known tracking health; null degrades to "never reported". */
  health: TrackingHealth | null;
  /** Red and amber only — into the permission ladder (§T7). */
  onHealthFix?: (target: LadderTarget) => void;
  /** A read of the server is running (pull to refresh). */
  refreshing: boolean;
  /** Pull to refresh reads the server again. */
  onRefresh: () => void;
  onStartJob: (view: JobView) => void;
  onNavigate: (view: JobView) => void;
  onOpenJob: (view: JobView) => void;
  /** Injectable clock — IST "today" is computed from it. */
  now: Date;
  /**
   * The figures count up on FIRST FOCUS only (§T1). The screen renders
   * the tween when this is true and final values when it is false; the
   * ROUTE owns the focus semantics — it passes true for the first focus
   * of a mounted instance and false afterwards, so a second focus finds
   * the figures already correct and no re-drive ever happens.
   */
  animateFigures?: boolean;
  /** Fires when the count-up drives — the test seam for "runs once". */
  onCountUpStart?: () => void;
}

/**
 * One of the three figures. `display` 32 Condensed with tabular figures —
 * a number changing must never reflow its neighbours (§T1). The count-up
 * runs from zero on first focus only, 380ms `enter`; afterwards the
 * figure is already correct. Reduced motion skips straight to the value —
 * movement removed, feedback kept (02-MOTION.md §10).
 *
 * The rendered child is the SharedValue itself, which Reanimated drives
 * as live text. The vitest seam's `useDerivedValue` returns a plain,
 * already-final `{ value }` box instead — such boxes are unwrapped once
 * here, so tests read the resolved figure; the prototype getter is what
 * tells a real SharedValue from the stub's literal.
 */
function CountUpFigure({
  value,
  animate,
  onCountUpStart,
  testID,
}: {
  value: number;
  animate: boolean;
  onCountUpStart?: () => void;
  testID: string;
}): React.ReactNode {
  const reducedMotion = useReducedMotion();
  const progress = useSharedValue(animate && !reducedMotion ? 0 : 1);
  const drive = useRef(false);

  useEffect(() => {
    if (!animate || reducedMotion || drive.current) return;
    drive.current = true;
    onCountUpStart?.();
    progress.value = withTiming(1, { duration: DURATION.considered + 80, easing: ENTER_EASING });
  }, [animate, onCountUpStart, progress, reducedMotion]);

  const shown = useDerivedValue(() => String(Math.round(value * progress.value)));
  const live =
    typeof shown === 'object' &&
    shown !== null &&
    Object.getOwnPropertyDescriptor(Object.getPrototypeOf(shown), 'value')?.get !== undefined;

  return (
    <Animated.Text
      testID={testID}
      style={{
        ...textStyle('display'),
        color: SEMANTIC.text.primary,
        fontVariant: ['tabular-nums'],
      }}
    >
      {live ? (shown as unknown as string) : shown.value}
    </Animated.Text>
  );
}

export function DashboardScreen(deps: DashboardDeps): React.ReactNode {
  const animate = deps.animateFigures ?? true;

  const figures = dashboardFigures(deps.jobs, deps.completedAtById, deps.now);
  const next = nextJobOf(deps.jobs, deps.now);
  const later = laterTodayOf(deps.jobs, deps.now);
  const primary = next === null ? null : primaryActionOf(next.job.status);
  const empty = next === null && later.length === 0;

  // The chip's health: when nothing is known (cold start, offline, or
  // the endpoint has never answered), the chip honestly reports tracking
  // as never reported — it never hides, and it never raises a banner.
  const health: TrackingHealth =
    deps.health ??
    ({
      employeeId: '',
      employeeName: deps.name,
      role: 'technician',
      deviceId: null,
      locationPermission: null,
      notificationsEnabled: null,
      lastPingAt: null,
      minutesSince: null,
      health: 'never_reported',
    } satisfies TrackingHealth);

  return (
    <ScrollView
      testID="dashboard-screen"
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      contentContainerStyle={{ padding: SPACE[4], paddingBottom: SPACE[8], gap: SPACE[4] }}
      // Pull to refresh reads the server again; the platform control is
      // the indicator while it runs.
      refreshControl={<RefreshControl refreshing={deps.refreshing} onRefresh={deps.onRefresh} />}
    >
      <View style={styles.headerRow}>
        <Text style={{ ...textStyle('h1'), color: SEMANTIC.text.primary, flex: 1 }} testID="dashboard-greeting">
          {`${istGreeting(deps.now)}, ${deps.name}`}
        </Text>
      </View>

      <View style={styles.figuresRow}>
        <View style={styles.figure}>
          <CountUpFigure value={figures.open} animate={animate} onCountUpStart={deps.onCountUpStart} testID="dashboard-figure-open" />
          <Text style={styles.figureLabel}>today</Text>
        </View>
        <View style={styles.figure}>
          <CountUpFigure value={figures.doneToday} animate={animate} onCountUpStart={deps.onCountUpStart} testID="dashboard-figure-done" />
          <Text style={styles.figureLabel}>done</Text>
        </View>
        <View style={styles.figure}>
          <CountUpFigure value={figures.overdue} animate={animate} onCountUpStart={deps.onCountUpStart} testID="dashboard-figure-overdue" />
          <Text style={styles.figureLabel}>overdue</Text>
        </View>
      </View>

      <TrackingHealthChip health={health} onFix={deps.onHealthFix} testID="dashboard-health" />

      {next === null ? null : (
        <View style={{ alignSelf: 'stretch', gap: SPACE[2] }}>
          <Text style={styles.sectionLabel} testID="dashboard-next-label">
            NEXT
          </Text>
          {/* The NEXT card does not animate in (§T1). */}
          <JobCard
            view={next}
            testID="dashboard-next-card"
            onPress={() => deps.onOpenJob(next)}
            actions={
              <View style={styles.actionsRow}>
                <Button label="Navigate" variant="secondary" onPress={() => deps.onNavigate(next)} testID="dashboard-navigate" />
                {primary !== null ? (
                  <Button label={primary.label} onPress={() => deps.onStartJob(next)} testID="dashboard-primary-action" />
                ) : null}
              </View>
            }
          />
        </View>
      )}

      {later.length === 0 ? null : (
        <View style={{ alignSelf: 'stretch', gap: SPACE[2] }}>
          <Text style={styles.sectionLabel} testID="dashboard-later-label">
            LATER TODAY
          </Text>
          {later.map((view) => (
            <JobCard
              key={view.job.id}
              view={view}
              compact
              testID={`dashboard-later-${view.job.id}`}
              onPress={() => deps.onOpenJob(view)}
            />
          ))}
        </View>
      )}

      {empty ? <EmptyState message="No jobs assigned today." actionLabel="Refresh" onAction={deps.onRefresh} testID="dashboard-empty" /> : null}
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
  },
  figuresRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    gap: SPACE[6],
  },
  figure: {
    alignItems: 'flex-start',
    minWidth: 64,
  },
  figureLabel: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACE[3],
    marginTop: SPACE[3],
  },
});

