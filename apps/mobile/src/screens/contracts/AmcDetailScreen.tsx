/**
 * The AMC detail (T2B.4, §D5 "Detail"): the facts, then every job linked
 * to the AMC, then the actions — Edit · Renew · Cancel (reason required,
 * decision 11: dispatcher and owner edit and cancel). A cancelled AMC
 * renders no actions — a cancelled AMC is a record, not a working surface
 * ("a wrong AMC is cancelled with a reason and recorded again — never
 * deleted", phase rollback note).
 *
 * Pure over injected props; `useContractDetail` and `useSaveContract`
 * (route side) own the reads and writes. The cancel sheet keeps its
 * reason blank-disabled: the button answers nothing the dispatcher has
 * not said.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import type { ContractDetail } from '@servgrid/shared';
import { Banner, Button, Sheet, TextField } from '../../components/ui';
import { StatusPill } from '../../components/domain/StatusPill';
import { formatDateEnIN, formatDateWithYear } from '../../components/ui';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import { openJobLine, stateLabel } from './model';

export interface AmcDetailScreenProps {
  detail: ContractDetail | null;
  loading: boolean;
  error: string | null;
  onRetry(): void;
  onEdit(): void;
  onRenew(): void;
  onOpenJob(jobId: string): void;
  /** Resolves when the cancel went through — the route closes over the refetch. */
  onCancel(reason: string): Promise<void>;
  cancelling: boolean;
  cancelError: string | null;
  testID?: string;
}

export function AmcDetailScreen(props: AmcDetailScreenProps): React.ReactNode {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reason, setReason] = useState('');
  const nowYear = new Date().getFullYear();
  const c = props.detail?.contract ?? null;
  const jobs = props.detail?.jobs ?? [];
  const cancelled = c?.state === 'cancelled';

  const submitCancel = (): void => {
    if (reason.trim() === '') return;
    void props.onCancel(reason.trim()).then(
      () => {
        // Success: the route refetches, the sheet closes, the reason goes.
        setSheetOpen(false);
        setReason('');
      },
      () => {
        // Refused: the route's cancelError renders in the sheet, and the
        // sheet stays open — the reason is never lost.
      },
    );
  };

  return (
    <View style={styles.screen} testID={props.testID ?? 'amc-detail'}>
      <ScrollView contentContainerStyle={styles.content}>
        {props.error !== null ? (
          <Banner
            tone="danger"
            message={props.error}
            actions={[{ label: 'Retry', onPress: props.onRetry }]}
            testID="amc-detail-error"
          />
        ) : null}

        {c !== null ? (
          <>
            <View testID="amc-detail-facts">
              <Text style={styles.number} testID="amc-detail-number">
                {c.contractNumber}
              </Text>
              <Text style={styles.customer} testID="amc-detail-customer">
                {c.customerName}
              </Text>
              <Text style={styles.meta} testID="amc-detail-term">
                {`${formatDateWithYear(c.startDate)} – ${formatDateWithYear(c.endDate)}`}
              </Text>
              <Text style={styles.meta} testID="amc-detail-price">
                {`₹${formatMoneyEnIN(c.contractValue)}`}
              </Text>
              <Text style={styles.meta} testID="amc-detail-state">
                {stateLabel(c.state)}
              </Text>
              <Text style={styles.meta} testID="amc-detail-service">
                {c.lastServiceDate === null
                  ? 'no completed job yet'
                  : `last service ${formatDateWithYear(c.lastServiceDate)}`}
              </Text>
              {c.state === 'active' ? (
                <Text style={styles.meta} testID="amc-detail-next-due">
                  {`next visit due ${formatDateWithYear(c.nextVisitDue)}`}
                </Text>
              ) : null}
              {openJobLine(c) !== null ? (
                <Text style={styles.meta} testID="amc-detail-open-job">
                  {openJobLine(c)}
                </Text>
              ) : null}
              {c.notes !== null ? (
                <Text style={styles.meta} testID="amc-detail-notes">
                  {c.notes}
                </Text>
              ) : null}
            </View>

            <Text style={styles.sectionLabel}>JOBS UNDER THIS AMC</Text>
            {jobs.length === 0 ? (
              <Text style={styles.emptyLine} testID="amc-detail-jobs-empty">
                No job has been linked to this AMC yet.
              </Text>
            ) : (
              <View testID="amc-detail-jobs">
                {jobs.map((job) => (
                  <Pressable
                    key={job.id}
                    accessibilityRole="button"
                    onPress={() => props.onOpenJob(job.id)}
                    style={styles.jobRow}
                    testID={`amc-detail-job-${job.id}`}
                  >
                    <View style={styles.jobMain}>
                      <Text numberOfLines={1} style={styles.jobTitle}>
                        {`${job.jobNumber} · ${job.title}`}
                      </Text>
                      <Text numberOfLines={1} style={styles.jobMeta}>
                        {job.scheduledFor !== null
                          ? formatDateEnIN(job.scheduledFor.slice(0, 10), nowYear)
                          : job.closedAt !== null
                            ? formatDateEnIN(job.closedAt.slice(0, 10), nowYear)
                            : 'no date'}
                        {job.assignedToName === null ? '' : ` · ${job.assignedToName}`}
                      </Text>
                    </View>
                    {/* `alignSelf` is said on the pill, not from this row:
                        the pill hugs itself with `flex-start`, which in a
                        row parent is the TOP edge — it rode high over the
                        two-line job block (2026-09-17). */}
                    <StatusPill status={job.status} style={styles.jobPill} testID={`amc-detail-job-status-${job.id}`} />
                  </Pressable>
                ))}
              </View>
            )}

            {cancelled ? null : (
              <View style={styles.actions} testID="amc-detail-actions">
                <Button label="Edit" variant="secondary" onPress={props.onEdit} testID="amc-detail-edit" />
                <Button label="Renew" variant="secondary" onPress={props.onRenew} testID="amc-detail-renew" />
                <Button
                  label="Cancel AMC"
                  variant="danger"
                  onPress={() => {
                    haptic('pickerSelect');
                    setSheetOpen(true);
                  }}
                  testID="amc-detail-cancel"
                />
              </View>
            )}
          </>
        ) : null}
      </ScrollView>

      <Sheet
        visible={sheetOpen}
        title="Cancel this AMC"
        hasUnsavedInput={reason.trim() !== ''}
        onDismiss={() => setSheetOpen(false)}
        testID="amc-cancel-sheet"
        actions={
          <Button
            label="Cancel AMC"
            variant="danger"
            loading={props.cancelling}
            disabled={reason.trim() === ''}
            disabledReason="Say why, so the record reads honestly."
            onPress={submitCancel}
            fullwidth
            testID="amc-cancel-confirm"
          />
        }
      >
        <TextField
          label="Why is this AMC cancelled?"
          value={reason}
          onChangeText={setReason}
          multiline
          rows={3}
          helperText="Jobs already raised under it are not touched."
          testID="amc-cancel-reason"
        />
        {props.cancelError !== null ? (
          <Banner tone="danger" message={props.cancelError} testID="amc-cancel-error" />
        ) : null}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  content: { paddingHorizontal: SPACE[4], paddingBottom: SPACE[8] },
  number: {
    ...textStyle('h1'),
    color: SEMANTIC.text.primary,
    paddingTop: SPACE[3],
    fontVariant: ['tabular-nums'],
  },
  customer: { ...textStyle('h2'), color: SEMANTIC.text.primary, marginTop: 2 },
  meta: { ...textStyle('body'), color: SEMANTIC.text.secondary, marginTop: SPACE[1] },
  sectionLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
    marginTop: SPACE[5],
    marginBottom: SPACE[1],
  },
  emptyLine: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
    paddingVertical: SPACE[2],
  },
  jobRow: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  jobMain: { flex: 1, gap: 2 },
  /** The pill centres on the row's axis — see the note at the call site. */
  jobPill: { alignSelf: 'center' },
  jobTitle: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  jobMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  actions: {
    flexDirection: 'row',
    flexWrap: 'wrap',
    gap: SPACE[2],
    marginTop: SPACE[5],
  },
});
