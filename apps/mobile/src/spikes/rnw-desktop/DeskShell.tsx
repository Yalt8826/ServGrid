/**
 * T4.1 spike shell (THROWAWAY) — rail + DataTable as the owner's desk
 * layout, plus the in-page measurement API the browser harness drives:
 *
 *   `window.__rnwspike`   — hooks: scroll element, header rects, sort
 *                           state, render counters, a scripted sort path
 *   `spike:ready`         — performance mark: table laid out
 *   `spike:sort-start:*` / `spike:sort-applied` — per-sort marks
 *
 * Nothing here is product code; the instrumentation in particular must
 * not outlive the spike.
 */
import { useCallback, useEffect, useLayoutEffect, useState } from 'react';
import { Text, View } from 'react-native';

import { SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { resolveFontFamily, textStyle } from '../../fonts/textStyle';
import { DataTable, resetRowRenderCount, rowRenderCount, type SortKey, type SortState } from './DataTable';
import { DeskRail } from './DeskRail';
import type { DeskJob } from './mockJobs';

const SORT_LABEL: Record<SortKey, string> = {
  jobNumber: 'Number',
  customer: 'Customer',
  scheduledForMs: 'Scheduled',
  amount: 'Amount',
};

const styles = {
  page: { flex: 1, flexDirection: 'row' as const, backgroundColor: SEMANTIC.bg.app },
  content: { flex: 1, minWidth: 0 },
  topBar: {
    height: 56,
    flexDirection: 'row' as const,
    alignItems: 'center' as const,
    gap: SPACE[3],
    paddingHorizontal: TAP.gutterDesk,
    backgroundColor: SEMANTIC.bg.raised,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  title: {
    ...textStyle('h2'),
    color: SEMANTIC.text.primary,
  },
  count: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    fontVariant: ['tabular-nums' as const],
  },
  hero: {
    ...textStyle('displayLg'),
    color: SEMANTIC.text.primary,
    fontFamily: resolveFontFamily('cond', '600'),
  },
  tableArea: { flex: 1, paddingHorizontal: TAP.gutterDesk },
};

// The h2 title renders at its token size; the displayLg hero rides the
// top bar purely so the harness can verify the Condensed face loads on
// web — displayLg 44 is the desk hero figure (§O1 desktop).
const TITLE_TEXT = 'Jobs';

declare global {
  // eslint-disable-next-line no-var
  var __rnwspike: {
    ready: boolean;
    requestSort: (key: SortKey) => void;
    sortState: () => SortState;
    scrollEl: () => Element | null;
    rects: () => {
      innerWidth: number;
      innerHeight: number;
      header: DOMRect | null;
      container: DOMRect | null;
      firstRowText: string | null;
    };
    metrics: () => { rowsRendered: number };
    resetMetrics: () => void;
  } | null;
}

export function DeskShell({ jobs }: { jobs: DeskJob[] }): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'jobNumber', dir: 'asc' });

  const onSort = useCallback((next: SortState) => {
    setSort(next);
  }, []);

  const requestSort = useCallback(
    (key: SortKey) => {
      // Same path the header press takes, minus the pointer event — the
      // harness's deterministic fallback.
      performance.mark(`spike:sort-start:${key}`);
      setSort((prev) =>
        prev.key === key
          ? { key, dir: prev.dir === 'asc' ? 'desc' : 'asc' }
          : { key, dir: key === 'amount' ? 'desc' : 'asc' },
      );
    },
    [],
  );

  useLayoutEffect(() => {
    performance.mark('spike:ready');
  }, []);

  useEffect(() => {
    window.__rnwspike = {
      ready: true,
      requestSort,
      sortState: () => sort,
      scrollEl: () => document.querySelector('[data-testid="data-table-scroll"]'),
      rects: () => {
        const header = document.querySelector('[data-testid="table-header"]');
        const container = document.querySelector('[data-testid="data-table-scroll"]');
        // FlashList v2 positions rows with transforms, not DOM order —
        // the "first" row is the one whose rect sits at the container
        // top, not the first DOM match.
        const containerTop = container?.getBoundingClientRect().top ?? 0;
        let firstRowText: string | null = null;
        let bestTop = Number.POSITIVE_INFINITY;
        container?.querySelectorAll('[aria-label^="JC-"]').forEach((el) => {
          const top = el.getBoundingClientRect().top;
          if (top >= containerTop - 1 && top < bestTop) {
            bestTop = top;
            firstRowText = el.getAttribute('aria-label');
          }
        });
        return {
          innerWidth: window.innerWidth,
          innerHeight: window.innerHeight,
          header: header?.getBoundingClientRect() ?? null,
          container: container?.getBoundingClientRect() ?? null,
          firstRowText,
        };
      },
      metrics: () => ({ rowsRendered: rowRenderCount() }),
      resetMetrics: () => resetRowRenderCount(),
    };
    return () => {
      window.__rnwspike = null;
    };
  }, [sort, requestSort]);

  return (
    <View style={styles.page}>
      <DeskRail activeHref="/jobs" />
      <View style={styles.content}>
        <View style={styles.topBar}>
          <Text style={styles.title}>{TITLE_TEXT}</Text>
          <Text style={styles.hero}>₹12,970</Text>
          <View style={{ flex: 1 }} />
          <Text style={styles.count}>
            {jobs.length} jobs · sorted by {SORT_LABEL[sort.key]} {sort.dir === 'asc' ? '↑' : '↓'}
          </Text>
        </View>
        <View style={styles.tableArea}>
          <DataTable data={jobs} sort={sort} onSort={onSort} scrollTestID="data-table-scroll" />
        </View>
      </View>
    </View>
  );
}
