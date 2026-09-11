/**
 * T1.22 spike FilterBar — the persistent three-chip bar (§D2).
 *
 * **Sticky means layout, not scroll**: the bar renders as a sibling
 * *above* the FlashList in a column, so it cannot scroll away — D2's
 * "sticky under the header, never collapsing on scroll". No
 * `stickyHeaderIndices`, which FlashList does not own.
 *
 * Chips are `console`-density controls: 44pt targets with hitSlop 8 —
 * the 44pt floor D2 allows here and nowhere else, because a dispatcher
 * is seated and bare-handed (01-FOUNDATIONS.md §3). Each chip opens an
 * inline sheet of **large rows, not a native picker** — the spike
 * approximates the sheet with a full-width option list under the bar;
 * Phase 2 promotes it to a bottom sheet.
 *
 * Only one chip sheet is open at a time; changing a value closes the
 * sheet. The ✕ clears everything back to [Today][Anyone][Any status]
 * and is visible exactly when the filters are not default.
 */
import { Fragment, useState } from 'react';
import { Pressable, Text, View } from 'react-native';

import { SEMANTIC, TAP } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { TECHNICIANS } from './mockJobs';
import {
  filtersAreDefault,
  type DateFilter,
  type JobLogsFilters,
  type StatusFilter,
  type TechFilter,
} from './jobLogsFilter';

export type ChipKey = 'date' | 'tech' | 'status';

const DATE_OPTIONS: readonly { value: DateFilter; label: string }[] = [
  { value: 'today', label: 'Today' },
  { value: 'tomorrow', label: 'Tomorrow' },
  { value: 'week', label: 'This week' },
  { value: 'all', label: 'All days' },
];

const STATUS_OPTIONS: readonly { value: StatusFilter; label: string }[] = [
  { value: 'any', label: 'Any status' },
  { value: 'overdue', label: 'Overdue' },
  { value: 'unassigned', label: 'Unassigned' },
  { value: 'assigned', label: 'Assigned' },
  { value: 'en_route', label: 'En route' },
  { value: 'in_progress', label: 'In progress' },
  { value: 'completed', label: 'Completed' },
  { value: 'cancelled', label: 'Cancelled' },
];

function techOptions(): readonly { value: TechFilter; label: string }[] {
  return [
    { value: { kind: 'anyone' }, label: 'Anyone' },
    { value: { kind: 'unassigned' }, label: 'Unassigned' },
    ...TECHNICIANS.map((name) => ({ value: { kind: 'tech', name } as TechFilter, label: name })),
  ];
}

function chipLabel(key: ChipKey, f: JobLogsFilters): string {
  if (key === 'date') return DATE_OPTIONS.find((o) => o.value === f.date)?.label ?? 'Date';
  if (key === 'tech') {
    if (f.tech.kind === 'unassigned') return 'Unassigned';
    if (f.tech.kind === 'tech') return f.tech.name;
    return 'Anyone';
  }
  if (f.status === 'any') return 'Any status';
  if (f.status === 'overdue') return 'Overdue';
  return STATUS_OPTIONS.find((o) => o.value === f.status)?.label ?? 'Status';
}

const hitSlop = { top: TAP.hitSlop, bottom: TAP.hitSlop, left: TAP.hitSlop, right: TAP.hitSlop };

const styles = {
  bar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: 8,
    paddingHorizontal: 12,
    paddingVertical: 6,
    backgroundColor: SEMANTIC.bg.app,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  chip: {
    minHeight: TAP.console, // 44 — the console floor, with hitSlop 8
    paddingHorizontal: 12,
    borderRadius: 4,
    borderWidth: 1,
    borderColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
    justifyContent: 'center' as const,
  },
  chipActive: { backgroundColor: SEMANTIC.bg.dense, borderColor: SEMANTIC.text.primary },
  chipLabel: { ...textStyle('label'), color: SEMANTIC.text.primary },
  clear: {
    minWidth: TAP.console,
    minHeight: TAP.console,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  clearLabel: { ...textStyle('h2'), color: SEMANTIC.text.secondary },
  sheet: {
    backgroundColor: SEMANTIC.bg.raised,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  option: {
    minHeight: TAP.console,
    justifyContent: 'center' as const,
    paddingHorizontal: 16,
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
  },
  optionLabel: { ...textStyle('body'), color: SEMANTIC.text.primary },
};

export function FilterBar({
  filters,
  onChange,
  onClear,
}: {
  filters: JobLogsFilters;
  onChange: (next: JobLogsFilters) => void;
  onClear: () => void;
}): React.ReactNode {
  const [open, setOpen] = useState<ChipKey | null>(null);

  const apply = (patch: Partial<JobLogsFilters>): void => {
    onChange({ ...filters, ...patch });
    setOpen(null);
  };

  const options =
    open === 'date' ? DATE_OPTIONS : open === 'tech' ? techOptions() : open === 'status' ? STATUS_OPTIONS : [];

  const applyOption = (value: DateFilter | StatusFilter | TechFilter): void => {
    if (open === 'date') apply({ date: value as DateFilter });
    else if (open === 'tech') apply({ tech: value as TechFilter });
    else if (open === 'status') apply({ status: value as StatusFilter });
  };

  return (
    <Fragment>
      <View style={styles.bar} testID="job-logs-filter-bar">
        {(['date', 'tech', 'status'] as const).map((key) => {
          const active = key === 'date' ? filters.date !== 'all' : key === 'status' ? filters.status !== 'any' : filters.tech.kind !== 'anyone';
          return (
            <Pressable
              key={key}
              testID={`filter-chip-${key}`}
              style={[styles.chip, active ? styles.chipActive : null]}
              hitSlop={hitSlop}
              onPress={() => setOpen(open === key ? null : key)}
              accessibilityRole="button"
              accessibilityState={{ selected: active }}
            >
              <Text style={styles.chipLabel}>{chipLabel(key, filters)} ▾</Text>
            </Pressable>
          );
        })}
        {filtersAreDefault(filters) ? null : (
          <Pressable
            testID="filter-clear"
            style={styles.clear}
            hitSlop={hitSlop}
            onPress={() => {
              setOpen(null);
              onClear();
            }}
            accessibilityRole="button"
            accessibilityLabel="Clear filters"
          >
            <Text style={styles.clearLabel}>✕</Text>
          </Pressable>
        )}
      </View>
      {open === null ? null : (
        <View style={styles.sheet} testID={`filter-sheet-${open}`}>
          {options.map((option) => (
            <Pressable
              key={option.label}
              testID={`filter-option-${option.label.toLowerCase().replace(/\s+/g, '-')}`}
              style={styles.option}
              onPress={() => applyOption(option.value)}
              accessibilityRole="button"
            >
              <Text style={styles.optionLabel}>{option.label}</Text>
            </Pressable>
          ))}
        </View>
      )}
    </Fragment>
  );
}
