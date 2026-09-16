/**
 * T1 Dashboard (UI/plan-2/04-TECHNICIAN.md §T1, 02-MOTION.md §6).
 * "What am I doing now, and is anything wrong?" in under three seconds,
 * first thing in the morning, in a van.
 *
 * Anatomy, exactly: the **navy frame** (greeting · the date · **three
 * figures only** — today's open, done today, overdue, `display` 32
 * Condensed, tabular; not six, not a chart) · **the active job**, when he
 * is on one · **TODAY** · **LATER** (tomorrow and beyond).
 *
 * **One job at a time (Yashas, 2026-09-16).** A technician travels to one
 * site, so the screen carries exactly one job he can act on: the job he
 * has already started (`activeJobOf` — on site, else travelling) is
 * raised into `ActiveJobPanel` with *Call*, *Navigate* and the next
 * status write, and the lists below it are for looking, not for
 * starting. When no job is active the same slot is filled by today's
 * first job as a full card with *Navigate* and *Start job*, so the screen
 * always has one actionable job and never two. That is also why no button
 * here is ever disabled for being "second": the second job simply has no
 * start button on the dashboard. The rule is taught where he could
 * otherwise break it — the job detail's thumb bar, which shows the reason
 * (`busyWithSentence`).
 *
 * **The sections are the day, not the clock (Yashas).** `TODAY` is every
 * open job of today in today's order — `bucketOf` carries yesterday's
 * unfinished work into today, so the overdue jobs he still owes are at
 * the top where they belong — and `LATER` is tomorrow onwards, each row
 * carrying its day. Together they replace the old NEXT / LATER TODAY
 * pair, which split one day in two and left tomorrow nowhere to be seen.
 *
 * **The tracking strip is gone from this screen (Yashas, 2026-09-16:
 * "remove the background permission fix error").** It nagged a red
 * "Background permission missing — fix" over work he could not do
 * anything about at that moment; the same four checks, with their fixes,
 * remain one tap away on Profile → Tracking permissions. The dashboard is
 * the day's work, and §T1's rule about what does not belong on it now
 * includes the health strip.
 *
 * **The server's work read is the source** (PLAN-FRONTEND.md §4,
 * online-only): jobs arrive as props from the route's in-memory query,
 * and this screen renders only once they have. A lost connection is the
 * no-connection gate's to show, never this screen's. Pull to refresh
 * reads the server again.
 *
 * Not on this screen, deliberately: revenue, charts, team activity,
 * motivational copy, an earnings figure — §T1 names the dashboard as
 * where the read-back temptation lands first, and `dashboard.test.tsx`
 * holds the whole tree against any currency symbol.
 *
 * Motion (§T1): the figures count up from zero on **first focus only**,
 * 380ms `enter`, tabular so nothing reflows; on subsequent focus they
 * are already correct. The cards do not animate in. The count-up is the
 * one piece of motion here that is not load-bearing — if it is ever
 * janky, delete it (the screens do not depend on it).
 */
import { useEffect, useRef, useState } from 'react';
import { RefreshControl, ScrollView, StyleSheet, Text, View } from 'react-native';
import { runOnJS, useAnimatedReaction, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { DURATION, EASING, FRAME, SEMANTIC, SPACE } from '@servgrid/shared';
import { ActiveJobPanel } from '../../components/domain/ActiveJobPanel';
import { JobCard } from '../../components/domain/JobCard';
import { Button, EmptyState, SectionHeader } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import {
  activeJobOf,
  dashboardFigures,
  dayLabelOf,
  istDayLabel,
  istGreeting,
  laterJobsOf,
  primaryActionOf,
  todayJobsOf,
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
  /** A read of the server is running (pull to refresh). */
  refreshing: boolean;
  /** Pull to refresh reads the server again. */
  onRefresh: () => void;
  onStartJob: (view: JobView) => void;
  onNavigate: (view: JobView) => void;
  /** Dials the job's contact (`tel:`) — no number, no call. */
  onCall: (view: JobView) => void;
  onOpenJob: (view: JobView) => void;
  /** The active job's own way to finish: the complete sheet. */
  onCompleteJob: (view: JobView) => void;
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
  const active = activeJobOf(deps.jobs, deps.now);
  // TODAY is every today job, and the active one is not repeated in it:
  // the panel above is where he acts, the list below is where he looks.
  const today = todayJobsOf(deps.jobs, deps.now).filter((v) => v.job.id !== active?.job.id);
  const later = laterJobsOf(deps.jobs, deps.now);

  // The screen's one actionable job: the job he is on, else today's first.
  const focus = active ?? today[0] ?? null;
  const focusIsActive = active !== null && focus !== null && focus.job.id === active.job.id;
  const advance = focus === null ? null : primaryActionOf(focus.job.status);
  const focusPrimary =
    focus === null
      ? null
      : advance !== null
        ? { label: advance.label, onPress: () => deps.onStartJob(focus) }
        : focus.job.status === 'in_progress'
          ? { label: 'Complete job', onPress: () => deps.onCompleteJob(focus) }
          : null;
  // When the panel is the active job, the list below starts after it.
  const restToday = focusIsActive ? today : today.slice(1);
  const empty = focus === null && today.length === 0 && later.length === 0;

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
        {/* The one job he can act on. The panel when he has already
            started it; today's first job as a docket when he has not —
            the same slot either way, so the screen never offers two
            starts and never offers none while there is work. */}
        {focus === null ? null : focusIsActive ? (
          <ActiveJobPanel
            view={focus}
            dayLabel={dayLabelOf(focus.job.scheduledFor, deps.now)}
            testID="dashboard-active-card"
            onPress={() => deps.onOpenJob(focus)}
            onCall={() => deps.onCall(focus)}
            onNavigate={() => deps.onNavigate(focus)}
            primary={focusPrimary}
          />
        ) : (
          <JobCard
            view={focus}
            dayLabel={dayLabelOf(focus.job.scheduledFor, deps.now)}
            testID="dashboard-next-card"
            onPress={() => deps.onOpenJob(focus)}
            actions={
              <View style={styles.actionsRow}>
                <Button
                  label="Navigate"
                  icon="navigate"
                  variant="secondary"
                  onPress={() => deps.onNavigate(focus)}
                  testID="dashboard-navigate"
                />
                {focusPrimary === null ? null : (
                  <Button
                    label={focusPrimary.label}
                    icon="forward"
                    onPress={focusPrimary.onPress}
                    testID="dashboard-primary-action"
                  />
                )}
              </View>
            }
          />
        )}

        {restToday.length === 0 ? null : (
          <View style={styles.section}>
            <SectionHeader label="Today" icon="clock" count={restToday.length} testID="dashboard-today-label" />
            {restToday.map((view) => (
              <JobCard
                key={view.job.id}
                view={view}
                compact
                dayLabel={dayLabelOf(view.job.scheduledFor, deps.now)}
                testID={`dashboard-today-${view.job.id}`}
                onPress={() => deps.onOpenJob(view)}
              />
            ))}
          </View>
        )}

        {later.length === 0 ? null : (
          <View style={styles.section}>
            <SectionHeader label="Later" icon="calendar" count={later.length} testID="dashboard-later-label" />
            {later.map((view) => (
              <JobCard
                key={view.job.id}
                view={view}
                compact
                dayLabel={dayLabelOf(view.job.scheduledFor, deps.now)}
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

