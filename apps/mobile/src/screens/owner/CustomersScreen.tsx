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
import { OwnerCustomerDetailBody, type OwnerCustomerDetailDeps } from './CustomerDetailBody';
import {
  sortOwnerCustomers,
  unitsLabelOf,
  type OwnerCustomerRow,
} from './customersModel';

export interface OwnerCustomersDeps extends OwnerCustomerDetailDeps {
  offline: boolean;
  error: string | null;
  loading: boolean;
  rows: OwnerCustomerRow[];
  onRetryList(): void;
  /** Phone: push. Desk: the side detail takes over. */
  onOpenCustomer(customerId: string): void;
  selectedCustomerId: string | null;
  onSelectCustomer(customerId: string | null): void;
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
      width: null,
      render: (r) => (
        <Text style={styles.cell} numberOfLines={1} testID={`customer-name-${r.id}`}>
          {r.name}
        </Text>
      ),
      sortValue: (r) => r.name,
    },
    {
      key: 'area',
      label: 'Area',
      width: 130,
      render: (r) => (
        <Text style={styles.cell} numberOfLines={1}>
          {r.area ?? '—'}
        </Text>
      ),
      sortValue: (r) => r.area ?? '',
    },
    {
      key: 'phone',
      label: 'Phone',
      width: 120,
      render: (r) => <Text style={styles.cellMono}>{r.phone}</Text>,
      sortValue: (r) => r.phone,
    },
    {
      key: 'company',
      label: 'Company',
      width: 150,
      render: (r) => (
        <Text style={styles.cell} numberOfLines={1} testID={`customer-company-${r.id}`}>
          {r.companyName ?? 'No company'}
        </Text>
      ),
      sortValue: (r) => r.companyName ?? '',
    },
    {
      key: 'units',
      label: 'Units',
      width: 64,
      align: 'right',
      render: (r) => (
        <Text style={styles.cellMono} testID={`customer-units-${r.id}`}>
          {unitsLabelOf(r.units)}
        </Text>
      ),
      sortValue: (r) => r.units ?? -1,
    },
    {
      key: 'openJobs',
      label: 'Open jobs',
      width: 88,
      align: 'right',
      render: (r) => (
        <Text style={styles.cellMono} testID={`customer-open-${r.id}`}>
          {String(r.openJobs)}
        </Text>
      ),
      sortValue: (r) => r.openJobs,
    },
    {
      key: 'lastJob',
      label: 'Last job',
      width: 150,
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
      <View style={styles.header}>
        <Text style={styles.title}>Customers</Text>
        <Text style={styles.count} testID="owner-customers-count">
          {`${rows.length} sites`}
        </Text>
      </View>

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
        <EmptyState message="No customers yet." testID="owner-customers-empty" />
      ) : desk ? (
        <View style={styles.deskBody}>
          <View style={styles.tableWrap}>
            <DeskTable
              data={rows}
              rowKey={(r) => r.id}
              sort={sort}
              onSort={setSort}
              scrollTestID="owner-customers-table"
              onRowPress={(r) => deps.onSelectCustomer(r.id)}
              columns={columns}
            />
          </View>
          {deps.selectedCustomerId !== null ? (
            <View style={styles.sideDetail} testID="owner-customers-side-detail">
              <OwnerCustomerDetailBody
                detail={deps.detail}
                loading={deps.loading}
                detailError={deps.detailError}
                companyName={deps.companyName}
                stack={deps.stack}
                history={deps.history}
                historyError={deps.historyError}
                editing={deps.editing}
                savingStack={deps.savingStack}
                stackError={deps.stackError}
                onSaveStackItem={deps.onSaveStackItem}
                onRemoveStackItem={deps.onRemoveStackItem}
                onCloseSheet={deps.onCloseSheet}
                onEditStackItemOpen={deps.onEditStackItemOpen}
                onCall={deps.onCall}
                onEdit={deps.onEdit}
                onOpenJob={deps.onOpenJob}
                onOpenCompany={deps.onOpenCompany}
                onRetry={deps.onRetry}
                testID="owner-customers-side-detail-body"
              />
            </View>
          ) : null}
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
  deskBody: { flex: 1, flexDirection: 'row' },
  tableWrap: { flex: 1 },
  sideDetail: {
    width: 420,
    borderLeftWidth: 1,
    borderLeftColor: SEMANTIC.line.default,
    backgroundColor: SEMANTIC.bg.app,
  },
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
});
