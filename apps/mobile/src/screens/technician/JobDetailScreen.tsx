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

import { alpha, DURATION, EASING, ICON, RADII, SEMANTIC, SPACE, STALE, TAP, TINT } from '@servgrid/shared';
import { StatusStepper } from '../../components/domain/StatusStepper';
import { StatusPill } from '../../components/domain/StatusPill';
import { Banner } from '../../components/ui/Banner';
import { Button } from '../../components/ui/Button';
import { SectionHeader } from '../../components/ui/SectionHeader';
import { Icon, type IconName } from '../../components/ui/icons';
import { textStyle } from '../../fonts/textStyle';
import { easing } from '../../components/ui/motion';
import {
  closedLineOf,
  detailContractChipOf,
  statusHistoryOf,
  timelineTimeLabel,
  warrantyChipOf,
  warrantyIsLive,
  type JobTimelineEntry,
} from './jobDetail';
import { dayLabelOf, istTimeLabel, primaryActionOf, railColorOf, type JobView } from './jobView';

const STANDARD_EASING = easing(EASING.standard);

/**
 * One panel of the job's detail: a bordered white ground with the shared
 * `SectionHeader` (glyph · label · rule) capping it.
 *
 * The screen used to be six grey uppercase words floating on white with
 * nothing to separate them, which is why it read as a wall of text with a
 * void under it — the sections had no edge, so the eye had nowhere to
 * stop. A panel gives each one an edge and the page a stack; the rule
 * inside the header does the separating the words used to have to do
 * alone. Square corners, like every other docket in the app.
 */
function DetailSection({
  icon,
  label,
  testID,
  children,
}: {
  icon: IconName;
  label: string;
  testID?: string;
  children: React.ReactNode;
}): React.ReactNode {
  return (
    <View testID={testID} style={styles.panel}>
      <View style={{ paddingHorizontal: SPACE[3], paddingTop: SPACE[3] }}>
        <SectionHeader label={label} icon={icon} />
      </View>
      <View style={{ padding: SPACE[3], gap: SPACE[2] }}>{children}</View>
    </View>
  );
}

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
  const warrantyLive = warrantyIsLive(view.unit, deps.now);
  const contract = detailContractChipOf(job.contract);
  const day = dayLabelOf(job.scheduledFor, deps.now);
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
        {/* The docket header — the status word beside the rail that
            carries it, the job number in its own chip at the far edge
            (2026-09-16: the number used to float over the pill, so the
            two things he is asked for on the phone read as one block).
            The stale/rejected dashed inset is a separate leading layer
            (the JobCard layering) so it never repaints the status rail. */}
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
              <Icon name="back" size={ICON.md} color={SEMANTIC.text.primary} />
            </Pressable>
            {/* The rail never appears without its word (§1.6): the pill
                pairs the header rail's colour with the word. */}
            <StatusPill status={job.status} testID="detail-status" />
            <View style={{ flex: 1 }} />
            {numberText}
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

        {/* The job itself: who and where, what the work is, and when it is
            due. The work title moved off the clock line (2026-09-16) —
            "19:30 today · Preventive service" made a time and a job name
            share one sentence, and the day it claimed was hardcoded
            "today" whether or not the job was today's. */}
        <View testID="detail-panel-job" style={styles.panel}>
          <View style={styles.panelPad}>
            <Text testID="detail-title" style={{ ...textStyle('h1'), color: SEMANTIC.text.primary }}>
              {view.area === '' ? view.customerName : `${view.customerName}, ${view.area}`}
            </Text>
            <Text style={{ ...textStyle('body'), color: SEMANTIC.text.secondary }}>{job.title}</Text>
            <View style={styles.hairline} />
            <View style={styles.metaRow}>
              <Icon name="clock" size={ICON.sm} color={SEMANTIC.text.placeholder} />
              <Text testID="detail-when" style={{ ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] }}>
                {job.scheduledFor === null
                  ? 'No time set'
                  : `${day === null ? 'Today' : day} · ${istTimeLabel(job.scheduledFor)}`}
              </Text>
              <View style={{ flex: 1 }} />
              {/* Urgency, which the office sets and the technician could
                  not see anywhere until now (2026-09-16). It rides the
                  meta row beside the time it overrides. */}
              {job.priority === 'urgent' ? (
                <Text
                  testID="detail-urgent"
                  style={[
                    styles.chip,
                    {
                      color: SEMANTIC.text.primary,
                      borderColor: alpha(SEMANTIC.feedback.danger, TINT.chipLine),
                      backgroundColor: alpha(SEMANTIC.feedback.danger, TINT.chip),
                    },
                  ]}
                >
                  Urgent
                </Text>
              ) : null}
              {contract === null ? null : (
                <Text testID="detail-contract" style={[styles.chip, styles.chipFrame]}>
                  {contract}
                </Text>
              )}
            </View>
          </View>
        </View>

        {/* THE UNIT — serial and warranty expiry are why this section is
            here: the basement, the torch, the decision (§T3 worst moment).
            The warranty chip lives with the unit it belongs to, tinted by
            whether that cover is still live: green reads as "no charge to
            discuss", red as "this one is chargeable". */}
        {view.unit ? (
          <DetailSection icon="cube" label="The unit" testID="detail-panel-unit">
            <Text testID="detail-unit" style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>
              {view.unit.brand === null
                ? `${view.unit.name} · SN ${view.unit.serialNumber}`
                : `${view.unit.name} · ${view.unit.brand} · SN ${view.unit.serialNumber}`}
            </Text>
            {warranty === null ? null : (
              <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
                <Text
                  testID="detail-warranty"
                  style={[
                    styles.chip,
                    styles.chipFrame,
                    {
                      color: SEMANTIC.text.primary,
                      borderColor: alpha(warrantyLive ? SEMANTIC.feedback.success : SEMANTIC.feedback.danger, TINT.chipLine),
                      backgroundColor: alpha(warrantyLive ? SEMANTIC.feedback.success : SEMANTIC.feedback.danger, TINT.chip),
                    },
                  ]}
                >
                  {warranty}
                </Text>
              </View>
            )}
          </DetailSection>
        ) : null}

        <DetailSection icon="phone" label="Contact" testID="detail-panel-contact">
          <Text
            testID="detail-contact-name"
            style={{ ...textStyle('bodyStrong'), color: SEMANTIC.text.primary }}
            numberOfLines={2}
          >
            {job.contactName ?? view.customerName}
          </Text>
          {job.contactPhone === null ? null : (
            <Text
              testID="detail-contact-phone"
              style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] }}
            >
              {job.contactPhone}
            </Text>
          )}
          <View style={{ flexDirection: 'row', gap: SPACE[3], marginTop: SPACE[1] }}>
            <View style={{ flex: 1 }}>
              <Button
                label="Call"
                icon="phone"
                variant="secondary"
                fullwidth
                onPress={() => deps.onCall(view)}
                disabled={job.contactPhone === null}
                disabledReason={job.contactPhone === null ? 'No contact number' : undefined}
                testID="detail-call"
              />
            </View>
            <View style={{ flex: 1 }}>
              <Button
                label="Navigate"
                icon="navigate"
                variant="secondary"
                fullwidth
                onPress={() => deps.onNavigate(view)}
                testID="detail-navigate"
              />
            </View>
          </View>
        </DetailSection>

        {job.description === null ? null : (
          <DetailSection icon="document" label="Description" testID="detail-panel-description">
            <Text testID="detail-description" style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>
              {job.description}
            </Text>
          </DetailSection>
        )}

        {/* TIMELINE — one row per event, `occurred_at` instants, from the
            job's trail on the server. Each row's dot takes the colour of
            the status that event moved the job into, so the trail reads
            down the page the same way the stepper reads across it. */}
        <DetailSection icon="clock" label="Timeline" testID="detail-panel-timeline">
          {deps.events.length === 0 ? (
            <Text testID="detail-timeline-empty" style={{ ...textStyle('body'), color: SEMANTIC.text.secondary }}>
              Nothing yet — what you do here appears here.
            </Text>
          ) : (
            <View testID="detail-timeline" style={{ alignSelf: 'stretch' }}>
              {deps.events.map((entry, index) => (
                <View key={entry.id} style={{ alignSelf: 'stretch' }}>
                  {index > 0 ? <View style={styles.hairline} /> : null}
                  <View testID="detail-timeline-entry" style={styles.timelineRow}>
                    {/* An event that moved the job takes the colour it
                        moved it to; one that did not (a note) keeps the
                        neutral dot — the colour always means a status,
                        never "an event happened". */}
                    <View
                      style={{
                        width: 6,
                        height: 6,
                        borderRadius: 3,
                        backgroundColor: entry.to === null ? SEMANTIC.text.placeholder : railColorOf(entry.to),
                      }}
                    />
                    <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>{entry.label}</Text>
                    <Text style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] }}>
                      {timelineTimeLabel(entry.at)}
                    </Text>
                  </View>
                </View>
              ))}
            </View>
          )}
        </DetailSection>
      </ScrollView>

      {/* The thumb bar (72): Cancel left, the one primary right. Closed
          jobs collapse it to a single line — no revenue on it, ever. */}
      <View testID="detail-thumb-bar" style={styles.thumbBar}>
        {closed ? (
          <View style={{ flexDirection: 'row', alignItems: 'center', gap: SPACE[2] }}>
            <Icon
              name={job.status === 'completed' ? 'checkFilled' : 'close'}
              size={ICON.md}
              color={job.status === 'completed' ? SEMANTIC.feedback.success : SEMANTIC.feedback.danger}
            />
            <Text testID="detail-closed-line" style={{ ...textStyle('bodyStrong'), color: SEMANTIC.text.primary }}>
              {closedLineOf(job.status, deps.completedAt)}
            </Text>
          </View>
        ) : (
          <>
            <Button
              label="Cancel"
              icon="close"
              variant="danger"
              onPress={() => deps.onCancel(view)}
              testID="detail-cancel"
            />
            <View style={{ flex: 1 }} />
            {advance !== null ? (
              <Button
                label={advance.label}
                icon="forward"
                onPress={() => deps.onStartJob(view)}
                disabled={startBlocked !== null && advance.to === 'en_route'}
                disabledReason={startBlocked !== null && advance.to === 'en_route' ? startBlocked : undefined}
                testID="detail-primary"
              />
            ) : job.status === 'in_progress' ? (
              <Button label="Complete job" icon="forward" onPress={() => deps.onComplete(view)} testID="detail-primary" />
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
    borderRadius: RADII.control,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  /** The neutral frame a chip wears when it carries no tone of its own. */
  chipFrame: {
    borderColor: SEMANTIC.line.default,
    backgroundColor: alpha(SEMANTIC.text.primary, TINT.wash),
  },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  panel: {
    alignSelf: 'stretch',
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.none,
    backgroundColor: SEMANTIC.bg.raised,
  },
  panelPad: {
    padding: SPACE[3],
    gap: SPACE[2],
  },
  hairline: {
    height: 1,
    backgroundColor: SEMANTIC.line.default,
  },
  metaRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
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
    paddingVertical: SPACE[2],
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
