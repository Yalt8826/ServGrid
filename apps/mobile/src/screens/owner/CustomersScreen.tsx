/**
 * The owner's customers list (§O4b) — the desk table and the phone
 * cards. **Desktop is a table** — name · area · phone · company ·
 * units · open jobs · last job — "with a side detail. Not cards. Same
 * rule as everywhere else on this role." The phone renders the SAME
 * rows as cards; a card tap pushes `/customers/:id`, a table row click
 * opens the side detail. The side detail is the dispatcher's detail
 * with the scope opened up: company link to the ledger, editable stack.
 */
import { useMemo, useState } from 'react';
import { FlashList } from '@shopify/flash-list';
import { Pressable, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, EmptyState, Skeleton, useDensity } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { DeskTable } from './deskTable';
import type { DeskTableColumn, SortState } from './deskTable';

import {
  sortOwnerCustomers,
  unitsLabelOf,
  type OwnerCustomerRow,
} from './customersModel';

/**
 * The LIST's deps, and only the list's (2026-09-17). This used to extend
 * the detail body's deps so the desk could mount it in a side pane; the
 * row now opens the site's own page instead, so every detail prop that
 * travelled through here is gone rather than ignored.
 */
export interface OwnerCustomersDeps {
  offline: boolean;
  error: string | null;
  loading: boolean;
  rows: OwnerCustomerRow[];
  onRetryList(): void;
  /** The row, pressed: the site's page. Phone cards and the desk table both. */
  onOpenCustomer(customerId: string): void;
  /**
   * What an empty list means here (OW.6). "No customers yet" is a lie
   * when a search is narrowing them, and the difference between "you have
   * none" and "none match" is the difference between a dead end and a
   * typo.
   */
  emptyMessage?: string;
}

function phoneCard(row: OwnerCustomerRow, onOpen: (id: string) => void): React.ReactElement {
  return (
    <Pressable
      key={row.id}
      testID={`owner-customer-card-${row.id}`}
      accessibilityRole="button"
      accessibilityLabel={`Open ${row.name}`}
      onPress={() => onOpen(row.id)}
      style={styles.card}
    >
      <View style={styles.cardMain}>
        <Text style={styles.cardName}>{row.name}</Text>
        <Text style={styles.cardMeta}>{`${row.phone}${row.area === null ? '' : ` · ${row.area}`}`}</Text>
        <Text style={styles.cardMeta}>{row.location ?? 'Location not captured'}</Text>
        <Text style={styles.cardMeta}>
          {row.companyName === null ? 'No company' : row.companyName}
        </Text>
        <Text style={styles.cardMeta}>
          {`${unitsLabelOf(row.units)} units · ${row.openJobs} open${row.lastJob === null ? '' : ` · last ${row.lastJob}`}`}
        </Text>
      </View>
    </Pressable>
  );
}

export function OwnerCustomersScreen(deps: OwnerCustomersDeps): React.ReactNode {
  const density = useDensity();
  const desk = density === 'desk';
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const rows = useMemo(() => sortOwnerCustomers(deps.rows), [deps.rows]);

  const columns: DeskTableColumn<OwnerCustomerRow>[] = [
    {
      key: 'name',
      label: 'Name',
      // The one flexing column, and it holds the company too: a standalone
      // Company column spent 128px saying "No company" on nearly every row,
      // which is width the address needs more (2026-09-17).
      width: null,
      render: (r) => (
        <Text numberOfLines={1}>
          <Text style={styles.cell} testID={`customer-name-${r.id}`}>
            {r.name}
          </Text>
          {r.companyName === null ? null : (
            <Text style={styles.cellMuted} testID={`customer-company-${r.id}`}>
              {`  ${r.companyName}`}
            </Text>
          )}
        </Text>
      ),
      sortValue: (r) => r.name,
    },
    {
      key: 'area',
      label: 'Area',
      width: 118,
      render: (r) => (
        <Text style={styles.cell} numberOfLines={1} testID={`customer-area-${r.id}`}>
          {r.area ?? '—'}
        </Text>
      ),
      sortValue: (r) => r.area ?? '',
    },
    {
      key: 'address',
      label: 'Address',
      // The widest cell on the list, and the one worth the room: a full
      // address is how a site is recognised when the name means nothing.
      width: 236,
      render: (r) => (
        <Text style={styles.cell} numberOfLines={1} testID={`customer-address-${r.id}`}>
          {r.address ?? '—'}
        </Text>
      ),
      sortValue: (r) => r.address ?? '',
    },
    {
      key: 'location',
      label: 'Location',
      // 20 mono characters — "12.971600, 77.594600" — plus the cell's padding.
      width: 194,
      render: (r) =>
        r.location === null ? (
          // Never captured is a fact about the site, and it names who
          // fills it — the office is not the one standing there.
          <Text style={styles.cellMuted} numberOfLines={1} testID={`customer-location-${r.id}`}>
            Not captured
          </Text>
        ) : (
          <Text style={styles.cellMono} numberOfLines={1} testID={`customer-location-${r.id}`}>
            {r.location}
          </Text>
        ),
      sortValue: (r) => r.location ?? '',
    },
    {
      key: 'phone',
      label: 'Phone',
      width: 122,
      render: (r) => (
        <Text numberOfLines={1} style={styles.cellMono}>
          {r.phone}
        </Text>
      ),
      sortValue: (r) => r.phone,
    },
    {
      key: 'units',
      label: 'Units',
      width: 62,
      align: 'right',
      render: (r) => (
        <Text numberOfLines={1} style={styles.cellMono} testID={`customer-units-${r.id}`}>
          {unitsLabelOf(r.units)}
        </Text>
      ),
      sortValue: (r) => r.units ?? -1,
    },
    {
      key: 'openJobs',
      label: 'Open jobs',
      width: 82,
      align: 'right',
      render: (r) => (
        <Text numberOfLines={1} style={styles.cellMono} testID={`customer-open-${r.id}`}>
          {String(r.openJobs)}
        </Text>
      ),
      sortValue: (r) => r.openJobs,
    },
    {
      key: 'lastJob',
      label: 'Last job',
      width: 96,
      render: (r) => (
        <Text style={styles.cellMono} numberOfLines={1}>
          {r.lastJob ?? '—'}
        </Text>
      ),
      sortValue: (r) => r.lastJob ?? '',
    },
  ];

  return (
    <View style={styles.screen} testID="owner-customers-screen">
      {/* The route's DeskListShell owns the desk header; this one is the
      phone's title — on the desk it duplicated the page header. */}
      {!desk ? (
        <View style={styles.header}>
          <Text style={styles.title}>Customers</Text>
          <Text style={styles.count} testID="owner-customers-count">
            {`${rows.length} sites`}
          </Text>
        </View>
      ) : null}

      {deps.offline ? (
        <Banner tone="danger" message="No connection. This screen is not live." testID="owner-customers-offline" />
      ) : null}
      {deps.error !== null ? (
        <EmptyState message={deps.error} actionLabel="Retry" onAction={deps.onRetryList} testID="owner-customers-error" />
      ) : deps.loading && deps.rows.length === 0 ? (
        <View style={styles.loading} testID="owner-customers-loading">
          {Array.from({ length: 6 }, (_, i) => (
            <View key={i} style={styles.skeletonRow}>
              <Skeleton width="30%" height={13} />
              <Skeleton width="50%" height={13} />
            </View>
          ))}
        </View>
      ) : rows.length === 0 ? (
        <EmptyState message={deps.emptyMessage ?? 'No customers yet.'} testID="owner-customers-empty" />
      ) : desk ? (
        // The row opens the SITE'S PAGE, not a pane beside it (owner,
        // 2026-09-17). The page is the same body this pane mounted, with
        // room for the address, the equipment and the job history — and
        // one click from the list rather than a selection to manage.
        <View style={styles.deskBody}>
          <DeskTable
            data={rows}
            rowKey={(r) => r.id}
            sort={sort}
            onSort={setSort}
            scrollTestID="owner-customers-table"
            onRowPress={(r) => deps.onOpenCustomer(r.id)}
            columns={columns}
          />
        </View>
      ) : (
        <View style={styles.phoneBody}>
          <FlashList
            testID="owner-customers-list"
            data={rows}
            renderItem={({ item }) => phoneCard(item, deps.onOpenCustomer)}
            keyExtractor={(item) => item.id}
            contentContainerStyle={{ paddingBottom: SPACE[8] }}
          />
        </View>
      )}
    </View>
  );
}

const styles = StyleSheet.create({
  screen: { flex: 1, backgroundColor: SEMANTIC.bg.app },
  header: {
    flexDirection: 'row',
    alignItems: 'baseline',
    justifyContent: 'space-between',
    paddingHorizontal: SPACE[4],
    paddingTop: SPACE[3],
    paddingBottom: SPACE[1],
  },
  title: { ...textStyle('h1'), color: SEMANTIC.text.primary },
  count: { ...textStyle('caption'), color: SEMANTIC.text.secondary, fontVariant: ['tabular-nums'] },
  loading: { padding: SPACE[4], gap: SPACE[2] },
  skeletonRow: { flexDirection: 'row', justifyContent: 'space-between', paddingVertical: 10 },
  deskBody: { flex: 1 },
  phoneBody: { flex: 1 },
  card: {
    minHeight: 72,
    backgroundColor: SEMANTIC.bg.raised,
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    paddingHorizontal: SPACE[3],
    paddingVertical: SPACE[2],
    gap: 2,
  },
  cardMain: { flex: 1 },
  cardName: { ...textStyle('bodyStrong'), color: SEMANTIC.text.primary },
  cardMeta: { ...textStyle('caption'), color: SEMANTIC.text.secondary },
  cell: { ...textStyle('body', 'desk'), color: SEMANTIC.text.primary },
  cellMono: { ...textStyle('mono', 'desk'), color: SEMANTIC.text.primary, fontVariant: ['tabular-nums'] },
  cellMuted: { ...textStyle('body', 'desk'), color: SEMANTIC.text.secondary },
});
