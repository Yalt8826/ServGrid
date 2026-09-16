/**
 * T3 Job detail (UI/plan-2/04-TECHNICIAN.md §T3, 02-MOTION.md §5.1).
 * Everything needed to do the job, and the controls to advance it.
 *
 * Anatomy, exactly: the **docket header** — back, and the job number in
 * mono, top right, always the same place (one of the five tells) — then
 * the **StatusStepper** at the top (position in the day's work is the
 * first thing), the title line, the warranty and contract chips (the
 * expiry date and the word **prepaid** are the load-bearing parts), THE
 * UNIT with its serial, CONTACT with *Call* (dials) and *Navigate*
 * (deep-links `google.navigation:q=lat,lng` — there is no map in the
 * technician app), the description, and the timeline — collapsed, the
 * job's trail from the server with its `occurred_at` instants. The thumb
 * bar carries Cancel and the one primary: the verb the job's status
 * dictates.
 *
 * States (§T3): **sending** — a status write is on its way: the dashed
 * inset on the header and `Sending…` under the number. **Refused** — the
 * header keeps its real rail and a banner pinned UNDER THE HEADER carries
 * the server's `message` verbatim with one action, *Refresh*, which reads
 * the job again (`PLAN-FRONTEND.md` §5). **Closed** — the thumb bar
 * collapses to a single `Completed 16:42` line. No revenue.
 *
 * The hero beat (§5.1): when the job advances while the screen is open,
 * the stepper runs its 520ms choreography and the header's 4px rail
 * cross-fades to the new status colour over the same 520ms — the "card
 * behind" of §5.1 is this screen's own docket rail. The screen listens
 * to the stepper's `onAnimateStart` so the two cannot drift.
 *
 * Never on this screen: no amount, ever, after completion — the tree
 * holds no money figure by construction (`job-detail.test.tsx` holds it
 * to that). No edit: a technician advances a job, he does not edit it.
 */
import { useEffect, useRef } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';
import Animated, { interpolateColor, useAnimatedStyle, useReducedMotion, useSharedValue, withTiming } from 'react-native-reanimated';

import { DURATION, EASING, RADII, SEMANTIC, SPACE, STALE, TAP } from '@servgrid/shared';
import { StatusStepper } from '../../components/domain/StatusStepper';
import { StatusPill } from '../../components/domain/StatusPill';
import { Banner } from '../../components/ui/Banner';
import { Button } from '../../components/ui/Button';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import {
  closedLineOf,
  detailContractChipOf,
  statusHistoryOf,
  timelineTimeLabel,
  warrantyChipOf,
  type JobTimelineEntry,
} from './jobDetail';
import { istTimeLabel, primaryActionOf, railColorOf, type JobView } from './jobView';

const STANDARD_EASING = easing(EASING.standard);

export interface JobDetailDeps {
  view: JobView;
  /** The job's trail from the server, in the order it was recorded. */
  events: readonly JobTimelineEntry[];
  /** When the server closed the job, once it has. */
  completedAt: string | null;
  onBack: () => void;
  /** Dials the contact (`tel:`) — no number, no call. */
  onCall: (view: JobView) => void;
  /** Deep-links `google.navigation:q=lat,lng`. */
  onNavigate: (view: JobView) => void;
  /** The advance: *Start job* / *Arrive*, written to the server. */
  onStartJob: (view: JobView) => void;
  /**
   * Why this job cannot be **started** right now, or null when it can
   * (Yashas, 2026-09-16: he is on one job at a time). `busyWithSentence`
   * names the job in the way.
   *
   * It blocks the *start* only — `assigned → en_route`. Arriving at or
   * completing a job he has already begun is not starting a new one, and
   * blocking it would strand him on stale data (a job left `en_route`
   * from an earlier day could never be arrived at while another job stood
   * in progress). The advance button carries this as its `disabledReason`
   * when it applies: the explanation is the point, since a control that
   * silently does nothing teaches nothing.
   */
  startBlockedReason?: string | null;
  /** Opens the complete sheet (T4). */
  onComplete: (view: JobView) => void;
  /** Opens the cancel sheet (T5). */
  onCancel: (view: JobView) => void;
  /** Fires once per hero advance that animates — the screen's own rail
   * beat is driven by the status change; this is the test seam and the
   * hook for anything else that must move WITH the stepper, never
   * against it. */
  onAnimateStart?: () => void;
  /** The refusal banner's one action: clear it and read the job again. */
  onRefresh: () => void;
  /** Injectable clock — the warranty chip is judged against it. */
  now: Date;
}

export function JobDetailScreen(deps: JobDetailDeps): React.ReactNode {
  const { view } = deps;
  // The one-job-at-a-time block, and only for the start: `advance.to ===
  // 'en_route'` is *Start job*. Arriving or completing is never blocked.
  const startBlocked = deps.startBlockedReason ?? null;
  const { job } = view;
  const reducedMotion = useReducedMotion();

  const advance = primaryActionOf(job.status);
  const warranty = warrantyChipOf(view.unit, deps.now);
  const contract = detailContractChipOf(job.contract);
  const closed = job.status === 'completed' || job.status === 'cancelled';
  const rejected = view.rejectedMessage !== null;

  // §5.1's rail beat: the docket rail cross-fades to the new status
  // colour over the hero's 520ms. Both shared values rest on the current
  // colour, so a mount renders it with no motion; the effect fires only
  // on a real status change, in step with the stepper's own beat.
  const railFrom = useSharedValue(railColorOf(job.status));
  const railTo = useSharedValue(railColorOf(job.status));
  const railProgress = useSharedValue(1);
  const previousStatus = useRef(job.status);

  useEffect(() => {
    if (previousStatus.current === job.status) return;
    railFrom.value = railColorOf(previousStatus.current);
    railTo.value = railColorOf(job.status);
    previousStatus.current = job.status;
    if (reducedMotion) {
      railProgress.value = 1;
      return;
    }
    railProgress.value = 0;
    railProgress.value = withTiming(1, { duration: DURATION.hero, easing: STANDARD_EASING });
  }, [job.status, railFrom, railTo, railProgress, reducedMotion]);

  const railStyle = useAnimatedStyle(() => ({
    backgroundColor: interpolateColor(railProgress.value, [0, 1], [railFrom.value, railTo.value]),
  }));

  // The docket tell is "always the same place": the number stays while a
  // write is on its way (the number came from the server, it is real).
  // `Sending…` rides beneath it.
  const numberText = (
    <View style={{ alignItems: 'flex-end', gap: SPACE[1] }}>
      <Text testID="detail-number" style={{ ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] }}>
        {job.jobNumber}
      </Text>
      {view.pending && !rejected ? (
        <Text testID="detail-pending" style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }}>
          Sending…
        </Text>
      ) : null}
    </View>
  );

  return (
    <View style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}>
      <ScrollView
        testID="detail-screen"
        contentContainerStyle={{ padding: SPACE[4], paddingBottom: SPACE[6], gap: SPACE[4] }}
        showsVerticalScrollIndicator={false}
      >
        {/* The docket header — job number in mono, top right, always. The
            stale/rejected dashed inset is a separate leading layer (the
            JobCard layering) so it never repaints the status rail. */}
        <View testID="detail-header" style={{ flexDirection: 'row', alignSelf: 'stretch' }}>
          {view.pending || rejected ? (
            <View
              testID="detail-inset"
              style={{
                width: STALE.insetWidth,
                borderLeftWidth: STALE.insetWidth,
                borderLeftColor: rejected ? SEMANTIC.feedback.danger : STALE.insetColor,
                borderStyle: 'dashed',
                backgroundColor: SEMANTIC.bg.raised,
              }}
            />
          ) : null}
          <View style={[styles.header, { flex: 1 }]}>
            <Animated.View testID="detail-rail" style={[styles.rail, railStyle]} />
            <Pressable
              testID="detail-back"
              accessibilityRole="button"
              accessibilityLabel="Back"
              onPress={deps.onBack}
              hitSlop={TAP.hitSlop}
              style={styles.back}
            >
              <Text style={{ ...textStyle('h2'), color: SEMANTIC.text.secondary }}>←</Text>
            </Pressable>
            <View style={{ flex: 1, alignItems: 'flex-end', gap: SPACE[1] }}>
              {numberText}
              {/* The rail never appears without its word (§1.6): the
                  pill pairs the header rail's colour with the word. */}
              <StatusPill status={job.status} testID="detail-status" />
            </View>
          </View>
        </View>

        {/* Refused: the banner is pinned UNDER the header (§T3), the
            server's message verbatim, one action, never auto-dismissed. */}
        {rejected ? (
          <Banner
            testID="detail-rejected"
            tone="danger"
            message={view.rejectedMessage ?? ''}
            actions={[{ label: 'Refresh', onPress: deps.onRefresh }]}
          />
        ) : null}

        {/* The hero — position in the day's work is the first thing.
            onAnimateStart surfaces the beat: once per advance that
            animates, never on mount, never for a cancelled job. */}
        <StatusStepper
          status={job.status}
          history={statusHistoryOf(deps.events)}
          onAnimateStart={deps.onAnimateStart}
          testID="detail-stepper"
        />

        {/* Title block */}
        <View style={{ alignSelf: 'stretch', gap: SPACE[2] }}>
          <Text testID="detail-title" style={{ ...textStyle('h1'), color: SEMANTIC.text.primary }}>
            {view.area === '' ? view.customerName : `${view.customerName}, ${view.area}`}
          </Text>
          <Text testID="detail-when" style={{ ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] }}>
            {job.scheduledFor === null ? job.title : `${istTimeLabel(job.scheduledFor)} today · ${job.title}`}
          </Text>
          {warranty !== null || contract !== null ? (
            <View style={styles.chipsRow}>
              {warranty !== null ? (
                <Text testID="detail-warranty" style={styles.chip}>
                  {warranty}
                </Text>
              ) : null}
              {contract !== null ? (
                <Text testID="detail-contract" style={styles.chip}>
                  {contract}
                </Text>
              ) : null}
            </View>
          ) : null}
        </View>

        {/* THE UNIT — serial and warranty expiry are why this section is
            here: the basement, the torch, the decision (§T3 worst moment). */}
        {view.unit ? (
          <View style={{ alignSelf: 'stretch', gap: SPACE[1] }}>
            <Text style={styles.sectionLabel}>THE UNIT</Text>
            <Text testID="detail-unit" style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>
              {view.unit.brand === null
                ? `${view.unit.name} · SN ${view.unit.serialNumber}`
                : `${view.unit.name} · ${view.unit.brand} · SN ${view.unit.serialNumber}`}
            </Text>
          </View>
        ) : null}

        {/* CONTACT */}
        <View style={{ alignSelf: 'stretch', gap: SPACE[1] }}>
          <Text style={styles.sectionLabel}>CONTACT</Text>
          <View style={styles.contactRow}>
            <Text
              testID="detail-contact-name"
              style={{ ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, flex: 1 }}
              numberOfLines={2}
            >
              {job.contactName ?? view.customerName}
            </Text>
            <Button
              label="Call"
              variant="secondary"
              onPress={() => deps.onCall(view)}
              disabled={job.contactPhone === null}
              disabledReason={job.contactPhone === null ? 'No contact number' : undefined}
              testID="detail-call"
            />
            <Button label="Navigate" variant="secondary" onPress={() => deps.onNavigate(view)} testID="detail-navigate" />
          </View>
        </View>

        {/* DESCRIPTION */}
        {job.description !== null ? (
          <View style={{ alignSelf: 'stretch', gap: SPACE[1] }}>
            <Text style={styles.sectionLabel}>DESCRIPTION</Text>
            <Text testID="detail-description" style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>
              {job.description}
            </Text>
          </View>
        ) : null}

        {/* TIMELINE — collapsed to one line per event, `occurred_at`
            instants, from the job's trail on the server. */}
        <View style={{ alignSelf: 'stretch', gap: SPACE[1] }}>
          <Text style={styles.sectionLabel}>TIMELINE</Text>
          {deps.events.length === 0 ? (
            <Text testID="detail-timeline-empty" style={{ ...textStyle('body'), color: SEMANTIC.text.secondary }}>
              Nothing yet — what you do here appears here.
            </Text>
          ) : (
            <View testID="detail-timeline" style={{ alignSelf: 'stretch', gap: SPACE[2] }}>
              {deps.events.map((entry) => (
                <View key={entry.id} testID="detail-timeline-entry" style={styles.timelineRow}>
                  <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>{entry.label}</Text>
                  <Text style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] }}>
                    {timelineTimeLabel(entry.at)}
                  </Text>
                </View>
              ))}
            </View>
          )}
        </View>
      </ScrollView>

      {/* The thumb bar (72): Cancel left, the one primary right. Closed
          jobs collapse it to a single line — no revenue on it, ever. */}
      <View testID="detail-thumb-bar" style={styles.thumbBar}>
        {closed ? (
          <Text testID="detail-closed-line" style={{ ...textStyle('bodyStrong'), color: SEMANTIC.text.primary }}>
            {closedLineOf(job.status, deps.completedAt)}
          </Text>
        ) : (
          <>
            <Button label="Cancel" variant="danger" onPress={() => deps.onCancel(view)} testID="detail-cancel" />
            <View style={{ flex: 1 }} />
            {advance !== null ? (
              <Button
                label={advance.label}
                onPress={() => deps.onStartJob(view)}
                disabled={startBlocked !== null && advance.to === 'en_route'}
                disabledReason={startBlocked !== null && advance.to === 'en_route' ? startBlocked : undefined}
                testID="detail-primary"
              />
            ) : job.status === 'in_progress' ? (
              <Button label="Complete job" onPress={() => deps.onComplete(view)} testID="detail-primary" />
            ) : null}
          </>
        )}
      </View>
    </View>
  );
}

const styles = StyleSheet.create({
  header: {
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.none,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  rail: {
    width: 4,
    alignSelf: 'stretch',
  },
  back: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  chipsRow: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACE[2],
  },
  chip: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  contactRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
  },
  thumbBar: {
    height: TAP.thumbBar,
    minHeight: TAP.thumbBar,
    alignSelf: 'stretch',
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    paddingHorizontal: SPACE[4],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
  },
});
