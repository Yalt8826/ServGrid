/**
 * T1.22 spike row — the 56pt two-line dispatcher row (§D2).
 *
 * ```
 * ▌JC-…0042  Kormangala 3rd Blk
 * ▌Ravi · 14:30            ● In progress
 * ```
 *
 * The density decision, verbatim from D2: two lines at 56pt, not cards —
 * eight jobs per phone screen where a field-density card list shows four,
 * with the scannable left edge intact. The row itself is the tap target
 * at 56pt (above the global 52); the left rail carries **status colour**
 * so "what state is everything in" reads peripherally, without reading.
 * `overdue` is a filter, not a status — it renders as an outlined danger
 * chip inline on line 2, never as a rail colour.
 *
 * THROWAWAY INSTRUMENTATION: the module-level render counter exists only
 * so the perf harness can prove the memo holds under filter changes.
 * This pattern must not outlive the spike.
 */
import { memo } from 'react';
import { Pressable, Text, View } from 'react-native';

import { DENSITY, SEMANTIC, STATUS, type JobStatus } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { firstName, shortJobNumber, slotLabel } from './mockJobs';
import type { SpikeJob } from './mockJobs';

let rowRenders = 0;

/** Throwaway instrumentation — reset between measurement passes. */
export function resetRowRenderCount(): void {
  rowRenders = 0;
}

/** Throwaway instrumentation — how many times any row rendered. */
export function rowRenderCount(): number {
  return rowRenders;
}

const ROW_HEIGHT = DENSITY.console.rowHeight; // 56 — the D2 row
const RAIL_WIDTH = 3;

/** The label and colour for the status dot. `assigned` has no dedicated
 * ramp entry in the token set — it rides the muted info slate, as the
 * technician JobCard does for non-live, non-terminal states. */
function statusTone(status: JobStatus): { label: string; color: string } {
  switch (status) {
    case 'completed':
      return { label: 'Completed', color: STATUS.completed };
    case 'en_route':
      return { label: 'En route', color: STATUS.en_route };
    case 'in_progress':
      return { label: 'In progress', color: STATUS.in_progress };
    case 'cancelled':
      return { label: 'Cancelled', color: STATUS.cancelled };
    case 'unassigned':
      return { label: 'Unassigned', color: STATUS.unassigned };
    default:
      return { label: 'Assigned', color: STATUS.unassigned };
  }
}

const styles = {
  row: {
    flexDirection: 'row' as const,
    height: ROW_HEIGHT,
    backgroundColor: SEMANTIC.bg.raised,
  },
  rail: { width: RAIL_WIDTH },
  body: {
    flex: 1,
    paddingHorizontal: 12,
    justifyContent: 'center' as const,
  },
  line1: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  jobNumber: {
    ...textStyle('mono'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums' as const],
  },
  area: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
    flexShrink: 1,
  },
  line2: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
  },
  who: {
    ...textStyle('body'),
    color: SEMANTIC.text.secondary,
  },
  overdueChip: {
    borderWidth: 1,
    borderColor: SEMANTIC.feedback.danger,
    color: SEMANTIC.feedback.danger,
    ...textStyle('caption'),
    paddingHorizontal: 4,
  },
  spacer: { flex: 1 },
  status: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 4,
  },
  dot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
};

/**
 * Memoised: the row re-renders only when ITS job changes — the screen
 * swaps the whole `data` array on every keystroke, and every row that
 * did not change must skip re-rendering (02-MOTION.md §9).
 */
export const JobLogsRow = memo(function JobLogsRow({
  job,
  overdue,
  onPress,
  testID,
}: {
  job: SpikeJob;
  overdue: boolean;
  onPress: (job: SpikeJob) => void;
  testID?: string;
}): React.ReactNode {
  rowRenders += 1;
  const tone = statusTone(job.status);
  return (
    <Pressable
      style={styles.row}
      testID={testID}
      onPress={() => onPress(job)}
      accessibilityRole="button"
      accessibilityLabel={`${shortJobNumber(job.jobNumber)} ${job.area} ${job.technician ?? 'unassigned'} ${tone.label}`}
    >
      <View style={[styles.rail, { backgroundColor: STATUS[job.status as keyof typeof STATUS] ?? STATUS.unassigned }]} />
      <View style={styles.body}>
        <View style={styles.line1}>
          <Text style={styles.jobNumber}>{shortJobNumber(job.jobNumber)}</Text>
          <Text style={styles.area} numberOfLines={1}>
            {job.area}
          </Text>
        </View>
        <View style={styles.line2}>
          <Text style={styles.who} numberOfLines={1}>
            {job.technician === null ? 'Unassigned' : `${firstName(job.technician)} · ${slotLabel(job.scheduledFor)}`}
          </Text>
          {overdue ? <Text style={styles.overdueChip}>Overdue</Text> : null}
          <View style={styles.spacer} />
          <View style={styles.status}>
            <View style={[styles.dot, { backgroundColor: tone.color }]} />
            <Text style={styles.statusLabel}>{tone.label}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );
});
