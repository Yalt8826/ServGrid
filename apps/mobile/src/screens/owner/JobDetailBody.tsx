/**
 * The owner's job detail body (§O4) — the content a row click opens:
 * side detail on desktop, pushed screen on phone (the route decides the
 * frame; this component is the content). The detail carries, exactly as
 * the spec lists it: the card's figures, **the full `job_events`
 * timeline** in time order, **the completion with its figures, parts
 * fitted**, and the **amend** action — the sheet in `AmendSheet.tsx`,
 * gated on `owner.amend` (the flag is handed in as a prop, the way
 * `StackSection` takes `editable`, so the component stays pure).
 */
import { useEffect, useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { STATUS, SEMANTIC, SPACE } from '@servgrid/shared';
import { formatMoneyEnIN } from '@servgrid/shared';
import type { JobTimelineOwnerResponse } from '@servgrid/shared';
import type { OwnerJobCard } from './jobsModel';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { AmendSheet, type AmendRefusal } from './AmendSheet';
import {
  eventPayloadLine,
  eventWord,
  scheduledLabelOf,
  statusWordOf,
} from './jobsModel';

export interface OwnerJobDetailDeps {
  /** The card the row showed — the header while the timeline loads. The
   * owner schema is what the detail serves; the type stays the union so
   * the same body renders from either list. */
  card: OwnerJobCard | null;
  /** The `/v1/jobs/:id/events` read — timeline plus the completion. */
  detail: JobTimelineOwnerResponse | null;
  detailLoading: boolean;
  detailError: string | null;
  /** `owner.amend` gates the action alone, not the read. */
  amendFlagOn: boolean;
  amendBusy: boolean;
  amendError: AmendRefusal | null;
  reopenBusy: boolean;
  onAmend(input: { cost: string; discountAmount: string; discountReason: string; reason: string }): void;
  onReopen(reason: string): void;
  onRetry(): void;
  /** Desk side-detail close. The pushed phone screen navigates back instead. */
  onClose?: () => void;
  testID?: string;
}

const STATUS_COLOR: Record<string, string> = {
  unassigned: STATUS.unassigned,
  assigned: STATUS.unassigned,
  en_route: STATUS.en_route,
  in_progress: STATUS.in_progress,
  completed: STATUS.completed,
  cancelled: STATUS.cancelled,
};

function FigureRow({ label, value, testID }: { label: string; value: string; testID: string }): React.ReactNode {
  return (
    <View style={styles.figureRow}>
      <Text style={styles.figureLabel}>{label}</Text>
      <Text style={styles.figureValue} testID={testID}>
        {value}
      </Text>
    </View>
  );
}

export function OwnerJobDetailBody(deps: OwnerJobDetailDeps): React.ReactNode {
  const [amendOpen, setAmendOpen] = useState(false);
  // True between pressing Amend and the hook's answer: a clean answer
  // closes the sheet, a refusal keeps it open with the error (or the
  // reopen offer) in place.
  const [awaitingAmend, setAwaitingAmend] = useState(false);
  useEffect(() => {
    if (!awaitingAmend || deps.amendBusy) return;
    setAwaitingAmend(false);
    if (deps.amendError === null) setAmendOpen(false);
  }, [awaitingAmend, deps.amendBusy, deps.amendError]);
  const card = deps.card;
  const detail = deps.detail;
  const completion = detail?.completion ?? null;
  const nowYear = new Date().getFullYear();

  return (
    <View style={styles.root} testID={deps.testID ?? 'owner-job-detail'}>
      {deps.onClose !== undefined ? (
        <View style={styles.closeRow}>
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Close detail"
            hitSlop={8}
            onPress={deps.onClose}
            style={styles.closeButton}
            testID="owner-job-detail-close"
          >
            <Text style={styles.closeLabel}>✕ Close</Text>
          </Pressable>
        </View>
      ) : null}

      {deps.detailError !== null ? (
        <EmptyState message={deps.detailError} actionLabel="Retry" onAction={deps.onRetry} testID="owner-job-detail-error" />
      ) : deps.detailLoading && detail === null ? (
        <View style={styles.loading} testID="owner-job-detail-loading">
          <Skeleton width="55%" height={20} />
          <Skeleton width="90%" height={14} />
          <Skeleton width="80%" height={14} />
        </View>
      ) : card === null ? null : (
        <ScrollView contentContainerStyle={styles.content}>
          <Text style={styles.number} testID="owner-job-detail-number">
            {card.jobNumber}
          </Text>
          <View style={styles.titleRow}>
            <View style={[styles.railDot, { backgroundColor: STATUS_COLOR[card.status] ?? STATUS.unassigned }]} />
            <Text style={styles.title} testID="owner-job-detail-title" numberOfLines={1}>
              {card.title}
            </Text>
          </View>
          <Text style={styles.meta} testID="owner-job-detail-meta">
            {`${card.customerName} · ${statusWordOf(card.status)} · ${scheduledLabelOf(card.scheduledFor, nowYear)}`}
          </Text>
          {card.isOverdue ? (
            <Text style={styles.overdue} testID="owner-job-detail-overdue">
              Overdue
            </Text>
          ) : null}

          {/* The completion with its figures (§O4) — from the timeline read, not the list row. */}
          {completion !== null ? (
            <View style={styles.section} testID="owner-job-completion">
              <Text style={styles.sectionLabel}>Completion</Text>
              <Text style={styles.body} testID="owner-job-completion-summary">
                {completion.workSummary}
              </Text>
              <View style={styles.figures} testID="owner-job-completion-figures">
                <FigureRow label="Amount" value={`₹${formatMoneyEnIN(completion.cost ?? '0')}`} testID="owner-job-figure-cost" />
                <FigureRow
                  label="Discount"
                  value={`₹${formatMoneyEnIN(completion.discountAmount ?? '0')}`}
                  testID="owner-job-figure-discount"
                />
                <FigureRow
                  label="Collected"
                  value={`₹${formatMoneyEnIN(completion.amountCollected ?? '0')}`}
                  testID="owner-job-figure-collected"
                />
                <FigureRow
                  label="Mode"
                  value={completion.collectionMode === null ? '—' : completion.collectionMode}
                  testID="owner-job-figure-mode"
                />
              </View>
              {completion.discountReason !== null ? (
                <Text style={styles.caption} testID="owner-job-completion-discount-reason">
                  {`Discount reason: ${completion.discountReason}`}
                </Text>
              ) : null}

              {/* Parts fitted — a record of what was fitted, never a bill. */}
              <View style={styles.parts} testID="owner-job-parts">
                <Text style={styles.sectionLabel}>Parts fitted</Text>
                {completion.parts.length === 0 ? (
                  <Text style={styles.caption} testID="owner-job-parts-empty">
                    No parts recorded.
                  </Text>
                ) : (
                  completion.parts.map((part) => (
                    <View key={part.lineNo} style={styles.partRow} testID={`owner-job-part-${part.lineNo}`}>
                      <Text numberOfLines={1} style={styles.partName}>
                        {`${part.name} × ${part.quantity}`}
                      </Text>
                      <Text style={styles.caption}>
                        {part.serialNumber === null ? '' : `SN ${part.serialNumber}`}
                        {part.fromCustomerStock ? ' · from site stock' : ''}
                      </Text>
                    </View>
                  ))
                )}
              </View>
            </View>
          ) : (
            <View style={styles.section} testID="owner-job-completion">
              <Text style={styles.sectionLabel}>Completion</Text>
              <Text style={styles.caption} testID="owner-job-completion-none">
                Not completed yet — there is nothing to amend.
              </Text>
            </View>
          )}

          {/* The full job_events timeline, oldest first. */}
          <View style={styles.section} testID="owner-job-timeline">
            <Text style={styles.sectionLabel}>Timeline</Text>
            {(detail?.events ?? []).map((event, index) => {
              const payloadLine = eventPayloadLine(event);
              return (
                <View key={event.id} style={styles.eventRow} testID={`owner-job-event-${index}`}>
                  <View style={[styles.eventDot, { backgroundColor: STATUS_COLOR[event.toStatus ?? ''] ?? SEMANTIC.line.focus }]} />
                  <View style={styles.eventBody}>
                    <Text style={styles.eventWord} testID={`owner-job-event-word-${index}`}>
                      {eventWord(event.eventType)}
                      {event.fromStatus !== null && event.eventType === 'status_changed'
                        ? ` · ${statusWordOf(event.fromStatus)} → ${statusWordOf(event.toStatus ?? event.fromStatus)}`
                        : ''}
                    </Text>
                    <Text style={styles.caption}>
                      {`${event.actorName ?? 'System'} · ${formatDateEnIN(event.occurredAt.slice(0, 10), nowYear)} ${event.occurredAt.slice(11, 16)}`}
                    </Text>
                    {payloadLine !== null ? (
                      <Text style={styles.eventPayload} testID={`owner-job-event-payload-${index}`}>
                        {payloadLine}
                      </Text>
                    ) : null}
                  </View>
                </View>
              );
            })}
          </View>

          {/* The amend action — owner only, and only where there is a completion to correct. */}
          {deps.amendFlagOn && completion !== null ? (
            <View style={styles.actions}>
              <Button
                label="Amend completion"
                variant="secondary"
                onPress={() => setAmendOpen(true)}
                fullwidth
                testID="owner-job-amend-open"
              />
            </View>
          ) : null}
        </ScrollView>
      )}

      {card !== null && completion !== null ? (
        <AmendSheet
          visible={amendOpen}
          jobNumber={card.jobNumber}
          current={{
            cost: completion.cost,
            discountAmount: completion.discountAmount,
            discountReason: completion.discountReason,
          }}
          busy={deps.amendBusy}
          error={deps.amendError}
          reopenBusy={deps.reopenBusy}
          onAmend={(input) => {
            setAwaitingAmend(true);
            deps.onAmend(input);
          }}
          onReopen={(reason) => deps.onReopen(reason)}
          onDismiss={() => setAmendOpen(false)}
        />
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  closeRow: { flexDirection: 'row', justifyContent: 'flex-end', paddingHorizontal: SPACE[3], paddingTop: SPACE[2] },
  closeButton: { minHeight: 36, justifyContent: 'center', paddingHorizontal: SPACE[2] },
  closeLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  loading: { padding: SPACE[4], gap: SPACE[2] },
  content: { padding: SPACE[4], paddingBottom: SPACE[8] },
  number: { ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] },
  titleRow: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2], marginTop: 2 },
  railDot: { width: 4, height: 22 },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary, flexShrink: 1 },
  meta: { ...textStyle('caption'), color: SEMANTIC.text.secondary, marginTop: 4 },
  overdue: { ...textStyle('caption'), color: SEMANTIC.feedback.danger, marginTop: 4 },
  section: { marginTop: SPACE[5], gap: SPACE[1] },
  sectionLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  body: { ...textStyle('body'), color: SEMANTIC.text.primary },
  caption: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  figures: { marginTop: SPACE[1], gap: 4 },
  figureRow: { flexDirection: 'row', justifyContent: 'space-between' },
  figureLabel: { ...textStyle('body'), color: SEMANTIC.text.secondary },
  figureValue: { ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  parts: { marginTop: SPACE[3], gap: SPACE[1] },
  partRow: { gap: 0, paddingVertical: 2 },
  partName: { ...textStyle('body'), color: SEMANTIC.text.primary },
  eventRow: { flexDirection: 'row', gap: SPACE[2], paddingVertical: SPACE[2], borderBottomWidth: 1, borderBottomColor: SEMANTIC.line.default },
  eventDot: { width: 8, height: 8, borderRadius: 4, marginTop: 5 },
  eventBody: { flex: 1 },
  eventWord: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  eventPayload: { ...textStyle('caption'), color: SEMANTIC.text.primary, marginTop: 2 },
  actions: { marginTop: SPACE[5] },
});
