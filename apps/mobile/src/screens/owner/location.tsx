/**
 * O3 Location console (T4.10, UI/plan-2/07-OWNER.md §O3) — web only in
 * purpose, universal in file: the APK renders the phone half (roster
 * with health + last-seen, NO map), the owner's desk renders three
 * panes (roster · map · locate-now). The map itself is platform-split:
 * `./locationMap` resolves to the web file (MapLibre GL, raster) under
 * Metro web and to an inert stub on native and under vitest — the APK
 * never sees a map library, and the phone rule ("no map component at
 * all") is true in the rendered tree, not just the layout.
 *
 * The roster is sorted by HEALTH SEVERITY, not alphabetically — the
 * person with a problem is at the top — and it renders as ROWS with
 * sortable columns and the health colour on a 4px left edge on desk,
 * the same scannable edge on phone. Never a card grid (the screen rule
 * this phase reviews on).
 *
 * *Locate now* must not lie. The request is persisted server-side
 * (T4.4), so every state is a statement: "Requested — waiting for the
 * device" with the elapsed seconds counting; "Located" when the fix
 * arrives; or "Requested 2 min ago — device has not answered" WITH the
 * why. **Never a spinner** — nothing in this file renders one, because
 * a spinner implies the answer is coming and the whole point of
 * persisting the request is to be able to say it is not.
 *
 * The one permitted continuous animation lives in `livePulse.ts` and
 * this screen arms it with exactly `pulseActive` — the route's
 * `focused && liveWindowOpen`, so blurring the screen cancels it.
 *
 * The screen is pure over injected data (the house seam); the route
 * file feeds it through `useLocationConsole`.
 */
import { useMemo, useState } from 'react';
import { Pressable, StyleSheet, Text, View } from 'react-native';
import Animated from 'react-native-reanimated';

import { DENSITY, SEMANTIC, SPACE, TAP } from '@servgrid/shared';
import { Button, EmptyState, Skeleton } from '../../components/ui';
import { useSkeleton } from '../../components/ui/Skeleton';
import { textStyle } from '../../fonts/textStyle';
import { LocationMap, type LocationMapProps } from './locationMap';
import {
  formatLastSeen,
  healthView,
  NO_ANSWER_TEXT,
  requestViewOf,
  sortRoster,
  type LocateRequest,
  type RequestStateView,
  type RosterRow,
  type TrailStop,
} from './locationModel';
import { useLivePulse } from './livePulse';

// ── the deps seam ────────────────────────────────────────────────────────────

export interface LocationConsoleDeps {
  /** Injected clock — elapsed seconds and the live window judge by it. */
  now: number;
  /** Desk presentation: three panes. Phone: roster only. */
  desk: boolean;
  /** `owner.location` gates the whole console (the route renders dark
   * without it; this flag only mutes the actions belt-and-braces). */
  flagOn: boolean;
  /** Roster read; null while loading, error message when the read died. */
  rows: RosterRow[] | null;
  error: string | null;
  /** A refused locate-now POST — shown at the actions, not over the roster. */
  actionError: string | null;
  selectedEmployeeId: string | null;
  onSelectEmployee(employeeId: string): void;
  /** The selected employee's labelled trail vertices (desk draws them). */
  trailStops: TrailStop[] | null;
  trailCount: number;
  trailLoading: boolean;
  /** The open locate-now request and whether its POST is still in flight. */
  request: LocateRequest | null;
  requestBusy: boolean;
  /** `focused && liveWindowOpen` — arms the one permitted pulse. */
  pulseActive: boolean;
  onLocateNow(): void;
  onLive(): void;
  onRetry(): void;
}

// ── one roster row ───────────────────────────────────────────────────────────

interface RowProps {
  row: RosterRow;
  selected: boolean;
  pulse: boolean;
  desk: boolean;
  onPress(row: RosterRow): void;
}

/** The health dot. When this row is the selected employee and the live
 * window is open, the dot is the one thing in the product allowed to
 * pulse — and `useLivePulse` cancels it the instant `pulse` drops. */
function HealthDot({ color, pulse }: { color: string; pulse: boolean }): React.ReactNode {
  const pulseAnim = useLivePulse(pulse);
  const dot = { width: 10, height: 10, borderRadius: 5, backgroundColor: color };
  if (!pulseAnim.running) return <View style={dot} />;
  return (
    <Animated.View style={pulseAnim.style} testID="location-dot-pulse">
      <View style={dot} />
    </Animated.View>
  );
}

function RosterRowView({ row, selected, pulse, desk, onPress }: RowProps): React.ReactNode {
  const [pressed, setPressed] = useState(false);
  const health = healthView(row.health);
  const height = desk ? DENSITY.desk.rowHeight : 56; // desk 40 · phone the 56pt console row
  return (
    <Pressable
      testID={`location-row-${row.employeeId}`}
      accessibilityRole="button"
      accessibilityLabel={`${row.employeeName}, ${health.label}, last seen ${formatLastSeen(row.minutesSince)}`}
      accessibilityState={{ selected }}
      onPress={() => onPress(row)}
      onPressIn={() => setPressed(true)}
      onPressOut={() => setPressed(false)}
      style={[
        styles.row,
        { height },
        pressed ? styles.rowPressed : null,
        selected ? styles.rowSelected : null,
      ]}
    >
      {/* §1.6 — the health colour on the 4px leading edge, never alone:
       * the chip word renders beside it in the same row. */}
      <View style={[styles.rail, { backgroundColor: health.color }]} />
      <Text numberOfLines={1} style={[styles.rowName, desk && styles.rowNameDesk]}>
        {row.employeeName}
      </Text>
      <View style={styles.healthChip}>
        <HealthDot color={health.color} pulse={pulse} />
        <Text style={[styles.healthWord, { color: health.color }]}>{health.label}</Text>
      </View>
      <Text style={[styles.rowSeen, desk && styles.rowSeenDesk]}>{formatLastSeen(row.minutesSince)}</Text>
    </Pressable>
  );
}

// ── the locate-now statement ─────────────────────────────────────────────────

const STATUS_TONE: Record<RequestStateView['kind'], string | null> = {
  idle: null,
  sent: SEMANTIC.text.secondary,
  fulfilled: SEMANTIC.feedback.success,
  closed: SEMANTIC.feedback.danger,
};

function statusText(view: RequestStateView): string {
  switch (view.kind) {
    case 'idle':
      return '';
    case 'sent':
      return `Requested — waiting for the device · ${view.seconds}s`;
    case 'fulfilled':
      return 'Located — the device answered.';
    case 'closed':
      return `Requested ${view.ago} — device has not answered`;
  }
}

function LocateStatus({ view }: { view: RequestStateView }): React.ReactNode {
  if (view.kind === 'idle') return null;
  const tone = STATUS_TONE[view.kind];
  return (
    <View testID="locate-status">
      <Text style={[styles.statusText, tone !== null ? { color: tone } : null]}>{statusText(view)}</Text>
      {view.kind === 'closed' ? (
        <Text style={styles.statusWhy} testID="locate-why">
          {`Why: ${NO_ANSWER_TEXT[view.why]}`}
        </Text>
      ) : null}
    </View>
  );
}

// ── the roster pane: rows, sortable columns, scannable left edge ────────────

type SortKey = 'health' | 'name' | 'seen';

const SORT_LABELS: Record<SortKey, string> = { health: 'Health', name: 'Name', seen: 'Last seen' };

function sortRows(rows: readonly RosterRow[], key: SortKey, dir: 'asc' | 'desc'): RosterRow[] {
  if (key === 'health') {
    const sorted = sortRoster(rows); // asc IS severity — worst first
    return dir === 'asc' ? sorted : sorted.slice().reverse();
  }
  const copy = [...rows];
  copy.sort((a, b) => {
    const primary =
      key === 'name'
        ? a.employeeName.localeCompare(b.employeeName)
        : // seen asc = waited longest first, in the roster's spirit
          (b.minutesSince ?? Number.POSITIVE_INFINITY) - (a.minutesSince ?? Number.POSITIVE_INFINITY);
    return dir === 'asc' ? primary : -primary;
  });
  return copy;
}

function SortHeader({
  sort,
  onSort,
}: {
  sort: { key: SortKey; dir: 'asc' | 'desc' };
  onSort(next: { key: SortKey; dir: 'asc' | 'desc' }): void;
}): React.ReactNode {
  return (
    <View style={styles.sortHeader} testID="roster-sort-header">
      {(['name', 'health', 'seen'] as const).map((key) => {
        const active = sort.key === key;
        return (
          <Pressable
            key={key}
            testID={`roster-sort-${key}`}
            accessibilityRole="button"
            accessibilityLabel={`Sort by ${SORT_LABELS[key]}`}
            onPress={() =>
              onSort(sort.key === key ? { key, dir: sort.dir === 'asc' ? 'desc' : 'asc' } : { key, dir: 'asc' })
            }
            style={[styles.sortCell, key === 'name' ? styles.sortCellName : null]}
          >
            <Text style={[styles.sortLabel, active ? styles.sortLabelActive : null]}>
              {SORT_LABELS[key]}
              {active ? (sort.dir === 'asc' ? ' ↑' : ' ↓') : ''}
            </Text>
          </Pressable>
        );
      })}
    </View>
  );
}

// ── the screen ───────────────────────────────────────────────────────────────

export function LocationConsoleScreen(deps: LocationConsoleDeps): React.ReactNode {
  const [sort, setSort] = useState<{ key: SortKey; dir: 'asc' | 'desc' }>({ key: 'health', dir: 'asc' });

  const loading = deps.rows === null && deps.error === null;
  const showSkeleton = useSkeleton(loading);
  const rows = useMemo(() => sortRows(deps.rows ?? [], sort.key, sort.dir), [deps.rows, sort]);

  const selected = useMemo(
    () => deps.rows?.find((r) => r.employeeId === deps.selectedEmployeeId) ?? null,
    [deps.rows, deps.selectedEmployeeId],
  );
  const view = requestViewOf(deps.request, selected, deps.now);
  const requestOpen = view.kind === 'sent';
  const actionsDisabled = !deps.flagOn || deps.requestBusy || requestOpen || selected === null;
  const disabledReason = selected === null
    ? 'Select a technician first.'
    : requestOpen
      ? 'A request is already open — wait for it to answer or expire.'
      : undefined;

  const mapProps: LocationMapProps = {
    rows: deps.rows ?? [],
    selectedEmployeeId: deps.selectedEmployeeId,
    trailStops: deps.trailStops ?? [],
    pulseActive: deps.pulseActive,
  };

  const locatePanel = (
    <View style={styles.locatePanel} testID="locate-panel">
      {selected !== null ? (
        <Text style={styles.selectedName} numberOfLines={1}>
          {selected.employeeName} · {formatLastSeen(selected.minutesSince)}
        </Text>
      ) : (
        <Text style={styles.selectedName}>Select a technician to locate.</Text>
      )}
      <View style={styles.actions}>
        <Button
          label="Locate now"
          onPress={deps.onLocateNow}
          disabled={actionsDisabled}
          disabledReason={disabledReason}
          testID="locate-now"
        />
        <Button
          label="Live 5 min"
          variant="secondary"
          onPress={deps.onLive}
          disabled={actionsDisabled}
          disabledReason={disabledReason}
          testID="locate-live"
        />
      </View>
      <LocateStatus view={view} />
      {deps.actionError !== null ? (
        <Text style={styles.actionError} testID="locate-action-error">
          {deps.actionError}
        </Text>
      ) : null}
    </View>
  );

  const rosterList = (
    <View style={styles.listWrap} testID="roster-list">
      {deps.error !== null ? (
        <EmptyState message={deps.error} actionLabel="Retry" onAction={deps.onRetry} testID="location-error" />
      ) : showSkeleton ? (
        <View testID="location-skeleton">
          {Array.from({ length: 6 }, (_, i) => (
            <View key={i} style={[styles.row, styles.skeletonRow, { height: deps.desk ? DENSITY.desk.rowHeight : 56 }]}>
              <View style={[styles.rail, { backgroundColor: SEMANTIC.bg.dense }]} />
              <Skeleton width="42%" height={14} />
              <View style={styles.skeletonSpacer} />
              <Skeleton width="20%" height={12} />
            </View>
          ))}
        </View>
      ) : rows.length === 0 ? (
        <EmptyState message="No tracked employees yet." testID="location-empty" />
      ) : (
        <>
          {deps.desk ? <SortHeader sort={sort} onSort={setSort} /> : null}
          {rows.map((row) => (
            <RosterRowView
              key={row.employeeId}
              row={row}
              desk={deps.desk}
              selected={row.employeeId === deps.selectedEmployeeId}
              pulse={deps.pulseActive && row.employeeId === deps.selectedEmployeeId}
              onPress={(r) => deps.onSelectEmployee(r.employeeId)}
            />
          ))}
        </>
      )}
    </View>
  );

  if (!deps.desk) {
    // PHONE: roster only, no map. Health and last-seen is the part that
    // matters, and it is the part that survives descoping (§O3).
    return (
      <View style={styles.screen} testID="location-screen">
        <Text style={styles.title}>Location</Text>
        {rosterList}
        {locatePanel}
      </View>
    );
  }

  // DESK: three panes — roster · map, with locate-now under the roster.
  return (
    <View style={styles.screen} testID="location-screen">
      <View style={styles.deskRow}>
        <View style={styles.rosterPane}>
          <Text style={styles.paneTitle}>Roster</Text>
          {rosterList}
          {locatePanel}
        </View>
        <View style={styles.mapPane} testID="map-pane">
          <LocationMap {...mapProps} />
        </View>
      </View>
      {deps.trailLoading ? (
        <Text style={styles.trailCaption} testID="trail-loading">
          Loading today’s trail…
        </Text>
      ) : deps.trailStops !== null ? (
        <Text style={styles.trailCaption} testID="trail-caption">
          {`${deps.trailCount} fixes today · labels at direction changes`}
        </Text>
      ) : null}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  deskRow: { flex: 1, flexDirection: 'row' },
  rosterPane: { width: 340, borderRightWidth: 1, borderRightColor: SEMANTIC.line.default },
  mapPane: { flex: 1 },
  paneTitle: {
    ...textStyle('h2'),
    color: SEMANTIC.text.primary,
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[1],
  },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary, paddingHorizontal: SPACE[4], paddingTop: SPACE[3] },
  listWrap: { flex: 1 },
  sortHeader: {
    flexDirection: 'row',
    height: DENSITY.desk.rowHeight,
    alignItems: 'center',
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
  },
  sortCell: { width: 96, justifyContent: 'center', minHeight: TAP.desk },
  sortCellName: { flex: 1, paddingLeft: SPACE[3] },
  sortLabel: { ...textStyle('label'), color: SEMANTIC.text.secondary },
  sortLabelActive: { color: SEMANTIC.text.primary, fontWeight: '600' },
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    backgroundColor: SEMANTIC.bg.raised,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  rowPressed: { backgroundColor: SEMANTIC.bg.pressed },
  rowSelected: { borderWidth: 1, borderColor: SEMANTIC.line.focus },
  rail: { width: 4, alignSelf: 'stretch' },
  rowName: { ...textStyle('body'), color: SEMANTIC.text.primary, flex: 1, paddingLeft: SPACE[3] },
  rowNameDesk: { ...textStyle('label'), fontSize: 14, lineHeight: 18 },
  healthChip: { flexDirection: 'row', alignItems: 'center', gap: SPACE[1], width: 116, paddingHorizontal: SPACE[1] },
  healthWord: { ...textStyle('caption') },
  rowSeen: { ...textStyle('caption'), color: SEMANTIC.text.secondary, width: 108, textAlign: 'right', paddingRight: SPACE[2] },
  rowSeenDesk: { width: 84, paddingRight: SPACE[2], fontVariant: ['tabular-nums'] },
  skeletonRow: { gap: SPACE[2], paddingRight: SPACE[3] },
  skeletonSpacer: { flex: 1 },
  locatePanel: {
    padding: SPACE[4],
    gap: SPACE[2],
    borderTopWidth: 1,
    borderTopColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.raised,
  },
  selectedName: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  actions: { flexDirection: 'row', gap: SPACE[2] },
  statusText: { ...textStyle('body'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] },
  statusWhy: { ...textStyle('caption'), color: SEMANTIC.text.secondary, marginTop: SPACE[1] },
  actionError: { ...textStyle('caption'), color: SEMANTIC.feedback.danger },
  trailCaption: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
    paddingHorizontal: SPACE[4],
    paddingVertical: SPACE[1],
    fontVariant: ['tabular-nums'],
  },
});
