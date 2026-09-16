/**
 * D2 Job Logs (T2.8, UI/plan-2/05-DISPATCHER.md §D2) — the screen where
 * phone-first costs something: a dispatcher answers "who has the
 * Kormangala jobs today" in under five seconds, on a phone, against
 * 200+ jobs. Everything here exists to make that five seconds real.
 *
 * The screen is pure over injected data (the same seam T2.7's dashboard
 * uses); `useJobLogs` is the online-only wiring that feeds it and the
 * URL owns the filter state — this component never holds it.
 *
 * Anatomy, exactly: header ("Job Logs", search); the FilterBar sticky
 * under the header — sticky by LAYOUT, a sibling above the FlashList, so
 * it cannot collapse on scroll; the result count always visible above
 * the list ("24 jobs · 3 overdue" — the dispatcher knows whether the
 * filter worked before scrolling); two-line rows at 56pt, not cards —
 * eight jobs per screen where a field card list shows four.
 *
 * Density (01-FOUNDATIONS.md §3): the ROW is the tap target at 56pt,
 * above the global 52; the 44pt `console` floor applies to the filter
 * chips and header actions, each with 8pt hit slop. The left rail
 * carries status colour and is never alone — the status word rides
 * beside it (§1.6), always.
 *
 * Multi-select (§5.4): long-press at the 400ms threshold fires the
 * `Selection` haptic BEFORE the finger lifts, the row scales to 0.97
 * with its border strengthened, and the header cross-fades to
 * "N selected" with Reassign and Cancel. No checkboxes — at this density
 * they would be a 24pt target next to a 56pt row.
 *
 * Motion (§D2): a filter change re-sorts with NO animation — no stagger,
 * no re-entrance; the list simply is the new rows. The only motion is
 * the chip fill (140ms) and the row press state (90ms, a state swap, not
 * a tween). The animated pick-up style is attached to a row ONLY while
 * that row is selected — a filter change (which exits selection)
 * attaches nothing animated to any row, which is exactly the assertion
 * the spec's test makes.
 *
 * Offline: the danger banner, the list dims, the FILTERS disable — a
 * filter applied to stale data produces a confident wrong answer.
 *
 * Search is a separate mode, not a field competing with the filter bar:
 * the ⌕ swaps the bar for a full-width search over job number, customer
 * and phone (the server's `q`), with results in the same row component.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlashList } from '@shopify/flash-list';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import { DENSITY, JOB_STATUSES, SEMANTIC, SPACE, SPRING, STATUS, TAP, type JobStatus } from '@servgrid/shared';
import { TechnicianLoadRow } from '../../components/domain/TechnicianLoadRow';
import { Banner, Button, EmptyState, Select, Sheet, Skeleton, TextField, useDensity } from '../../components/ui';
import { haptic } from '../../components/ui/haptics';
import { useSkeleton } from '../../components/ui/Skeleton';
import { useToggleProgress } from '../../components/ui/motion';
import { textStyle } from '../../fonts/textStyle';
import {
  countOverdueRows,
  formatResultCount,
  jobLogsChipLabel,
  jobLogsFiltersAreDefault,
  sortJobLogs,
  shortJobNumber,
  type JobLogsDateFilter,
  type JobLogsFilters,
  type JobLogsJob,
  type JobLogsStatusFilter,
} from './jobLogsFilters';

export const JOB_LOGS_OFFLINE_MESSAGE = 'No connection. This screen is not live.';

const ROW_HEIGHT = DENSITY.console.rowHeight; // 56 — the D2 row, the measurement FlashList v2 converges on
const RAIL_WIDTH = 3;
/** §5.4: the long-press threshold the `Selection` haptic fires at. */
export const LONG_PRESS_THRESHOLD_MS = 400;

/** One roster row — the technician chip's options and the picker's. */
export interface JobLogsTechnician {
  employeeId: string;
  name: string;
  openTotal: number;
}

/** One refused job inside a bulk reassign — named, honestly (§D2). */
export interface JobLogsBulkFailure {
  jobId: string;
  jobNumber: string;
  message: string;
}

/** The bulk outcome the dispatcher reads: counts plus the named failures. */
export interface JobLogsBulkOutcome {
  reassigned: number;
  failed: number;
  failures: JobLogsBulkFailure[];
}

/**
 * "5 reassigned, 1 failed — JC-…0044: This job is already completed —
 * that is final." The server's own sentence for the refusal, next to the
 * job it refused: partial results are shown honestly, never flattened
 * into a spin.
 */
export function formatBulkOutcome(outcome: JobLogsBulkOutcome): string {
  if (outcome.failed === 0) return `${outcome.reassigned} reassigned.`;
  const first = outcome.failures[0];
  const named = first === undefined ? '.' : ` — ${shortJobNumber(first.jobNumber)}: ${first.message}`;
  return `${outcome.reassigned} reassigned, ${outcome.failed} failed${named}`;
}

export interface JobLogsDeps {
  /** Injectable clock — the date chip's "today" is judged by it. */
  now: Date;
  offline: boolean;
  /** First page still loading — skeleton rows after 200ms (§D2). */
  loading: boolean;
  /** The current view's rows, server-filtered; null while loading. */
  jobs: JobLogsJob[] | null;
  error: string | null;
  /** The roster, for the technician chip and the reassign picker. */
  technicians: JobLogsTechnician[];
  /** URL-owned filter state; the screen renders it and requests changes. */
  filters: JobLogsFilters;
  /** Search mode's text, URL-owned like the filters. */
  query: string;
  /** `dispatch.bulk` gates Reassign alone — the risky half, separate. */
  bulkFlagOn: boolean;
  bulkBusy: boolean;
  bulkOutcome: JobLogsBulkOutcome | null;
  bulkError: string | null;
  onFiltersChange(next: JobLogsFilters): void;
  onQueryChange(query: string): void;
  onOpenJob(jobId: string): void;
  /** The selection rides along — the screen owns it, the route sends it. */
  onReassign(jobIds: string[], technicianId: string): void;
  onDismissBulk(): void;
  onRetry(): void;
  /** Cursor pagination — the list asks for the next page on end-reached. */
  onLoadMore(): void;
}

export interface JobLogsOption<T> {
  value: T;
  label: string;
}

/** The date chip's sheet, in display order. */
export const JOB_LOGS_DATE_OPTIONS: readonly JobLogsOption<JobLogsDateFilter>[] = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'This week' },
  { value: 'all', label: 'All days' },
];

const STATUS_LABELS: Record<JobLogsStatusFilter, string> = {
  any: 'Any status',
  overdue: 'Overdue',
  unassigned: 'Unassigned',
  assigned: 'Assigned',
  en_route: 'En route',
  in_progress: 'In progress',
  completed: 'Completed',
  cancelled: 'Cancelled',
};

/** The status chip's sheet — overdue is an option, never a status. */
export const JOB_LOGS_STATUS_OPTIONS: readonly JobLogsOption<JobLogsStatusFilter>[] = [
  { value: 'any', label: 'Any status' },
  { value: 'overdue', label: 'Overdue' },
  ...JOB_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s] })),
];

function optionTestId(label: string): string {
  return `filter-option-${label.toLowerCase().replace(/\s+/g, '-')}`;
}

/** `assigned` has no dedicated ramp entry — it rides the unassigned
 * slate, exactly as the technician JobCard does (T1.22's resolution). */
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

const hitSlop = { top: TAP.hitSlop, bottom: TAP.hitSlop, left: TAP.hitSlop, right: TAP.hitSlop };

// ── the row ──────────────────────────────────────────────────────────────

/**
 * ▌JC-…0042  Kormangala 3rd Blk        → line 1: number + the work
 * ▌Ravi · 14:30            ● In progress → line 2: who · when, status
 *
 * Memoised: the row re-renders only when ITS item changes — the screen
 * swaps the whole `data` array on a filter change, and every row that
 * did not change must skip re-rendering (02-MOTION.md §9).
 */
const JobLogsRow = memo(function JobLogsRow({
  job,
  selected,
  onPress,
  onLongPress,
  testID,
}: {
  job: JobLogsJob;
  selected: boolean;
  onPress: (job: JobLogsJob) => void;
  onLongPress: (job: JobLogsJob) => void;
  testID: string;
}): React.ReactNode {
  const [pressed, setPressed] = useState(false);
  const tone = statusTone(job.status);

  // §5.4 long-press pick-up: at the 400ms threshold the row scales to
  // 0.97 (spring.press) over a strengthened border. The animated style
  // joins the tree ONLY while this row is selected — unselected rows
  // carry nothing animated, ever.
  const scale = useSharedValue(1);
  useEffect(() => {
    scale.value = withSpring(selected ? 0.97 : 1, SPRING.press);
  }, [scale, selected]);
  const pickUp = useAnimatedStyle(() => ({ transform: [{ scale: scale.value }] }));

  const row = (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected }}
      delayLongPress={LONG_PRESS_THRESHOLD_MS}
      onPress={() => onPress(job)}
      onLongPress={() => onLongPress(job)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      hitSlop={hitSlop}
      style={[
        styles.row,
        pressed ? styles.rowPressed : null,
        selected ? styles.rowSelected : null,
      ]}
    >
      <View style={[styles.rail, { backgroundColor: STATUS[job.status as keyof typeof STATUS] ?? STATUS.unassigned }]} />
      <View style={styles.body}>
        <View style={styles.line1}>
          <Text style={styles.jobNumber}>{shortJobNumber(job.jobNumber)}</Text>
          <Text numberOfLines={1} style={styles.rowTitle}>
            {job.title}
          </Text>
        </View>
        <View style={styles.line2}>
          <Text numberOfLines={1} style={styles.who}>
            {job.technicianName === null ? 'Unassigned' : `${firstName(job.technicianName)} · ${slotLabel(job.scheduledFor)}`}
          </Text>
          {job.overdue ? <Text style={styles.overdueChip}>Overdue</Text> : null}
          <View style={styles.spacer} />
          <View style={styles.status}>
            <View style={[styles.dot, { backgroundColor: tone.color }]} />
            <Text style={styles.statusLabel}>{tone.label}</Text>
          </View>
        </View>
      </View>
    </Pressable>
  );

  if (!selected) return row;
  return <Animated.View style={pickUp}>{row}</Animated.View>;
});

/** Row label uses the technician's first name (`Ravi · 14:30`). */
function firstName(technician: string): string {
  return technician.split(' ')[0] ?? technician;
}

/** `14:30` — the IST wall clock the api already sends. */
function slotLabel(scheduledFor: string | null): string {
  return scheduledFor === null ? 'no date' : scheduledFor.slice(11, 16);
}

// ── hoisted list plumbing — no per-render closures reach a row ───────────

const openJobRef: { current: ((jobId: string) => void) | null } = { current: null };
const armSelectionRef: { current: ((jobId: string) => void) | null } = { current: null };
const toggleSelectionRef: { current: ((jobId: string) => void) | null } = { current: null };

interface JobLogsListItem extends JobLogsJob {
  selected: boolean;
}

const RowItem = memo(function RowItem({ item }: { item: JobLogsListItem }): React.ReactNode {
  return (
    <JobLogsRow
      job={item}
      selected={item.selected}
      onPress={(j) => (item.selected ? toggleSelectionRef.current?.(j.id) : openJobRef.current?.(j.id))}
      onLongPress={(j) => armSelectionRef.current?.(j.id)}
      testID={`job-logs-row-${item.id}`}
    />
  );
});

const renderItem = ({ item }: { item: JobLogsListItem }) => <RowItem item={item} />;

const keyExtractor = (item: JobLogsListItem): string => item.id;

// ── the filter bar ───────────────────────────────────────────────────────

type ChipKey = 'date' | 'tech' | 'status';

/**
 * One 44pt console chip — the floor D2 allows here and nowhere else,
 * with hit slop 8 putting the effective target back at 52 (§3). The fill
 * change is the screen's one allowed chip motion (140ms, `quick`).
 */
function FilterChip({
  label,
  active,
  disabled,
  onPress,
  testID,
}: {
  label: string;
  active: boolean;
  disabled: boolean;
  onPress: () => void;
  testID: string;
}): React.ReactNode {
  const [pressed, setPressed] = useState(false);
  return (
    <Pressable
      testID={testID}
      accessibilityRole="button"
      accessibilityState={{ selected: active, disabled }}
      disabled={disabled}
      hitSlop={hitSlop}
      onPress={() => {
        // Belt and braces: the Pressable is disabled offline too — a
        // filter applied to stale data is the confident wrong answer.
        if (disabled) return;
        haptic('pickerSelect');
        onPress();
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[styles.chip, active ? styles.chipActive : null, disabled ? styles.chipDisabled : null, pressed ? styles.chipPressed : null]}
    >
      <Text style={active ? styles.chipLabelActive : styles.chipLabel}>{label} ▾</Text>
    </Pressable>
  );
}

/**
 * The persistent bar — sticky by LAYOUT: a sibling above the FlashList,
 * it cannot scroll away (FlashList owns no sticky headers; T1.22's
 * resolution). One option sheet open at a time; choosing applies and
 * closes; ✕ clears everything and is visible exactly when the filters
 * are not default.
 *
 * EXPORTED since T4.11: the owner's job list (07-OWNER.md §O4, "Phone:
 * `JobCard` list with the dispatcher's filter bar") mounts THIS bar —
 * the same chips, the same sheets, the same filter state type — instead
 * of a second filter bar drifting beside it.
 */
export function FilterBar({
  filters,
  technicians,
  offline,
  onChange,
  onClear,
}: {
  filters: JobLogsFilters;
  technicians: readonly JobLogsTechnician[];
  offline: boolean;
  onChange: (next: JobLogsFilters) => void;
  onClear: () => void;
}): React.ReactNode {
  const [open, setOpen] = useState<ChipKey | null>(null);
  const desk = useDensity() === 'desk';

  const nameOf = useCallback(
    (technicianId: string): string | null => technicians.find((t) => t.employeeId === technicianId)?.name ?? null,
    [technicians],
  );

  const techOptions: readonly JobLogsOption<string>[] = useMemo(
    () => [{ value: 'anyone', label: 'Anyone' }, ...technicians.map((t) => ({ value: t.employeeId, label: t.name }))],
    [technicians],
  );

  const options: readonly JobLogsOption<unknown>[] =
    open === 'date' ? JOB_LOGS_DATE_OPTIONS : open === 'status' ? JOB_LOGS_STATUS_OPTIONS : open === 'tech' ? techOptions : [];

  const applyOption = (option: JobLogsOption<unknown>): void => {
    if (open === 'date') onChange({ ...filters, date: option.value as JobLogsDateFilter });
    else if (open === 'status') onChange({ ...filters, status: option.value as JobLogsStatusFilter });
    else if (open === 'tech') {
      onChange({
        ...filters,
        tech:
          option.value === 'anyone'
            ? { kind: 'anyone' }
            : { kind: 'tech', technicianId: option.value as string, name: option.label },
      });
    }
    setOpen(null);
  };

  const isActive = (key: ChipKey): boolean => {
    if (key === 'date') return filters.date !== 'today';
    if (key === 'status') return filters.status !== 'any';
    return filters.tech.kind !== 'anyone';
  };

  const isOptionSelected = (option: JobLogsOption<unknown>): boolean => {
    if (open === 'date') return filters.date === option.value;
    if (open === 'status') return filters.status === option.value;
    if (open === 'tech') return filters.tech.kind === 'tech' && filters.tech.technicianId === option.value;
    return false;
  };

  // The DESK filter bar (OW.1/OW.3, 2026-09-16): real dropdowns, because
  // a console filter is a pointer control — a chip that opens a bottom
  // sheet is a phone idiom, and on the owner's desk it read as unfinished
  // and behaved like nothing at all. The phone keeps its chips below.
  if (desk) {
    const techValue = filters.tech.kind === 'anyone' ? 'anyone' : filters.tech.technicianId;
    return (
      <View style={styles.deskBar} testID="job-logs-filter-bar">
        <View style={styles.deskField}>
          <Select
            label="Day"
            value={filters.date}
            options={JOB_LOGS_DATE_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            onSelect={(value) => onChange({ ...filters, date: value as JobLogsDateFilter })}
            disabled={offline}
            testID="job-logs-filter-date"
          />
        </View>
        <View style={styles.deskField}>
          <Select
            label="Technician"
            value={techValue}
            options={techOptions.map((o) => ({ value: String(o.value), label: o.label }))}
            onSelect={(value) =>
              onChange({
                ...filters,
                tech:
                  value === 'anyone'
                    ? { kind: 'anyone' }
                    : { kind: 'tech', technicianId: value, name: nameOf(value) ?? '' },
              })
            }
            disabled={offline}
            testID="job-logs-filter-tech"
          />
        </View>
        <View style={styles.deskField}>
          <Select
            label="Status"
            value={filters.status}
            options={JOB_LOGS_STATUS_OPTIONS.map((o) => ({ value: String(o.value), label: o.label }))}
            onSelect={(value) => onChange({ ...filters, status: value as JobLogsStatusFilter })}
            disabled={offline}
            testID="job-logs-filter-status"
          />
        </View>
        {jobLogsFiltersAreDefault(filters) ? null : (
          <Button label="Clear" variant="secondary" onPress={onClear} testID="job-logs-filter-clear" />
        )}
      </View>
    );
  }

  return (
    <View>
      <View style={styles.bar} testID="job-logs-filter-bar">
        {(['date', 'tech', 'status'] as const).map((key) => (
          <FilterChip
            key={key}
            testID={`job-logs-chip-${key}`}
            label={jobLogsChipLabel(key, filters, nameOf)}
            active={isActive(key)}
            disabled={offline}
            onPress={() => setOpen(open === key ? null : key)}
          />
        ))}
        {jobLogsFiltersAreDefault(filters) ? null : (
          <Pressable
            testID="job-logs-filter-clear"
            accessibilityLabel="Clear filters"
            accessibilityRole="button"
            disabled={offline}
            hitSlop={hitSlop}
            onPress={() => {
              setOpen(null);
              onClear();
            }}
            style={[styles.clearButton, offline ? styles.chipDisabled : null]}
          >
            <Text style={styles.clearLabel}>✕</Text>
          </Pressable>
        )}
      </View>
      {open === null ? null : (
        <Sheet visible title={SHEET_TITLES[open]} onDismiss={() => setOpen(null)} testID={`job-logs-sheet-${open}`}>
          {options.map((option) => (
            <Pressable
              key={option.label}
              testID={optionTestId(option.label)}
              accessibilityRole="button"
              accessibilityState={{ selected: isOptionSelected(option) }}
              onPress={() => applyOption(option)}
              style={styles.optionRow}
            >
              <Text style={isOptionSelected(option) ? styles.optionLabelSelected : styles.optionLabel}>{option.label}</Text>
            </Pressable>
          ))}
        </Sheet>
      )}
    </View>
  );
}

const SHEET_TITLES: Record<ChipKey, string> = {
  date: 'Which day',
  tech: 'Which technician',
  status: 'Which status',
};

// ── the screen ───────────────────────────────────────────────────────────

const SKELETON_ROW_COUNT = 8;

export function JobLogsScreen(deps: JobLogsDeps): React.ReactNode {
  // Search mode opens with the screen when the URL already carries a
  // query — a shared link answers its own question (§D2: a filtered
  // view survives a reload and can be shared).
  const [searchOpen, setSearchOpen] = useState(() => deps.query.trim() !== '');
  const [pickerOpen, setPickerOpen] = useState(false);
  const [selection, setSelection] = useState<ReadonlySet<string>>(() => new Set<string>());

  openJobRef.current = deps.onOpenJob;
  armSelectionRef.current = (jobId) => {
    // §5.4: the `Selection` haptic fires at the threshold, BEFORE the
    // finger lifts — the hand knows selection armed without watching.
    haptic('longPressArmed');
    setSelection((prev) => {
      const next = new Set(prev);
      next.add(jobId);
      return next;
    });
  };
  toggleSelectionRef.current = (jobId) => {
    setSelection((prev) => {
      const next = new Set(prev);
      if (next.has(jobId)) next.delete(jobId);
      else next.add(jobId);
      return next;
    });
  };

  // A filter or search change re-scopes the view; a selection made
  // against the old scope must not survive it silently.
  const scopeRef = useRef(`${deps.query}\u0000${JSON.stringify(deps.filters)}`);
  useEffect(() => {
    const scope = `${deps.query}\u0000${JSON.stringify(deps.filters)}`;
    if (scope !== scopeRef.current) {
      scopeRef.current = scope;
      setSelection(new Set());
      setPickerOpen(false);
    }
  }, [deps.filters, deps.query]);

  const loading = deps.jobs === null && deps.error === null;
  const showSkeleton = useSkeleton(loading);

  const sortedJobs = useMemo(() => sortJobLogs(deps.jobs ?? []), [deps.jobs]);
  const items: JobLogsListItem[] = useMemo(
    () => sortedJobs.map((job) => ({ ...job, selected: selection.has(job.id) })),
    [sortedJobs, selection],
  );
  const overdueCount = useMemo(() => countOverdueRows(sortedJobs), [sortedJobs]);

  const busiestLoad = deps.technicians.length === 0 ? 0 : Math.max(...deps.technicians.map((t) => t.openTotal));
  const selectionActive = selection.size > 0;

  // The header cross-fade (§5.4, `quick` 140ms): the resting bar to the
  // selection bar. Rows never ride this — the animation lives here alone.
  const selectionProgress = useToggleProgress(selectionActive);
  const restStyle = useAnimatedStyle(() => ({ opacity: 1 - selectionProgress.value }));
  const selectionStyle = useAnimatedStyle(() => ({ opacity: selectionProgress.value }));

  const filteredEmpty = sortedJobs.length === 0 && (!jobLogsFiltersAreDefault(deps.filters) || deps.query.trim() !== '');

  const closeSearch = useCallback(() => {
    setSearchOpen(false);
    if (deps.query !== '') deps.onQueryChange('');
  }, [deps.onQueryChange, deps.query]);

  return (
    <View style={styles.screen} testID="job-logs-screen">
      <View style={styles.headerWrap}>
        <Animated.View style={[styles.headerBar, restStyle]} testID="job-logs-header">
          <Text style={styles.title}>Job Logs</Text>
          <Pressable
            testID="job-logs-search-toggle"
            accessibilityLabel={searchOpen ? 'Close search' : 'Open search'}
            accessibilityRole="button"
            disabled={deps.offline}
            hitSlop={hitSlop}
            onPress={() => (searchOpen ? closeSearch() : setSearchOpen(true))}
            style={[styles.headerAction, deps.offline ? styles.chipDisabled : null]}
          >
            <Text style={styles.searchIcon}>{searchOpen ? '✕' : '⌕'}</Text>
          </Pressable>
        </Animated.View>
        <Animated.View
          style={[styles.headerBar, styles.headerOverlay, selectionStyle]}
          testID="job-logs-selection-header"
          pointerEvents={selectionActive ? 'auto' : 'none'}
        >
          <Text style={styles.selectionCount} testID="job-logs-selection-count">
            {selection.size} selected
          </Text>
          {deps.bulkFlagOn ? (
            <Button
              label="Reassign"
              variant="secondary"
              disabled={deps.offline}
              loading={deps.bulkBusy}
              onPress={() => setPickerOpen(true)}
              testID="job-logs-reassign"
            />
          ) : null}
          <Button label="Cancel" variant="ghost" onPress={() => setSelection(new Set())} testID="job-logs-selection-cancel" />
        </Animated.View>
      </View>

      {deps.offline ? <Banner tone="danger" message={JOB_LOGS_OFFLINE_MESSAGE} testID="job-logs-offline-banner" /> : null}

      {deps.bulkOutcome !== null ? (
        <Banner
          tone={deps.bulkOutcome.failed === 0 ? 'success' : 'danger'}
          message={formatBulkOutcome(deps.bulkOutcome)}
          onDismiss={deps.onDismissBulk}
          testID="job-logs-bulk-outcome"
        />
      ) : null}
      {deps.bulkError !== null ? (
        <Banner tone="danger" message={deps.bulkError} onDismiss={deps.onDismissBulk} testID="job-logs-bulk-error" />
      ) : null}

      {searchOpen ? (
        <View style={styles.searchWrap}>
          <TextField
            label="Search"
            value={deps.query}
            onChangeText={deps.onQueryChange}
            placeholder="Job number, customer or phone"
            testID="job-logs-search-field"
          />
        </View>
      ) : (
        <FilterBar
          filters={deps.filters}
          technicians={deps.technicians}
          offline={deps.offline}
          onChange={deps.onFiltersChange}
          onClear={() => deps.onFiltersChange({ date: 'today', tech: { kind: 'anyone' }, status: 'any' })}
        />
      )}

      <Text style={styles.resultCount} testID="job-logs-result-count">
        {formatResultCount(sortedJobs.length, overdueCount)}
      </Text>

      {deps.error !== null ? (
        <EmptyState message={deps.error} actionLabel="Retry" onAction={deps.onRetry} testID="job-logs-error" />
      ) : showSkeleton ? (
        <View style={styles.skeletonWrap} testID="job-logs-skeleton">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
            <View key={i} style={styles.skeletonRow}>
              <View style={[styles.rail, { backgroundColor: SEMANTIC.bg.dense }]} />
              <View style={styles.skeletonBody}>
                <Skeleton width="46%" height={15} />
                <Skeleton width="70%" height={13} />
              </View>
            </View>
          ))}
        </View>
      ) : sortedJobs.length === 0 ? (
        filteredEmpty ? (
          <EmptyState
            message="No jobs match these filters."
            actionLabel="Clear filters"
            onAction={() => {
              deps.onQueryChange('');
              deps.onFiltersChange({ date: 'today', tech: { kind: 'anyone' }, status: 'any' });
            }}
            testID="job-logs-empty-filtered"
          />
        ) : (
          <EmptyState message="No jobs yet." testID="job-logs-empty-all" />
        )
      ) : (
        <View style={deps.offline ? styles.dimmed : styles.listWrap}>
          <FlashList<JobLogsListItem>
            testID="job-logs-list"
            data={items}
            renderItem={renderItem}
            keyExtractor={keyExtractor}
            onEndReached={deps.onLoadMore}
            contentContainerStyle={{ paddingBottom: SPACE[8] }}
            showsVerticalScrollIndicator={false}
          />
        </View>
      )}

      <Sheet
        visible={pickerOpen}
        title="Reassign to"
        onDismiss={() => setPickerOpen(false)}
        testID="job-logs-reassign-sheet"
      >
        {deps.technicians.length === 0 ? (
          <EmptyState message="No technicians on the roster." testID="job-logs-reassign-empty" />
        ) : (
          deps.technicians.map((technician, index) => (
            <Pressable
              key={technician.employeeId}
              testID={`job-logs-reassign-${technician.employeeId}`}
              accessibilityRole="button"
              disabled={deps.bulkBusy}
              onPress={() => {
                setPickerOpen(false);
                setSelection(new Set()); // the selection is in flight — the mode ends
                deps.onReassign([...selection], technician.employeeId);
              }}
              style={styles.pickerRow}
            >
              <TechnicianLoadRow
                name={technician.name}
                load={technician.openTotal}
                maxLoad={busiestLoad}
                index={index}
                testID={`job-logs-picker-${technician.employeeId}`}
              />
            </Pressable>
          ))
        )}
      </Sheet>
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  headerWrap: { position: 'relative', alignSelf: 'stretch' },
  headerBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[2],
    backgroundColor: SEMANTIC.bg.app,
  },
  headerOverlay: { ...StyleSheet.absoluteFillObject },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary },
  headerAction: {
    minWidth: TAP.console,
    minHeight: TAP.console,
    alignItems: 'center',
    justifyContent: 'center',
  },
  searchIcon: { ...textStyle('h1'), color: SEMANTIC.text.primary },
  selectionCount: { ...textStyle('h2'), color: SEMANTIC.text.primary, flex: 1 },
  // The desk bar: three dropdowns on one line, wrapping on a narrow
  // window, each wide enough to read a technician's full name.
  deskBar: {
    flexDirection: 'row',
    alignItems: 'flex-end',
    flexWrap: 'wrap',
    gap: SPACE[3],
    // The bar outranks the table below it: an open dropdown has to paint
    // over the rows it filters, and the table is the later sibling (OW.5).
    zIndex: 30,
  },
  deskField: {
    minWidth: 200,
    flexGrow: 0,
  },
  bar: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    backgroundColor: SEMANTIC.bg.app,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  chip: {
    minHeight: TAP.console, // 44 — the console floor, always + hit slop 8
    paddingHorizontal: SPACE[3],
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    justifyContent: 'center',
  },
  chipActive: { backgroundColor: SEMANTIC.bg.dense, borderColor: SEMANTIC.text.primary },
  chipPressed: { backgroundColor: SEMANTIC.bg.pressed },
  chipDisabled: { opacity: 0.6 },
  chipLabel: { ...textStyle('label'), color: SEMANTIC.text.primary },
  chipLabelActive: { ...textStyle('label'), color: SEMANTIC.text.primary, fontWeight: '600' },
  clearButton: {
    minWidth: TAP.console,
    minHeight: TAP.console,
    alignItems: 'center',
    justifyContent: 'center',
  },
  clearLabel: { ...textStyle('h2'), color: SEMANTIC.text.secondary },
  optionRow: {
    minHeight: TAP.min, // a sheet of LARGE rows, not a native picker
    justifyContent: 'center',
    paddingHorizontal: SPACE[2],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
  },
  optionLabel: { ...textStyle('body'), color: SEMANTIC.text.primary },
  optionLabelSelected: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  searchWrap: { paddingHorizontal: SPACE[4], paddingBottom: SPACE[2] },
  resultCount: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    paddingHorizontal: SPACE[4],
    paddingVertical: SPACE[2],
    fontVariant: ['tabular-nums'],
  },
  listWrap: { flex: 1 },
  dimmed: { flex: 1, opacity: 0.4 },
  skeletonWrap: { flex: 1 },
  skeletonRow: {
    flexDirection: 'row',
    height: ROW_HEIGHT,
    backgroundColor: SEMANTIC.bg.raised,
    alignItems: 'center',
  },
  skeletonBody: { flex: 1, paddingHorizontal: SPACE[3], gap: SPACE[1] },
  row: {
    flexDirection: 'row',
    height: ROW_HEIGHT, // the row itself is the tap target, at 56pt
    backgroundColor: SEMANTIC.bg.raised,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  rowPressed: { backgroundColor: SEMANTIC.bg.pressed }, // 90ms press state
  rowSelected: { borderWidth: 1, borderColor: SEMANTIC.line.focus },
  rail: { width: RAIL_WIDTH },
  body: { flex: 1, paddingHorizontal: SPACE[3], justifyContent: 'center', gap: 2 },
  line1: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  jobNumber: { ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] },
  rowTitle: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary, flexShrink: 1 },
  line2: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  who: { ...textStyle('body'), color: SEMANTIC.text.secondary, flexShrink: 1 },
  overdueChip: {
    borderWidth: 1,
    borderColor: SEMANTIC.feedback.danger,
    color: SEMANTIC.feedback.danger,
    ...textStyle('caption'),
    paddingHorizontal: SPACE[1],
  },
  spacer: { flex: 1 },
  status: { flexDirection: 'row', alignItems: 'center', gap: SPACE[1] },
  dot: { width: 6, height: 6, borderRadius: 3 },
  statusLabel: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  pickerRow: { alignSelf: 'stretch', paddingVertical: SPACE[1] },
});
