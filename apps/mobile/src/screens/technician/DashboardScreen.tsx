/**
 * T1 Dashboard (UI/plan-2/04-TECHNICIAN.md §T1, 02-MOTION.md §6).
 * "What am I doing now, and is anything wrong?" in under three seconds,
 * first thing in the morning, in a van.
 *
 * Anatomy, exactly: the **navy frame** (greeting · the date · **three
 * figures only** — today's open, done today, overdue — `display` 32
 * Condensed, tabular; not six, not a chart) · the `TrackingHealthChip`,
 * always visible · NEXT — the single next job as a full `JobCard` with
 * *Navigate* (secondary) and *Start job* / *Arrive* (primary, the
 * screen's ONE accent) · LATER TODAY as compact rows.
 *
 * **The frame** (mobile UI overhaul, 2026-09-16) is the header block: it
 * is where the three figures live, and it is the only place in the app
 * that paints `FRAME.bg`. `FRAME`'s note in the shared tokens carries the
 * rules it obeys — structure, never data that only exists up there; the
 * accent as text and the active bar, never as a fill; inks measured on
 * slate.900. The figures themselves are colour-coded by what they mean
 * (`today` white, `done` green, `overdue` red) and **the red appears only
 * when there is something overdue**: a permanent red zero teaches the eye
 * to ignore red, which is the one ink this screen cannot afford to waste.
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
import { useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { runOnJS, useAnimatedReaction, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import type { TrackingHealth } from '@servgrid/shared';
import { DURATION, EASING, FRAME, SEMANTIC, SPACE } from '@servgrid/shared';
import { TrackingHealthChip, type LadderTarget } from '../../components/domain/TrackingHealthChip';
import { JobCard } from '../../components/domain/JobCard';
import { Button, EmptyState, SectionHeader } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import {
  dashboardFigures,
  istDayLabel,
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
 * **The number crosses to React as an integer (2026-09-16).** It used to
 * render the `SharedValue` itself as the Text's child — Reanimated's
 * "animated text", documented as the way to drive a number. On this build
 * that rendered the value the derived value was *created* with and never
 * re-read it: the figures sat on `0` while their colours — computed from
 * the same three numbers — were right, which is how the bug was found. A
 * count that shows a wrong number is worse than no count at all, so the
 * worklet now keeps the tween and pushes each rounded integer across with
 * `runOnJS`, and the Text stays an ordinary one. The easing, the duration
 * and the once-only rule are unchanged; only the hand-off moved.
 *
 * `animating ? tweened : value` is deliberate rather than a state reset:
 * a figure that is not animating renders the **prop**, so a refetch or a
 * second focus can never show a stale number through a state update that
 * has not landed yet.
 */
function CountUpFigure({
  value,
  color,
  animate,
  onCountUpStart,
  testID,
}: {
  value: number;
  /** The figure's ink on the navy frame — see `figureColourOf`. */
  color: string;
  animate: boolean;
  onCountUpStart?: () => void;
  testID: string;
}): React.ReactNode {
  const reducedMotion = useReducedMotion();
  const animating = animate && !reducedMotion;
  const progress = useSharedValue(animating ? 0 : 1);
  const drive = useRef(false);
  const [tweened, setTweened] = useState(0);

  useEffect(() => {
    if (!animating || drive.current) return;
    drive.current = true;
    onCountUpStart?.();
    progress.value = withTiming(1, { duration: DURATION.considered + 80, easing: ENTER_EASING });
  }, [animating, onCountUpStart, progress]);

  // The one integer the Text renders while the tween runs. Skipping equal
  // values keeps it to the ~24 frames the ramp actually changes on.
  useAnimatedReaction(
    () => Math.round(value * progress.value),
    (rounded, previous) => {
      if (rounded !== previous) runOnJS(setTweened)(rounded);
    },
  );

  return (
    <Text
      testID={testID}
      style={{
        ...textStyle('display'),
        color,
        fontVariant: ['tabular-nums'],
      }}
    >
      {String(animating ? tweened : value)}
    </Text>
  );
}

/**
 * A figure's ink on the frame. Colour here is **redundant with the
 * label**, never the message: `done` and `overdue` only take their
 * status ink when they are non-zero, because a permanently red zero is
 * how a colour stops being read (the same reasoning as `STATUS`, and the
 * measured inks are in `FRAME`'s note).
 */
function figureColourOf(kind: 'open' | 'done' | 'overdue', value: number): string {
  if (value === 0) return FRAME.text;
  if (kind === 'done') return FRAME.success;
  if (kind === 'overdue') return FRAME.danger;
  return FRAME.text;
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
      // No horizontal padding on the container: the frame is full-bleed,
      // and the body carries the gutter itself.
      contentContainerStyle={{ paddingBottom: SPACE[8] }}
      // Pull to refresh reads the server again; the platform control is
      // the indicator while it runs.
      refreshControl={<RefreshControl refreshing={deps.refreshing} onRefresh={deps.onRefresh} />}
    >
      {/* The frame: who he is, what day it is, and the three figures. It
          runs to the screen's edges — the route paints the same slate
          behind the status bar, so the header has no top edge. */}
      <View testID="dashboard-frame" style={styles.frame}>
        <Text style={{ ...textStyle('h1'), color: FRAME.text }} testID="dashboard-greeting">
          {`${istGreeting(deps.now)}, ${deps.name}`}
        </Text>
        <Text style={{ ...textStyle('caption'), color: FRAME.textMuted, marginTop: 2 }} testID="dashboard-date">
          {istDayLabel(deps.now)}
        </Text>

        <View style={styles.figuresRow}>
          <View style={styles.figure}>
            <CountUpFigure
              value={figures.open}
              color={figureColourOf('open', figures.open)}
              animate={animate}
              onCountUpStart={deps.onCountUpStart}
              testID="dashboard-figure-open"
            />
            <Text style={styles.figureLabel}>today</Text>
          </View>
          <View style={styles.figureDivider} />
          <View style={styles.figure}>
            <CountUpFigure
              value={figures.doneToday}
              color={figureColourOf('done', figures.doneToday)}
              animate={animate}
              onCountUpStart={deps.onCountUpStart}
              testID="dashboard-figure-done"
            />
            <Text style={styles.figureLabel}>done</Text>
          </View>
          <View style={styles.figureDivider} />
          <View style={styles.figure}>
            <CountUpFigure
              value={figures.overdue}
              color={figureColourOf('overdue', figures.overdue)}
              animate={animate}
              onCountUpStart={deps.onCountUpStart}
              testID="dashboard-figure-overdue"
            />
            <Text style={styles.figureLabel}>overdue</Text>
          </View>
        </View>
      </View>

      <View style={styles.body}>
        <TrackingHealthChip health={health} onFix={deps.onHealthFix} testID="dashboard-health" />

        {next === null ? null : (
          <View style={styles.section}>
            <SectionHeader label="Next" icon="jobs" testID="dashboard-next-label" />
            {/* The NEXT card does not animate in (§T1). */}
            <JobCard
              view={next}
              testID="dashboard-next-card"
              onPress={() => deps.onOpenJob(next)}
              actions={
                <View style={styles.actionsRow}>
                  <Button
                    label="Navigate"
                    icon="navigate"
                    variant="secondary"
                    onPress={() => deps.onNavigate(next)}
                    testID="dashboard-navigate"
                  />
                  {primary !== null ? (
                    <Button
                      label={primary.label}
                      icon="forward"
                      onPress={() => deps.onStartJob(next)}
                      testID="dashboard-primary-action"
                    />
                  ) : null}
                </View>
              }
            />
          </View>
        )}

        {later.length === 0 ? null : (
          <View style={styles.section}>
            <SectionHeader label="Later today" icon="clock" count={later.length} testID="dashboard-later-label" />
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

        {empty ? (
          <EmptyState
            message="No jobs assigned today."
            icon="jobs"
            actionLabel="Refresh"
            onAction={deps.onRefresh}
            testID="dashboard-empty"
          />
        ) : null}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  frame: {
    alignSelf: 'stretch',
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[4],
    paddingBottom: SPACE[5],
  },
  body: {
    alignSelf: 'stretch',
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[5],
    gap: SPACE[5],
  },
  section: {
    alignSelf: 'stretch',
    gap: SPACE[2],
  },
  figuresRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    marginTop: SPACE[4],
  },
  figure: {
    flex: 1,
    alignItems: 'flex-start',
  },
  figureDivider: {
    width: 1,
    height: 36,
    backgroundColor: FRAME.divider,
    marginHorizontal: SPACE[3],
  },
  figureLabel: {
    ...textStyle('caption'),
    color: FRAME.textMuted,
  },
  actionsRow: {
    flexDirection: 'row',
    justifyContent: 'space-between',
    alignItems: 'center',
    gap: SPACE[3],
  },
});

