/**
 * `DispatcherJobDetailScreen` (2026-09-17) — the console's view of one
 * job. Read-only by design: the dispatcher assigns, reschedules and
 * cancels from Job Logs and the dispatch form, which own those writes;
 * this screen answers "what is this job, who is on it, and what has
 * happened to it" — the question every tap from the dashboard and the
 * log list was asking and the placeholder could not.
 *
 * Money is absent by construction: `JobCardDispatcher` has no money
 * column, this screen renders no figure it could not read, and the test
 * walks the tree for a currency symbol.
 *
 * The three panels mirror the technician's detail, so one product's job
 * page reads the same on both sides of the office door: the job (who,
 * what, when), the assignment (who has it), the site (how to reach the
 * customer), then the trail.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import type { JobCardDispatcher, JobTimelineEvent } from '@servgrid/shared';
import { alpha, COLORS, FRAME, ICON, RADII, SEMANTIC, SPACE, TAP, TINT } from '@servgrid/shared';
import { Banner, Button, EmptyState, SectionHeader } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { textStyle } from '../../fonts/textStyle';
import {
  assigneeNameOf,
  eventLabelOf,
  eventStampOf,
  priorityLabelOf,
  slotLabelOf,
  statusToneOf,
} from './jobDetailModel';
import {
  CancelJobSheet,
  ReassignSheet,
  RescheduleSheet,
  type ReassignCandidate,
} from './jobActions';

/** What the screen needs, all injected — the route owns the reads. */
export interface DispatcherJobDetailDeps {
  /** The job, or null while it loads (and after a failed load). */
  card: JobCardDispatcher | null;
  /** The roster for the reassign picker — id, name, his open total. */
  candidates: readonly ReassignCandidate[];
  /** True while any of the three actions is in flight. */
  actionBusy: boolean;
  /** The server's sentence when an action was refused. */
  actionError: string | null;
  onReassign: (technicianId: string) => void;
  onReschedule: (scheduledFor: string) => void;
  onCancelJob: (body: { reasonCode: string; reasonNote?: string; rescheduleTo?: string }) => void;
  /** The site, for the reach-the-customer panel. */
  contact: { name: string; phone: string; addressLabel: string | null } | null;
  /** The roster, so the assignee reads as a name rather than a uuid. */
  roster: readonly { employeeId: string; name: string }[];
  events: readonly JobTimelineEvent[] | null;
  loading: boolean;
  error: string | null;
  onRetry: () => void;
  onBack: () => void;
  /** Dials the customer (`tel:`) — no number, no call. */
  onCall: () => void;
  /** Deep-links the site on a map. */
  onNavigate: () => void;
  /** Injectable clock — the slot line and overdue are judged by it. */
  now: Date;
}

export function DispatcherJobDetailScreen(deps: DispatcherJobDetailDeps): React.ReactNode {
  const card = deps.card;
  // Which of the three doors is open. UI state, so it lives here; the
  // writes themselves are the route's.
  const [openSheet, setOpenSheet] = useState<'none' | 'reassign' | 'reschedule' | 'cancel'>('none');

  return (
    <View style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} testID="dispatch-job-screen">
      {/* The navy app bar: back, the job number, and the status centred on
          the bar itself — the technician detail's arrangement, so the two
          job pages are recognisably one product. */}
      <View style={styles.bar}>
        <View style={styles.barRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Back"
            onPress={deps.onBack}
            hitSlop={TAP.hitSlop}
            style={styles.back}
            testID="dispatch-job-back"
          >
            <Icon name="back" size={ICON.md} color={FRAME.text} />
          </Pressable>
          <View style={{ flex: 1 }} />
          {card === null ? null : (
            <View style={styles.barChip}>
              <Text testID="dispatch-job-number" style={{ ...textStyle('caption'), color: FRAME.text }}>
                {card.jobNumber}
              </Text>
            </View>
          )}
        </View>
        {card === null ? null : (
          <View pointerEvents="none" style={styles.barCentre}>
            <StatusChip status={card.status} testID="dispatch-job-status" />
          </View>
        )}
      </View>

      <ScrollView
        style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }}
        contentContainerStyle={{ paddingBottom: SPACE[8] }}
        testID="dispatch-job-scroll"
      >
        <View style={styles.body}>
          {deps.error !== null ? (
            <Banner tone="danger" message={deps.error} actions={[{ label: 'Retry', onPress: deps.onRetry }]} testID="dispatch-job-error" />
          ) : null}

          {card === null ? (
            deps.error === null ? <EmptyState message="Reading the job…" testID="dispatch-job-loading" /> : null
          ) : (
            <>
              <View style={styles.panel}>
                <View style={styles.panelPad}>
                  <Text testID="dispatch-job-customer" style={{ ...textStyle('h1'), color: SEMANTIC.text.primary }}>
                    {card.customerName}
                  </Text>
                  <Text style={{ ...textStyle('body'), color: SEMANTIC.text.secondary }}>{card.title}</Text>
                  <View style={styles.hairline} />
                  <View style={styles.metaRow}>
                    <Icon name="clock" size={ICON.sm} color={SEMANTIC.text.placeholder} />
                    <Text testID="dispatch-job-slot" style={{ ...textStyle('mono'), color: SEMANTIC.text.primary }}>
                      {slotLabelOf(card, deps.now)}
                    </Text>
                    <View style={{ flex: 1 }} />
                    {card.isOverdue ? (
                      <Text
                        testID="dispatch-job-overdue"
                        style={[
                          styles.chip,
                          {
                            color: SEMANTIC.text.primary,
                            borderColor: alpha(SEMANTIC.feedback.danger, TINT.chipLine),
                            backgroundColor: alpha(SEMANTIC.feedback.danger, TINT.chip),
                          },
                        ]}
                      >
                        Overdue
                      </Text>
                    ) : null}
                    {priorityLabelOf(card.priority) === null ? null : (
                      <Text
                        testID="dispatch-job-priority"
                        style={[
                          styles.chip,
                          {
                            color: SEMANTIC.text.primary,
                            borderColor: alpha(SEMANTIC.feedback.warning, TINT.chipLine),
                            backgroundColor: alpha(SEMANTIC.feedback.warning, TINT.chip),
                          },
                        ]}
                      >
                        {priorityLabelOf(card.priority)}
                      </Text>
                    )}
                    {card.isContractVisit ? (
                      <Text
                        testID="dispatch-job-amc"
                        style={[
                          styles.chip,
                          {
                            color: SEMANTIC.text.primary,
                            borderColor: alpha(COLORS.accent, TINT.chipLine),
                            backgroundColor: alpha(COLORS.accent, TINT.chip),
                          },
                        ]}
                      >
                        AMC
                      </Text>
                    ) : null}
                  </View>
                </View>
              </View>

              <View style={styles.section}>
                <SectionHeader label="Assigned to" icon="people" />
                <View style={styles.panel}>
                  <View style={styles.panelPad}>
                    <Text testID="dispatch-job-assignee" style={{ ...textStyle('bodyStrong'), color: SEMANTIC.text.primary }}>
                      {assigneeNameOf(card.assignedTo, deps.roster) ?? 'Unassigned'}
                    </Text>
                  </View>
                </View>
              </View>

              <View style={styles.section}>
                <SectionHeader label="Site" icon="phone" tint={COLORS.accent} />
                <View style={[styles.panel, { backgroundColor: alpha(COLORS.accent, TINT.wash) }]}>
                  <View style={styles.panelPad}>
                    <Text testID="dispatch-job-contact" style={{ ...textStyle('bodyStrong'), color: SEMANTIC.text.primary }}>
                      {deps.contact?.name ?? card.customerName}
                    </Text>
                    {deps.contact === null ? null : (
                      <Text style={{ ...textStyle('mono'), color: SEMANTIC.text.secondary }}>{deps.contact.phone}</Text>
                    )}
                    {deps.contact?.addressLabel == null ? null : (
                      <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary }}>{deps.contact.addressLabel}</Text>
                    )}
                    <View style={{ flexDirection: 'row', gap: SPACE[3], marginTop: SPACE[2] }}>
                      <View style={{ flex: 1 }}>
                        <Button
                          label="Call"
                          icon="phone"
                          variant="secondary"
                          fullwidth
                          onPress={deps.onCall}
                          disabled={deps.contact === null || deps.contact.phone.trim() === ''}
                          disabledReason={deps.contact === null || deps.contact.phone.trim() === '' ? 'No number on this site.' : undefined}
                          testID="dispatch-job-call"
                        />
                      </View>
                      <View style={{ flex: 1 }}>
                        <Button
                          label="Navigate"
                          icon="navigate"
                          variant="secondary"
                          fullwidth
                          onPress={deps.onNavigate}
                          testID="dispatch-job-navigate"
                        />
                      </View>
                    </View>
                  </View>
                </View>
              </View>

              <View style={styles.section}>
                <SectionHeader label="Actions" icon="edit" />
                <View style={styles.panel}>
                  <View style={styles.panelPad}>
                    <Button
                      label="Reassign"
                      icon="people"
                      variant="secondary"
                      fullwidth
                      disabled={deps.actionBusy}
                      onPress={() => setOpenSheet('reassign')}
                      testID="dispatch-job-reassign"
                    />
                    <Button
                      label="Reschedule"
                      icon="calendar"
                      variant="secondary"
                      fullwidth
                      disabled={deps.actionBusy}
                      onPress={() => setOpenSheet('reschedule')}
                      testID="dispatch-job-reschedule"
                    />
                    <Button
                      label="Cancel this job"
                      icon="close"
                      variant="danger"
                      fullwidth
                      disabled={deps.actionBusy}
                      onPress={() => setOpenSheet('cancel')}
                      testID="dispatch-job-cancel"
                    />
                    {deps.actionError === null || openSheet !== 'none' ? null : (
                      <Text testID="dispatch-job-action-error" style={{ ...textStyle('caption'), color: SEMANTIC.feedback.danger }}>
                        {deps.actionError}
                      </Text>
                    )}
                  </View>
                </View>
              </View>

              <View style={styles.section}>
                <SectionHeader label="Timeline" icon="clock" />
                <View style={styles.panel}>
                  {deps.events === null ? (
                    <View style={styles.panelPad}>
                      <Text style={{ ...textStyle('body'), color: SEMANTIC.text.secondary }}>Reading the trail…</Text>
                    </View>
                  ) : deps.events.length === 0 ? (
                    <View style={styles.panelPad}>
                      <Text testID="dispatch-job-timeline-empty" style={{ ...textStyle('body'), color: SEMANTIC.text.secondary }}>
                        Nothing on the trail yet.
                      </Text>
                    </View>
                  ) : (
                    deps.events.map((event, index) => (
                      <View key={event.id} style={{ alignSelf: 'stretch' }}>
                        {index > 0 ? <View style={styles.hairline} /> : null}
                        <View style={styles.timelineRow} testID={`dispatch-job-event-${event.id}`}>
                          <View style={[styles.dot, { backgroundColor: event.toStatus === null ? SEMANTIC.text.placeholder : statusToneOf(event.toStatus).color }]} />
                          <Text style={{ ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1 }}>
                            {eventLabelOf(event)}
                          </Text>
                          <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary }} numberOfLines={1}>
                            {event.actorName ?? 'System'}
                          </Text>
                          <Text style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] }}>
                            {eventStampOf(event.occurredAt)}
                          </Text>
                        </View>
                      </View>
                    ))
                  )}
                </View>
              </View>
            </>
          )}
        </View>
      </ScrollView>

      {/* The three doors, each a sheet with one question. They unmount
          with the screen and their state resets, so a re-opened sheet
          starts from the job as it now stands. */}
      <ReassignSheet
        visible={openSheet === 'reassign'}
        jobNumber={card?.jobNumber ?? ''}
        currentTechnicianId={card?.assignedTo ?? null}
        candidates={deps.candidates}
        busy={deps.actionBusy}
        error={deps.actionError}
        onConfirm={(technicianId) => {
          deps.onReassign(technicianId);
          setOpenSheet('none');
        }}
        onDismiss={() => setOpenSheet('none')}
      />
      <RescheduleSheet
        visible={openSheet === 'reschedule'}
        jobNumber={card?.jobNumber ?? ''}
        currentDate={card?.scheduledFor === null || card === null ? null : card.scheduledFor.slice(0, 10)}
        currentTime={card?.scheduledFor === null || card === null ? null : card.scheduledFor.slice(11, 16)}
        busy={deps.actionBusy}
        error={deps.actionError}
        onConfirm={(scheduledFor) => {
          deps.onReschedule(scheduledFor);
          setOpenSheet('none');
        }}
        onDismiss={() => setOpenSheet('none')}
      />
      <CancelJobSheet
        visible={openSheet === 'cancel'}
        jobNumber={card?.jobNumber ?? ''}
        busy={deps.actionBusy}
        error={deps.actionError}
        onConfirm={(body) => {
          deps.onCancelJob(body);
          setOpenSheet('none');
        }}
        onDismiss={() => setOpenSheet('none')}
      />
    </View>
  );
}

/** The status as a tinted chip on the frame's ground — dot + word. */
function StatusChip({ status, testID }: { status: JobCardDispatcher['status']; testID?: string }): React.ReactNode {
  const tone = statusToneOf(status);
  return (
    <View
      testID={testID}
      style={{
        flexDirection: 'row',
        alignItems: 'center',
        gap: 6,
        alignSelf: 'center',
        borderWidth: 1,
        borderColor: FRAME.bgSoft,
        borderRadius: RADII.control,
        backgroundColor: FRAME.text,
        paddingHorizontal: 8,
        paddingVertical: 3,
      }}
    >
      <View style={{ width: 8, height: 8, borderRadius: 4, backgroundColor: tone.color }} />
      <Text style={{ ...textStyle('label'), color: SEMANTIC.text.primary }}>{tone.label}</Text>
    </View>
  );
}

const styles = StyleSheet.create({
  bar: {
    alignSelf: 'stretch',
    backgroundColor: FRAME.bg,
    paddingBottom: SPACE[3],
  },
  barRow: {
    flexDirection: 'row',
    alignItems: 'center',
    paddingHorizontal: SPACE[3],
    paddingTop: SPACE[3],
    gap: SPACE[2],
  },
  /** Centred on the bar itself — the technician detail's arrangement: the
   * layer spans the bar and the row inside it gives the height, so the
   * pill cannot drift into the number chip. */
  barCentre: {
    position: 'absolute',
    left: 0,
    right: 0,
    top: 0,
    bottom: 0,
    alignItems: 'center',
    justifyContent: 'center',
  },
  back: {
    width: 44,
    height: 44,
    alignItems: 'center',
    justifyContent: 'center',
  },
  barChip: {
    borderRadius: RADII.control,
    backgroundColor: FRAME.bgSoft,
    paddingHorizontal: SPACE[2],
    paddingVertical: 2,
  },
  body: {
    alignSelf: 'stretch',
    flexGrow: 1,
    backgroundColor: SEMANTIC.bg.app,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[5],
    gap: SPACE[5],
  },
  section: {
    alignSelf: 'stretch',
    gap: SPACE[2],
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
    flexWrap: 'wrap',
    gap: SPACE[2],
  },
  chip: {
    ...textStyle('label'),
    borderWidth: 1,
    borderRadius: RADII.control,
    paddingHorizontal: 8,
    paddingVertical: 2,
    overflow: 'hidden',
  },
  timelineRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[3],
  },
  dot: {
    width: 6,
    height: 6,
    borderRadius: 3,
  },
});
