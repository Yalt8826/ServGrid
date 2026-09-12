/**
 * D1 Dashboard (UI/plan-2/05-DISPATCHER.md §D1, PLAN-FRONTEND.md §9).
 * "What is wrong right now, and who is free?" before the phone rings
 * again — 09:15 Monday, two technicians have called in, a customer on
 * hold.
 *
 * Anatomy, exactly: **Overdue leads**, in `feedback.danger`, the largest
 * figure on the screen — the only number here that represents a promise
 * already broken; unassigned work is a queue, overdue work is a customer
 * who was told a day. Then unassigned, today, done. The one primary
 * action (+ Dispatch a job). TECHNICIAN LOAD as live rows with inline
 * bars — the same `TechnicianLoadRow` the assignment picker uses — with
 * a stale tracker's warning inline, read from `location.health` (health
 * value + last-ping age; never a coordinate). NEEDS ATTENTION: overdue
 * jobs, then unassigned, then jobs still `assigned` past their scheduled
 * time — someone was due there and has not set off.
 *
 * **Not** "jobs rejected from a technician's outbox": outbox rejections
 * live on the handset and the server keeps no queue of its own — there
 * is nothing for that section to read, so none was designed.
 *
 * **Offline is different here.** This is the one role where stale data
 * is dangerous, because dispatch decisions are made from it: a
 * full-width `feedback.danger` banner — "No connection. This screen is
 * not live." — and the figures grey to `text.disabled`. The technician's
 * dashboard is the deliberate opposite (no banner, the mirror is the
 * source); dashboard.test.tsx on each side proves the pair.
 *
 * Motion (§D1): the load bars draw on focus, staggered 30ms; the
 * figures do NOT count up — a dispatcher returning twenty times a day
 * does not want a performance — they cross-fade 140ms on change.
 *
 * Not on this screen: no revenue, no completion amounts, no cash
 * figures — nothing here is money, so `MoneyGate` wraps nothing.
 */
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withTiming } from 'react-native-reanimated';

import { DURATION, EASING, SEMANTIC, SPACE } from '@servgrid/shared';
import { TechnicianLoadRow, type TechnicianHealthState } from '../../components/domain/TechnicianLoadRow';
import { Banner, Button, EmptyState } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';

/** §D1, States/offline: the banner's words, verbatim — never paraphrased. */
export const OFFLINE_BANNER_MESSAGE = 'No connection. This screen is not live.';

export type DispatcherFigureKey = 'overdue' | 'unassigned' | 'today' | 'done';

/** One figure, in display order — the supplier puts OVERDUE FIRST. */
export interface DispatcherFigure {
  key: DispatcherFigureKey;
  label: string;
  value: number;
}

/** One TECHNICIAN LOAD row, already joined to his tracking health. */
export interface DashboardLoadRow {
  employeeId: string;
  name: string;
  /** His open jobs — the count and the bar both show it. */
  load: number;
  health: TechnicianHealthState | null;
}

/** One NEEDS ATTENTION row, in the words the dispatcher acts on. */
export interface AttentionJob {
  id: string;
  jobNumber: string;
  title: string;
  customerName: string;
  /** The technician on it, when there is one. */
  technician: string | null;
  /** The why — "3 days overdue", "due 09:15, not set off", "no date yet". */
  note: string;
}

export interface AttentionSection {
  key: 'overdue' | 'unassigned' | 'late';
  heading: string;
  jobs: AttentionJob[];
}

export type DashboardSection = 'figures' | 'load' | 'attention';

export interface DispatcherDashboardDeps {
  /** Injectable clock — "today", overdue ages and notes are judged by it. */
  now: Date;
  /** The header's date, `Mon 6 Sep` in the anatomy. */
  todayLabel: string;
  offline: boolean;
  /** The four figures in display order; null = not loaded yet. */
  figures: DispatcherFigure[] | null;
  figuresError: string | null;
  load: DashboardLoadRow[] | null;
  loadError: string | null;
  /** Overdue, then unassigned, then assigned-past-time. */
  sections: AttentionSection[] | null;
  sectionsError: string | null;
  onRetry: (section: DashboardSection) => void;
  onOpenJob: (jobId: string) => void;
  onDispatch: () => void;
}

/**
 * One of the four figures. Overdue is the LARGEST number on the screen
 * (`displayLg` 44 against 32) and the only one in danger colour — a
 * broken promise leads. Zero is information: the figure renders `0` in
 * `text.secondary`, not an absent element. Offline dims every figure to
 * `text.disabled`.
 *
 * Motion (§D1): the value is bound straight to the text — there is no
 * count-up to skip — and a CHANGE cross-fades the figure in over 140ms
 * (`quick`). First render does not fade: the figures are already
 * correct by the time the data lands, and a dispatcher returning twenty
 * times a day gets no performance.
 */
function Figure({ figure, offline, testID }: { figure: DispatcherFigure; offline: boolean; testID: string }): React.ReactNode {
  const isOverdue = figure.key === 'overdue';
  const colour = offline
    ? SEMANTIC.text.disabled
    : figure.value === 0
      ? SEMANTIC.text.secondary
      : isOverdue
        ? SEMANTIC.feedback.danger
        : SEMANTIC.text.primary;

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
    <Animated.View testID={testID} style={[styles.figure, fade]}>
      <Text
        testID={`${testID}-value`}
        style={{
          ...(isOverdue ? textStyle('displayLg') : textStyle('display')),
          color: colour,
          fontVariant: ['tabular-nums'],
        }}
      >
        {figure.value}
      </Text>
      <Text style={styles.figureLabel}>{figure.label}</Text>
    </Animated.View>
  );
}

/** One NEEDS ATTENTION row — a job line, not a card; the row itself is the tap target. */
function AttentionRow({
  job,
  onPress,
  testID,
}: {
  job: AttentionJob;
  onPress: (jobId: string) => void;
  testID: string;
}): React.ReactNode {
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      onPress={() => onPress(job.id)}
      style={styles.attentionRow}
    >
      <View style={styles.attentionRail} />
      <View style={styles.attentionBody}>
        <Text numberOfLines={1} style={[textStyle('bodyStrong'), styles.attentionTitle]}>
          {`${job.jobNumber} · ${job.title}`}
        </Text>
        <Text numberOfLines={1} style={[textStyle('caption'), styles.attentionMeta]}>
          {job.technician === null ? job.customerName : `${job.customerName} · ${job.technician}`}
        </Text>
      </View>
      <Text numberOfLines={1} style={[textStyle('caption'), styles.attentionNote]}>
        {job.note}
      </Text>
    </Pressable>
  );
}

export function DispatcherDashboardScreen(deps: DispatcherDashboardDeps): React.ReactNode {
  const busiest = deps.load === null ? 0 : Math.max(0, ...deps.load.map((row) => row.load));
  const liveSections = deps.sections === null ? [] : deps.sections.filter((s) => s.jobs.length > 0);
  const nothingNeedsAttention =
    !deps.sectionsError && deps.sections !== null && liveSections.length === 0;

  return (
    <ScrollView
      testID="dispatch-dashboard"
      style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
      contentContainerStyle={{ padding: SPACE[4], paddingBottom: SPACE[8], gap: SPACE[4] }}
    >
      <View style={styles.headerRow}>
        <Text style={{ ...textStyle('h1'), color: SEMANTIC.text.primary, flex: 1 }} testID="dispatch-title">
          Dispatch
        </Text>
        <Text style={[textStyle('caption'), styles.dateLabel]} testID="dispatch-date">
          {deps.todayLabel}
        </Text>
      </View>

      {deps.offline ? (
        <Banner tone="danger" message={OFFLINE_BANNER_MESSAGE} testID="dispatch-offline-banner" />
      ) : null}

      {deps.figuresError !== null ? (
        <EmptyState
          message={deps.figuresError}
          actionLabel="Retry"
          onAction={() => deps.onRetry('figures')}
          testID="dispatch-figures-error"
        />
      ) : deps.figures !== null ? (
        <View style={styles.figuresRow} testID="dispatch-figures">
          {deps.figures.map((figure) => (
            <Figure key={figure.key} figure={figure} offline={deps.offline} testID={`dispatch-figure-${figure.key}`} />
          ))}
        </View>
      ) : null}

      <Button label="+ Dispatch a job" onPress={deps.onDispatch} testID="dispatch-new-job" />

      <View style={styles.section}>
        <Text style={styles.sectionLabel} testID="dispatch-load-heading">
          TECHNICIAN LOAD
        </Text>
        {deps.loadError !== null ? (
          <EmptyState
            message={deps.loadError}
            actionLabel="Retry"
            onAction={() => deps.onRetry('load')}
            testID="dispatch-load-error"
          />
        ) : deps.load === null ? null : deps.load.length === 0 ? (
          <EmptyState message="No technicians on the roster." testID="dispatch-load-empty" />
        ) : (
          deps.load.map((row, index) => (
            <TechnicianLoadRow
              key={row.employeeId}
              name={row.name}
              load={row.load}
              maxLoad={busiest}
              health={row.health}
              index={index}
              testID={`dispatch-load-${row.employeeId}`}
            />
          ))
        )}
      </View>

      <View style={styles.section}>
        <Text style={styles.sectionLabel} testID="dispatch-attention-heading">
          NEEDS ATTENTION
        </Text>
        {deps.sectionsError !== null ? (
          <EmptyState
            message={deps.sectionsError}
            actionLabel="Retry"
            onAction={() => deps.onRetry('attention')}
            testID="dispatch-attention-error"
          />
        ) : nothingNeedsAttention ? (
          <EmptyState message="Nothing needs attention." testID="dispatch-attention-empty" />
        ) : (
          liveSections.map((section) => (
            <View key={section.key} style={styles.subsection}>
              <Text style={styles.subsectionLabel} testID={`dispatch-attention-${section.key}-heading`}>
                {section.heading}
              </Text>
              {section.jobs.map((job) => (
                <AttentionRow
                  key={job.id}
                  job={job}
                  onPress={deps.onOpenJob}
                  testID={`dispatch-attention-${section.key}-${job.id}`}
                />
              ))}
            </View>
          ))
        )}
      </View>
    </ScrollView>
  );
}

const styles = StyleSheet.create({
  headerRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'baseline',
    gap: SPACE[2],
  },
  dateLabel: {
    color: SEMANTIC.text.secondary,
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
  section: {
    alignSelf: 'stretch',
    gap: SPACE[1],
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  subsection: {
    alignSelf: 'stretch',
    marginTop: SPACE[2],
    gap: SPACE[1],
  },
  subsectionLabel: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
  attentionRow: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    backgroundColor: SEMANTIC.bg.raised,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    gap: SPACE[3],
    paddingVertical: SPACE[2],
  },
  attentionRail: {
    width: 3,
    alignSelf: 'stretch',
    backgroundColor: SEMANTIC.feedback.danger,
  },
  attentionBody: {
    flex: 1,
    gap: 2,
  },
  attentionTitle: {
    color: SEMANTIC.text.primary,
  },
  attentionMeta: {
    color: SEMANTIC.text.secondary,
  },
  attentionNote: {
    color: SEMANTIC.feedback.danger,
    maxWidth: 132,
    textAlign: 'right',
  },
});
