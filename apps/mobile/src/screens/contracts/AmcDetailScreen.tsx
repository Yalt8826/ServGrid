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

import { alpha, COLORS, formatMoneyEnIN, FRAME, ICON, RADII, SEMANTIC, SPACE, TAP, TINT } from '@servgrid/shared';
import type { ContractDetail } from '@servgrid/shared';
import { Banner, Button, SectionHeader, Sheet, TextField, useDensity } from '../../components/ui';
import { StatusPill } from '../../components/domain/StatusPill';
import { formatDateEnIN, formatDateWithYear } from '../../components/ui';
import { Icon } from '../../components/ui/icons';
import { haptic } from '../../components/ui/haptics';
import { textStyle } from '../../fonts/textStyle';
import { contractStateTone, lastServiceDateLabel, nextVisitDueDateLabel, openJobLine } from './model';
import { useMemo } from 'react';

const hitSlop = { top: TAP.hitSlop, bottom: TAP.hitSlop, left: TAP.hitSlop, right: TAP.hitSlop };

export interface AmcDetailScreenProps {
  detail: ContractDetail | null;
  loading: boolean;
  error: string | null;
  onRetry(): void;
  /** The bar's way back. Omitted in tests, which render the screen bare. */
  onBack?(): void;
  onEdit(): void;
  onRenew(): void;
  onOpenJob(jobId: string): void;
  /** Resolves when the cancel went through — the route closes over the refetch. */
  onCancel(reason: string): Promise<void>;
  cancelling: boolean;
  cancelError: string | null;
  testID?: string;
}

/**
 * One fact: its name on the left in caption ink, its value on the right in
 * the body's own ink (mono for anything with digits). `tone` turns the
 * value into the app's chip when the fact IS a state.
 */
function FactRow({
  label,
  value,
  testID,
  mono = false,
  tone,
  first = false,
}: {
  label: string;
  value: string;
  testID: string;
  mono?: boolean;
  /** A state's own colour: the value becomes a dot-and-word chip. */
  tone?: string;
  first?: boolean;
}): React.ReactNode {
  const density = useDensity();
  const valueStyle = useMemo(() => [styles.factValue, mono ? styles.factMono : textStyle('bodyStrong', density)], [density, mono]);
  return (
    <View style={[styles.factRow, first ? null : styles.factRowNext]}>
      <Text style={styles.factLabel}>{label}</Text>
      {tone === undefined ? (
        <Text numberOfLines={2} style={valueStyle} testID={testID}>
          {value}
        </Text>
      ) : (
        <View style={styles.factChip}>
          <View style={[styles.factDot, { backgroundColor: tone }]} />
          <Text style={styles.factChipWord} testID={testID}>
            {value}
          </Text>
        </View>
      )}
    </View>
  );
}

export function AmcDetailScreen(props: AmcDetailScreenProps): React.ReactNode {
  const [sheetOpen, setSheetOpen] = useState(false);
  const [reason, setReason] = useState('');
  const nowYear = new Date().getFullYear();
  // Shared screen: console for the dispatcher, field for the owner's phone,
  // desk on the web — the body ink follows the density it is read at.
  const density = useDensity();
  const meta = useMemo(() => [styles.meta, textStyle('body', density)], [density]);
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
      {/* The navy bar: what this record is (the number), whose it is, and
          the way back — the pushed screen's own header (2026-09-17). */}
      <View style={styles.frame}>
        {props.onBack === undefined ? null : (
          <Pressable
            testID="amc-detail-back"
            accessibilityRole="button"
            accessibilityLabel="Back"
            hitSlop={hitSlop}
            onPress={props.onBack}
            style={styles.back}
          >
            <Icon name="back" size={ICON.lg} color={FRAME.text} />
          </Pressable>
        )}
        <View style={styles.frameBody}>
          <Text style={styles.frameTitle} testID="amc-detail-bar-number">
            {c?.contractNumber ?? 'AMC'}
          </Text>
          {c === null ? null : (
            <Text numberOfLines={1} style={styles.frameCaption}>
              {c.customerName}
            </Text>
          )}
        </View>
      </View>
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
              <SectionHeader label="Contract" icon="document" />
              {/* One panel, one fact per row — label left, value right —
                  where the record used to be nine grey lines in a column. */}
              <View style={styles.panel}>
                <FactRow label="Number" mono testID="amc-detail-number" value={c.contractNumber} first />
                <FactRow label="Customer" testID="amc-detail-customer" value={c.customerName} />
                <FactRow
                  label="Term"
                  mono
                  testID="amc-detail-term"
                  value={`${formatDateWithYear(c.startDate)} – ${formatDateWithYear(c.endDate)}`}
                />
                <FactRow label="Price" mono testID="amc-detail-price" value={`₹${formatMoneyEnIN(c.contractValue)}`} />
                <FactRow
                  label="State"
                  testID="amc-detail-state"
                  value={contractStateTone(c.state).label}
                  tone={contractStateTone(c.state).color}
                />
                <FactRow label="Last service" testID="amc-detail-service" value={lastServiceDateLabel(c)} />
                {c.state === 'active' ? (
                  <FactRow label="Next visit due" testID="amc-detail-next-due" value={nextVisitDueDateLabel(c)} />
                ) : null}
              </View>
              {/* A job already booked under this contract is the fact the
                  caller is asking about — it gets its own strip. */}
              {openJobLine(c) !== null ? (
                <View style={styles.openStrip}>
                  <Icon name="calendar" size={ICON.sm} color={SEMANTIC.text.primary} />
                  <Text style={meta} testID="amc-detail-open-job">
                    {openJobLine(c)}
                  </Text>
                </View>
              ) : null}
              {c.notes === null ? null : (
                <>
                  <SectionHeader label="Notes" icon="edit" />
                  <View style={styles.panel}>
                    <Text style={styles.notes} testID="amc-detail-notes">
                      {c.notes}
                    </Text>
                  </View>
                </>
              )}
            </View>

            <SectionHeader
              label="Jobs under this AMC"
              icon="list"
              count={jobs.length}
            />
            {jobs.length === 0 ? (
              <Text style={[styles.emptyLine, textStyle('body', density)]} testID="amc-detail-jobs-empty">
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

            {/* A cancelled AMC is a record, not a working surface — the
                marker goes with the buttons it names. */}
            {cancelled ? null : (
              <>
                <SectionHeader label="Actions" icon="edit" tint={COLORS.accent} />
                <View style={styles.actions} testID="amc-detail-actions">
                  <Button label="Edit" icon="edit" variant="secondary" onPress={props.onEdit} testID="amc-detail-edit" />
                  <Button label="Renew" icon="forward" variant="secondary" onPress={props.onRenew} testID="amc-detail-renew" />
                  <Button
                    label="Cancel AMC"
                    icon="close"
                    variant="danger"
                    onPress={() => {
                      haptic('pickerSelect');
                      setSheetOpen(true);
                    }}
                    testID="amc-detail-cancel"
                  />
                </View>
              </>
            )}
          </>
        ) : null}
      </ScrollView>

      {sheetOpen ? (
      <Sheet
        visible
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
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  /** The navy bar: the record's number and whose it is. */
  frame: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    backgroundColor: FRAME.bg,
    paddingHorizontal: SPACE[3],
    paddingTop: SPACE[2],
    paddingBottom: SPACE[2],
    minHeight: TAP.console + SPACE[3],
  },
  back: { minWidth: TAP.console, minHeight: TAP.console, alignItems: 'center', justifyContent: 'center' },
  frameBody: { flex: 1, gap: 2 },
  frameTitle: { ...textStyle('h2'), color: FRAME.text, fontVariant: ['tabular-nums'] },
  frameCaption: { ...textStyle('caption'), color: FRAME.textMuted },
  content: { paddingHorizontal: SPACE[4], paddingBottom: SPACE[8], paddingTop: SPACE[2] },
  /** One panel, one fact per row — the console's record shape. */
  panel: {
    marginTop: SPACE[3],
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  factRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    minHeight: TAP.console,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
  },
  factRowNext: { borderTopWidth: 1, borderTopColor: SEMANTIC.line.default },
  factLabel: { ...textStyle('caption'), color: SEMANTIC.text.secondary, flex: 1 },
  factValue: { color: SEMANTIC.text.primary, flexShrink: 1, textAlign: 'right' },
  factMono: { ...textStyle('mono'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  factChip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: 6,
    paddingHorizontal: SPACE[2],
    paddingVertical: 3,
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.app,
  },
  factDot: { width: 8, height: 8, borderRadius: 4 },
  factChipWord: { ...textStyle('label'), color: SEMANTIC.text.primary },
  /** A visit already booked under the contract. */
  openStrip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    marginTop: SPACE[3],
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: alpha(COLORS.accent, TINT.chipLine),
    backgroundColor: alpha(COLORS.accent, TINT.chip),
  },
  notes: { ...textStyle('body'), color: SEMANTIC.text.primary, paddingHorizontal: SPACE[3], paddingVertical: SPACE[3] },
  meta: { ...textStyle('body'), color: SEMANTIC.text.secondary, flex: 1 },
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
