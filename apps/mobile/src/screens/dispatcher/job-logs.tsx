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
 * Anatomy, exactly: the navy frame header ("Job Logs", search); the
 * FilterBar sticky under it — sticky by LAYOUT, a sibling above the
 * FlashList, so it cannot collapse on scroll; a section marker carrying
 * the result count always above the list ("24 jobs · 3 overdue" — the
 * dispatcher knows whether the filter worked before scrolling); two-line
 * cards at 56pt with 8pt of air between them (2026-09-17) — the console's
 * density is still the point, and the gap costs a row or so per screen
 * against the ruled list this used to be.
 *
 * Density (01-FOUNDATIONS.md §3): the ROW is the tap target at 56pt,
 * above the global 52; the 44pt `console` floor applies to the filter
 * chips and header actions. The left rail carries status colour and is
 * never alone — the status word rides beside it in a `StatusPill` (§1.6),
 * always. The rail and the pill both come from `railColorOf` /
 * `statusPillOf`, the same pair the technician's JobCard uses, so the two
 * rows cannot disagree about what `assigned` looks like.
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
 * the search glyph swaps the bar for a full-width search over job number,
 * customer and phone (the server's `q`), with results in the same row
 * component.
 */
import { memo, useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { FlashList } from '@shopify/flash-list';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated, { useAnimatedStyle, useSharedValue, withSpring } from 'react-native-reanimated';

import {
  alpha,
  COLORS,
  DENSITY,
  FRAME,
  ICON,
  JOB_STATUSES,
  RADII,
  SEMANTIC,
  SPACE,
  SPRING,
  TAP,
  TINT,
} from '@servgrid/shared';
import { StatusPill } from '../../components/domain/StatusPill';
import { TechnicianLoadRow } from '../../components/domain/TechnicianLoadRow';
import { Banner, Button, EmptyState, SectionHeader, Select, Sheet, Skeleton, TextField, useDensity } from '../../components/ui';
import { Icon, type IconName } from '../../components/ui/icons';
import { haptic } from '../../components/ui/haptics';
import { useSkeleton } from '../../components/ui/Skeleton';
import { useToggleProgress } from '../../components/ui/motion';
import { textStyle } from '../../fonts/textStyle';
import { istTimeLabel, railColorOf, statusPillOf } from '../technician/jobView';
import {
  STATUS_LABELS,
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
import { sortTechniciansByLoad } from './dispatchForm';

export const JOB_LOGS_OFFLINE_MESSAGE = 'No connection. This screen is not live.';

const ROW_HEIGHT = DENSITY.console.rowHeight; // 56 — the D2 row, the measurement FlashList v2 converges on
const RAIL_WIDTH = 4;
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
  /** The leading glyph, for the options a glyph names (a day, a person). */
  icon?: IconName;
  /** …or the status dot, for the options that ARE a status colour. */
  dot?: string;
}

/** The date chip's sheet, in display order. */
export const JOB_LOGS_DATE_OPTIONS: readonly JobLogsOption<JobLogsDateFilter>[] = [
  { value: 'today', label: 'Today', icon: 'calendar' },
  { value: 'tomorrow', label: 'Tomorrow', icon: 'calendar' },
  { value: 'week', label: 'This week', icon: 'calendar' },
  { value: 'all', label: 'All days', icon: 'calendar' },
];

/** The status chip's sheet — overdue is an option, never a status. The
 * words come from the filters module's `STATUS_LABELS`, the same map the
 * chip's resting label reads: this file used to keep its own copy. Each
 * option carries the status's own colour as a dot, so the sheet teaches
 * the colours the rows use. */
export const JOB_LOGS_STATUS_OPTIONS: readonly JobLogsOption<JobLogsStatusFilter>[] = [
  { value: 'any', label: STATUS_LABELS.any, dot: SEMANTIC.text.secondary },
  { value: 'overdue', label: STATUS_LABELS.overdue, dot: SEMANTIC.feedback.danger },
  ...JOB_STATUSES.map((s) => ({ value: s, label: STATUS_LABELS[s], dot: statusPillOf(s).color })),
];

function optionTestId(label: string): string {
  return `filter-option-${label.toLowerCase().replace(/\s+/g, '-')}`;
}

const hitSlop = { top: TAP.hitSlop, bottom: TAP.hitSlop, left: TAP.hitSlop, right: TAP.hitSlop };
/** A row is 56pt — over the 52 floor — so it carries no hit slop. Slop on
 * a dense list overlaps the row above and below by 8pt each, which makes
 * the top half of a row open its neighbour. */
const NO_SLOP = { top: 0, bottom: 0, left: 0, right: 0 };

// ── the row ──────────────────────────────────────────────────────────────

/**
 * ▌JC-…0042  Kormangala 3rd Blk        (● In progress)
 * ▌Ravi · 14:30  [Overdue]
 *
 * Line 1 is the job, line 2 is who and when; the status rides the row's
 * trailing edge as a `StatusPill` (tint + dot + word), vertically centred
 * because it is the same fact for both lines — and the same pill the
 * technician's card wears, from the same `statusPillOf` map.
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
  const density = useDensity();
  // Body type follows the density ramp (console 15 here, field 16 on the
  // owner's phone list, which mounts this same row).
  const titleStyle = useMemo(() => [styles.rowTitle, textStyle('bodyStrong', density)], [density]);
  const whoStyle = useMemo(() => [styles.who, textStyle('body', density)], [density]);

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
      hitSlop={NO_SLOP}
      style={[
        styles.row,
        pressed ? styles.rowPressed : null,
        selected ? styles.rowSelected : null,
      ]}
    >
      <View style={[styles.rail, { backgroundColor: railColorOf(job.status) }]} />
      <View style={styles.body}>
        <View style={styles.textCol}>
          <View style={styles.line1}>
            <Text style={styles.jobNumber}>{shortJobNumber(job.jobNumber)}</Text>
            <Text numberOfLines={1} style={titleStyle}>
              {job.title}
            </Text>
          </View>
          <View style={styles.line2}>
            <Text numberOfLines={1} style={whoStyle}>
              {job.technicianName === null ? 'Unassigned' : `${firstName(job.technicianName)} · ${slotLabel(job.scheduledFor)}`}
            </Text>
            {job.overdue ? (
              <View style={styles.overdueChip}>
                <Text style={styles.overdueWord}>Overdue</Text>
              </View>
            ) : null}
          </View>
        </View>
        {/* Named outside the `job-logs-row-` namespace on purpose: that
            prefix is what the tests read as "the ids of the rows", so a
            `-status` suffix on it would read as one more row. */}
        <StatusPill status={job.status} testID={`job-logs-status-${job.id}`} />
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

/**
 * `14:30` — the IST wall clock, whatever the api sent. It used to slice
 * `iso.slice(11,16)`, which prints the right slot only while every
 * instant arrives with a `+05:30` offset; the sort above parses the same
 * string absolutely, so the two could disagree. Same helper the
 * technician's card and the job detail use.
 */
function slotLabel(scheduledFor: string | null): string {
  return scheduledFor === null ? 'No time' : istTimeLabel(scheduledFor);
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
 * One console chip — 44pt at `console`, 52 at `field` (the owner's phone
 * list mounts this bar too, where the floor is the global one). The fill
 * change is the screen's one allowed chip motion (140ms, `quick`), and an
 * applied filter fills navy — the app's own "this one is on" fill, the
 * same one `Chip` uses.
 */
function FilterChip({
  label,
  icon,
  active,
  disabled,
  floor,
  onPress,
  testID,
}: {
  label: string;
  /** The chip's own object: a day, a person, a state. */
  icon: IconName;
  active: boolean;
  disabled: boolean;
  /** The density's touch floor — 44 on the console, 52 in the field. */
  floor: number;
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
      hitSlop={floor < TAP.min ? hitSlop : NO_SLOP}
      onPress={() => {
        // Belt and braces: the Pressable is disabled offline too — a
        // filter applied to stale data is the confident wrong answer.
        if (disabled) return;
        haptic('pickerSelect');
        onPress();
      }}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        styles.chip,
        { minHeight: floor },
        active ? styles.chipActive : null,
        disabled ? styles.chipDisabled : null,
        pressed ? (active ? null : styles.chipPressed) : null,
      ]}
    >
      <Icon name={icon} size={ICON.sm} color={active ? FRAME.text : SEMANTIC.text.secondary} />
      <Text style={active ? styles.chipLabelActive : styles.chipLabel}>{label}</Text>
      <Icon name="chevronDown" size={ICON.sm} color={active ? FRAME.text : SEMANTIC.text.secondary} />
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
  const density = useDensity();
  const desk = density === 'desk';
  /** The row/chip floor: console 44, field 52 (the owner's phone list
   * mounts this bar at field density). */
  const floor = density === 'field' ? TAP.min : TAP.console;

  const nameOf = useCallback(
    (technicianId: string): string | null => technicians.find((t) => t.employeeId === technicianId)?.name ?? null,
    [technicians],
  );

  const techOptions: readonly JobLogsOption<string>[] = useMemo(
    () => [
      { value: 'anyone', label: 'Anyone', icon: 'people' },
      // "Nobody holds it" is the server's `unassigned` STATUS, so this
      // option writes the status filter rather than inventing a
      // technicianId the api would answer with an empty page (Yashas,
      // 2026-09-17: "add unassigned to the filter"). Both chips then read
      // Unassigned, because it is one fact.
      { value: 'unassigned', label: 'Unassigned', icon: 'people' },
      ...technicians.map((t) => ({ value: t.employeeId, label: t.name, icon: 'people' as const })),
    ],
    [technicians],
  );

  const options: readonly JobLogsOption<unknown>[] =
    open === 'date' ? JOB_LOGS_DATE_OPTIONS : open === 'status' ? JOB_LOGS_STATUS_OPTIONS : open === 'tech' ? techOptions : [];

  const applyOption = (option: JobLogsOption<unknown>): void => {
    if (open === 'date') onChange({ ...filters, date: option.value as JobLogsDateFilter });
    else if (open === 'status') onChange({ ...filters, status: option.value as JobLogsStatusFilter });
    else if (open === 'tech') {
      if (option.value === 'unassigned') {
        onChange({ ...filters, tech: { kind: 'anyone' }, status: 'unassigned' });
      } else {
        onChange({
          ...filters,
          // A job someone holds is not unassigned: picking a person drops
          // the status view that said it was.
          status: filters.status === 'unassigned' ? 'any' : filters.status,
          tech:
            option.value === 'anyone'
              ? { kind: 'anyone' }
              : { kind: 'tech', technicianId: option.value as string, name: option.label },
        });
      }
    }
    setOpen(null);
  };

  const isActive = (key: ChipKey): boolean => {
    if (key === 'date') return filters.date !== 'today';
    if (key === 'status') return filters.status !== 'any';
    return filters.tech.kind !== 'anyone' || filters.status === 'unassigned';
  };

  const isOptionSelected = (option: JobLogsOption<unknown>): boolean => {
    if (open === 'date') return filters.date === option.value;
    if (open === 'status') return filters.status === option.value;
    if (open === 'tech') {
      if (option.value === 'unassigned') return filters.status === 'unassigned';
      if (option.value === 'anyone') return filters.tech.kind === 'anyone' && filters.status !== 'unassigned';
      return filters.tech.kind === 'tech' && filters.tech.technicianId === option.value;
    }
    return false;
  };

  // The DESK filter bar (OW.1/OW.3, 2026-09-16): real dropdowns, because
  // a console filter is a pointer control — a chip that opens a bottom
  // sheet is a phone idiom, and on the owner's desk it read as unfinished
  // and behaved like nothing at all. The phone keeps its chips below.
  if (desk) {
    const techValue =
      filters.status === 'unassigned'
        ? 'unassigned'
        : filters.tech.kind === 'anyone'
          ? 'anyone'
          : filters.tech.technicianId;
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
            onSelect={(value) => {
              // The same alias the chips use, and the same rule that keeps
              // the two filters from contradicting each other.
              if (value === 'unassigned') {
                onChange({ ...filters, tech: { kind: 'anyone' }, status: 'unassigned' });
                return;
              }
              onChange({
                ...filters,
                status: filters.status === 'unassigned' ? 'any' : filters.status,
                tech:
                  value === 'anyone'
                    ? { kind: 'anyone' }
                    : { kind: 'tech', technicianId: value, name: nameOf(value) ?? '' },
              });
            }}
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
            icon={CHIP_ICONS[key]}
            active={isActive(key)}
            disabled={offline}
            floor={floor}
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
            <Icon name="close" size={ICON.md} color={SEMANTIC.text.secondary} />
          </Pressable>
        )}
      </View>
      {open === null ? null : (
        <Sheet visible title={SHEET_TITLES[open]} onDismiss={() => setOpen(null)} testID={`job-logs-sheet-${open}`}>
          {/* Rows, not a native picker: the chosen one fills navy with a
              light tick — the same "this one is on" the chips wear, and
              the same mark the technician's cancel sheet uses. */}
          <View style={styles.options}>
            {options.map((option) => {
              const selected = isOptionSelected(option);
              return (
                <Pressable
                  key={option.label}
                  testID={optionTestId(option.label)}
                  accessibilityRole="button"
                  accessibilityState={{ selected }}
                  onPress={() => applyOption(option)}
                  style={[styles.optionRow, { minHeight: floor }, selected ? styles.optionRowSelected : null]}
                >
                  {/* The leading mark is the option's own object: a glyph
                      for a day or a person, the status colour as a dot for
                      a state. */}
                  <View style={styles.optionLead}>
                    {option.dot === undefined ? (
                      <Icon
                        name={option.icon ?? 'list'}
                        size={ICON.sm}
                        color={selected ? FRAME.text : SEMANTIC.text.secondary}
                      />
                    ) : (
                      <View style={[styles.optionDot, { backgroundColor: option.dot }]} />
                    )}
                  </View>
                  <Text style={[selected ? styles.optionLabelSelected : styles.optionLabel, styles.optionText]}>
                    {option.label}
                  </Text>
                  {selected ? <Icon name="check" size={ICON.sm} color={FRAME.text} /> : null}
                </Pressable>
              );
            })}
          </View>
        </Sheet>
      )}
    </View>
  );
}

/** Each chip wears its own object: a day, a person, a state. */
const CHIP_ICONS: Record<ChipKey, IconName> = {
  date: 'calendar',
  tech: 'people',
  status: 'list',
};

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
      {/* The navy frame (2026-09-17): the title and the search control sit
          on slate.900, and the selection bar cross-fades over them on the
          same ground — a light overlay would flash white at the top of
          the screen every time a row is picked up. */}
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
            <Icon name={searchOpen ? 'close' : 'search'} size={ICON.lg} color={FRAME.text} />
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
          {/* Not a `ghost` Button: its ink is `text.secondary`, which is
              slate.500 — invisible on the frame. The escape is a plain
              light word beside the one action, the dashboard's own
              arrangement. */}
          <Pressable
            accessibilityRole="button"
            accessibilityLabel="Cancel selection"
            hitSlop={hitSlop}
            onPress={() => setSelection(new Set())}
            style={styles.cancelSelection}
            testID="job-logs-selection-cancel"
          >
            <Text style={styles.cancelSelectionWord}>Cancel</Text>
          </Pressable>
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

      <View style={styles.resultsMarker}>
        <SectionHeader
          label="Jobs"
          icon="list"
          action={
            <Text style={styles.resultCount} testID="job-logs-result-count">
              {formatResultCount(sortedJobs.length, overdueCount)}
            </Text>
          }
        />
      </View>

      {deps.error !== null ? (
        <EmptyState message={deps.error} actionLabel="Retry" onAction={deps.onRetry} testID="job-logs-error" />
      ) : showSkeleton ? (
        <View style={styles.skeletonWrap} testID="job-logs-skeleton">
          {Array.from({ length: SKELETON_ROW_COUNT }, (_, i) => (
            <View key={i} style={styles.skeletonRow}>
              <View style={[styles.rail, { backgroundColor: SEMANTIC.bg.dense }]} />
              <View style={styles.body}>
                <View style={styles.textCol}>
                  <Skeleton width="46%" height={14} />
                  <Skeleton width="70%" height={12} />
                </View>
                {/* The status pill's own footprint, so the rows do not
                    shift sideways when the data lands. */}
                <Skeleton width={76} height={20} radius={RADII.control} />
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

      {/* Mounted only while open (2026-09-17), the job detail's idiom: a
          sheet built on every render of a screen that is just idling is
          a subtree nothing asked for, and it is one prop away from
          seeding from data that is not there yet. */}
      {pickerOpen ? (
        <Sheet visible title="Reassign to" onDismiss={() => setPickerOpen(false)} testID="job-logs-reassign-sheet">
          <SectionHeader label="Lightest load first" icon="people" tint={COLORS.accent} />
          {deps.technicians.length === 0 ? (
            <EmptyState message="No technicians on the roster." testID="job-logs-reassign-empty" />
          ) : (
            // Load ascending, stable — the same order (and the same
            // helper) the job detail's picker uses, because the
            // comparison IS the decision.
            sortTechniciansByLoad(deps.technicians).map((technician, index) => (
              <Pressable
                key={technician.employeeId}
                testID={`job-logs-reassign-${technician.employeeId}`}
                accessibilityRole="button"
                accessibilityState={{ disabled: deps.bulkBusy }}
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
      ) : null}
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
    gap: SPACE[2],
    paddingHorizontal: SPACE[3],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[3],
    backgroundColor: FRAME.bg,
  },
  // The overlay covers the resting bar exactly, on the SAME navy — the
  // cross-fade has to hide it, not paint a second ground over it.
  headerOverlay: { ...StyleSheet.absoluteFillObject, backgroundColor: FRAME.bg },
  title: { ...textStyle('h1'), color: FRAME.text },
  headerAction: {
    minWidth: TAP.console,
    minHeight: TAP.console,
    alignItems: 'center',
    justifyContent: 'center',
  },
  selectionCount: { ...textStyle('h2'), color: FRAME.text, flex: 1 },
  // The selection mode's escape: a light word, no fill — the one action
  // (Reassign) is the white Button beside it.
  cancelSelection: { minHeight: TAP.console, justifyContent: 'center', paddingHorizontal: SPACE[2] },
  cancelSelectionWord: { ...textStyle('label'), color: FRAME.textMuted },
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
    paddingTop: SPACE[3],
    paddingBottom: SPACE[2],
    backgroundColor: SEMANTIC.bg.app,
  },
  chip: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[1],
    paddingHorizontal: SPACE[3],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    justifyContent: 'center',
  },
  // An applied filter fills navy — the app's one "this is on" fill.
  chipActive: { backgroundColor: SEMANTIC.bg.dark, borderColor: SEMANTIC.bg.dark },
  chipPressed: { backgroundColor: SEMANTIC.bg.pressed },
  chipDisabled: { opacity: 0.6 },
  chipLabel: { ...textStyle('label'), color: SEMANTIC.text.primary },
  chipLabelActive: { ...textStyle('label'), color: SEMANTIC.text.onDark, fontWeight: '600' },
  clearButton: {
    minWidth: TAP.console,
    minHeight: TAP.console,
    alignItems: 'center',
    justifyContent: 'center',
  },
  optionRow: {
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[3],
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    borderRadius: RADII.control,
    backgroundColor: SEMANTIC.bg.raised,
  },
  optionRowSelected: { backgroundColor: SEMANTIC.bg.dark },
  /** A fixed leading slot, so every label starts on the same x. */
  optionLead: { width: ICON.lg, alignItems: 'center', justifyContent: 'center' },
  optionDot: { width: 8, height: 8, borderRadius: 4 },
  optionText: { flex: 1 },
  optionLabel: { ...textStyle('body'), color: SEMANTIC.text.primary },
  optionLabelSelected: { ...textStyle('bodyStrong'), color: SEMANTIC.text.onDark },
  /** The sheet's options as a spaced stack, not a hairline-separated list. */
  options: { alignSelf: 'stretch', gap: SPACE[1], paddingHorizontal: SPACE[2] },
  searchWrap: { paddingHorizontal: SPACE[3], paddingBottom: SPACE[2] },
  /** The list's own marker — the count rides the rule's trailing edge. */
  resultsMarker: { paddingHorizontal: SPACE[3], paddingVertical: SPACE[2] },
  resultCount: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums'],
  },
  listWrap: { flex: 1 },
  dimmed: { flex: 1, opacity: 0.4 },
  skeletonWrap: { flex: 1 },
  skeletonRow: {
    flexDirection: 'row',
    height: ROW_HEIGHT,
    marginBottom: SPACE[2],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    alignItems: 'center',
    overflow: 'hidden',
  },
  // A card per row, not a ruled line (Yashas, 2026-09-17: "add proper
  // spacing between the job cards"): the same 56pt tap target, plus air
  // between rows, a hairline all round and a corner the rail turns with
  // (`overflow: hidden` is what clips the rail to the radius).
  row: {
    flexDirection: 'row',
    height: ROW_HEIGHT, // the row itself is the tap target, at 56pt
    marginBottom: SPACE[2],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    overflow: 'hidden',
  },
  rowPressed: { backgroundColor: SEMANTIC.bg.pressed }, // 90ms press state
  rowSelected: { borderColor: SEMANTIC.line.focus, backgroundColor: SEMANTIC.bg.pressed },
  /** The real status rail, four points — the same weight as the card's. */
  rail: { width: RAIL_WIDTH },
  body: {
    flex: 1,
    flexDirection: 'row',
    alignItems: 'center',
    gap: SPACE[2],
    paddingHorizontal: SPACE[3],
  },
  textCol: { flex: 1, justifyContent: 'center', gap: 2 },
  line1: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  jobNumber: { ...textStyle('mono'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] },
  rowTitle: { color: SEMANTIC.text.primary, flexShrink: 1 },
  line2: { flexDirection: 'row', alignItems: 'center', gap: SPACE[2] },
  who: { color: SEMANTIC.text.secondary, flexShrink: 1 },
  // The overdue flag as a tinted chip: the danger ink and its word, on a
  // ground derived from it — never an outlined word floating in the line.
  overdueChip: {
    minHeight: 18,
    justifyContent: 'center',
    paddingHorizontal: SPACE[1],
    borderRadius: RADII.control,
    borderWidth: 1,
    borderColor: alpha(SEMANTIC.feedback.danger, TINT.chipLine),
    backgroundColor: alpha(SEMANTIC.feedback.danger, TINT.chip),
  },
  overdueWord: { ...textStyle('caption'), color: SEMANTIC.feedback.danger },
  pickerRow: { alignSelf: 'stretch', paddingVertical: SPACE[1] },
});
