/**
 * T1.22 spike screen — Job Logs at dispatcher volume (§D2, verbatim
 * anatomy). THROWAWAY: this screen exists to be timed, judged and
 * thrown away; it shares nothing with the technician jobs screens and
 * previews nothing of Phase 2's real implementation.
 *
 * ```
 * ┌────────────────────────────────────────┐
 * │ Job Logs                        ⌕      │
 * ├────────────────────────────────────────┤
 * │ [Today ▾][Anyone ▾][Any status ▾] ✕    │  ← FilterBar, sticky (layout)
 * ├────────────────────────────────────────┤
 * │ 24 jobs · 3 overdue                    │  ← result count, always
 * ├────────────────────────────────────────┤
 * │ ▌JC-…0042  Kormangala 3rd Blk          │
 * │ ▌Ravi · 14:30            ● In progress │  ← 56pt row, two lines
 * └────────────────────────────────────────┘
 * ```
 *
 * States (§D2): empty-filtered keeps the FilterBar visible and offers
 * *Clear filters* — the dispatcher needs to see what they set; the
 * unfiltered empty is "No jobs yet." Search is a separate mode, not a
 * field competing with the bar. Filter changes re-sort with no
 * animation: the list simply is the new rows.
 *
 * Perf shape (02-MOTION.md §9): FlashList with `renderItem` hoisted to
 * a stable identity and memoised rows; overdue-ness computed once per
 * filter change (a Set the row reads through props) — no per-row date
 * work on scroll. D2's "`estimatedItemSize` from a measured row" is
 * FlashList v2's own behaviour: the version measures real rows, and the
 * 56pt row height (`ROW_HEIGHT`) is the measurement it converges on —
 * same resolution T1.17 made for the technician lists.
 */
import { memo, useCallback, useMemo, useState } from 'react';
import { FlashList } from '@shopify/flash-list';
import { Pressable, Text, View } from 'react-native';

import { SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { textStyle } from '../../fonts/textStyle';
import { EmptyState, TextField } from '../../components/ui';
import { JobLogsRow } from './JobLogsRow';
import { FilterBar } from './FilterBar';
import {
  applyFilters,
  countOverdue,
  DEFAULT_FILTERS,
  filtersAreDefault,
  formatResultCount,
  isOverdue,
  matchesSearch,
  type JobLogsFilters,
} from './jobLogsFilter';
import type { SpikeJob } from './mockJobs';

const hitSlop = { top: TAP.hitSlop, bottom: TAP.hitSlop, left: TAP.hitSlop, right: TAP.hitSlop };

export interface JobLogsDeps {
  /** The full dispatcher job set (spike: the generated 220). */
  jobs: SpikeJob[];
  /** Injectable clock — IST "today" is computed from it. */
  now: Date;
  onOpenJob: (job: SpikeJob) => void;
}

/**
 * Callbacks and the overdue set ride module-level refs so the hoisted
 * `renderItem` and the memoised row never hold a per-render closure —
 * same seam as the technician Jobs screen; one screen instance, one ref.
 */
const openJobRef: { current: ((job: SpikeJob) => void) | null } = { current: null };
const overdueRef: { current: ReadonlySet<string> } = { current: new Set() };

const RowItem = memo(function RowItem({
  job,
  overdue,
  testID,
}: {
  job: SpikeJob;
  overdue: boolean;
  testID?: string;
}): React.ReactNode {
  return (
    <JobLogsRow job={job} overdue={overdue} onPress={(j) => openJobRef.current?.(j)} testID={testID} />
  );
});

function Header({ searchOpen, onToggleSearch }: { searchOpen: boolean; onToggleSearch: () => void }): React.ReactNode {
  return (
    <View style={headerStyles.bar} testID="job-logs-header">
      <Text style={headerStyles.title}>Job Logs</Text>
      <Pressable
        testID="job-logs-search-toggle"
        style={headerStyles.searchButton}
        hitSlop={hitSlop}
        onPress={onToggleSearch}
        accessibilityRole="button"
        accessibilityLabel={searchOpen ? 'Close search' : 'Open search'}
      >
        <Text style={headerStyles.searchIcon}>{searchOpen ? '✕' : '⌕'}</Text>
      </Pressable>
    </View>
  );
}

const headerStyles = {
  bar: {
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    justifyContent: 'space-between' as const,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[2],
    backgroundColor: SEMANTIC.bg.app,
  },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary },
  searchButton: {
    minWidth: TAP.console,
    minHeight: TAP.console,
    alignItems: 'center' as const,
    justifyContent: 'center' as const,
  },
  searchIcon: { ...textStyle('h1'), color: SEMANTIC.text.primary },
};

export function JobLogsScreen(deps: JobLogsDeps): React.ReactNode {
  const [filters, setFilters] = useState<JobLogsFilters>(DEFAULT_FILTERS);
  const [searchOpen, setSearchOpen] = useState(false);
  const [query, setQuery] = useState('');

  openJobRef.current = deps.onOpenJob;

  const chipFiltered = useMemo(() => applyFilters(deps.jobs, filters, deps.now), [deps.jobs, filters, deps.now]);
  const shown = useMemo(
    () => (searchOpen ? chipFiltered.filter((j) => matchesSearch(j, query)) : chipFiltered),
    [chipFiltered, searchOpen, query],
  );
  const overdueCount = useMemo(() => countOverdue(shown, deps.now), [shown, deps.now]);
  const overdueIds = useMemo(
    () => new Set(shown.filter((j) => isOverdue(j, deps.now)).map((j) => j.id)),
    [shown, deps.now],
  );
  overdueRef.current = overdueIds;

  const renderItem = useCallback(
    ({ item }: { item: SpikeJob }) => (
      <RowItem job={item} overdue={overdueRef.current.has(item.id)} testID={`job-logs-row-${item.id}`} />
    ),
    [],
  );
  const keyExtractor = useCallback((job: SpikeJob) => job.id, []);

  // Empty with the user's own scoping (chips moved or search typed)
  // keeps the bar visible and offers the reset; empty at the resting
  // state is simply "No jobs yet."
  const filteredEmpty = shown.length === 0 && (searchOpen || !filtersAreDefault(filters));

  return (
    <View style={{ flex: 1, backgroundColor: SEMANTIC.bg.app }} testID="job-logs-screen">
      <Header searchOpen={searchOpen} onToggleSearch={() => setSearchOpen(!searchOpen)} />

      {searchOpen ? (
        <View style={{ paddingHorizontal: SPACE[4], paddingBottom: SPACE[2] }}>
          <TextField
            label="Search"
            value={query}
            onChangeText={setQuery}
            placeholder="Job number, customer, phone or area"
            testID="job-logs-search-field"
          />
        </View>
      ) : (
        <FilterBar
          filters={filters}
          onChange={setFilters}
          onClear={() => setFilters(DEFAULT_FILTERS)}
        />
      )}

      <Text testID="job-logs-result-count" style={{ ...textStyle('caption'), color: SEMANTIC.text.secondary, paddingHorizontal: SPACE[4], paddingVertical: SPACE[2] }}>
        {formatResultCount(shown.length, overdueCount)}
      </Text>

      {shown.length === 0 ? (
        filteredEmpty ? (
          <EmptyState
            message="No jobs match these filters."
            actionLabel="Clear filters"
            onAction={() => {
              setFilters(DEFAULT_FILTERS);
              setQuery('');
            }}
            testID="job-logs-empty-filtered"
          />
        ) : (
          <EmptyState message="No jobs yet." testID="job-logs-empty-all" />
        )
      ) : (
        <FlashList<SpikeJob>
          testID="job-logs-list"
          data={shown}
          renderItem={renderItem}
          keyExtractor={keyExtractor}
          contentContainerStyle={{ paddingBottom: SPACE[8] }}
          showsVerticalScrollIndicator={false}
        />
      )}
    </View>
  );
}
