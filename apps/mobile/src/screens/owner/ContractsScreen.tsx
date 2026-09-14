/**
 * O6 Contracts — the list and the RENEWALS view (UI/plan-2/07-OWNER.md
 * §O6). Columns: number · site · billing · visits used/included · start
 * · end · value · sold by.
 *
 * **Renewals is a filtered view, not a separate screen**: the same
 * screen with `variant="renewals"` — expiring within 60 days, sorted by
 * days remaining, each row still showing visits used, because a spent
 * visit reduces what the renewal is worth. The phone renders the same
 * rows as cards; the desktop the same rows as the table.
 *
 * Pure UI over injected data; the data seam owns the reads.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, EmptyState, useDensity } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { DeskTable } from './deskTable';
import type { SortState } from './deskTable';
import {
  renewalsOf,
  sortContractsByEnd,
  type ContractRow,
  type ContractRowWithDays,
} from './model';

export interface OwnerContractsScreenProps {
  /** 'all' is the contract list; 'renewals' the 60-day filtered view. */
  variant: 'all' | 'renewals';
  rows: ContractRow[];
  error: string | null;
  loading: boolean;
  /** Today's IST business date — the renewals window is relative to it. */
  today: string;
  onOpenContract: (contractId: string) => void;
  onRetry: () => void;
  testID?: string;
}

export function OwnerContractsScreen(props: OwnerContractsScreenProps): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'endDate', dir: 'asc' });
  const density = useDensity();
  const desk = density === 'desk';
  const nowYear = new Date().getFullYear();

  const shown: ContractRowWithDays[] =
    props.variant === 'renewals'
      ? renewalsOf(props.rows, props.today)
      : sortContractsByEnd(props.rows).map((r) => ({ ...r, daysRemaining: nullSafeDays(r.endDate, props.today) }));

  const visitsCell = (r: ContractRow): React.ReactNode => (
    <Text style={styles.monoCell} testID={`contract-visits-${r.id}`}>
      {`${r.visitsUsed}/${r.visitsIncluded}`}
    </Text>
  );

  return (
    <View style={styles.root} testID={props.testID ?? (props.variant === 'renewals' ? 'owner-renewals' : 'owner-contracts')}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-contracts-error" />
      ) : null}

      {!props.loading && props.error === null && shown.length === 0 ? (
        props.variant === 'renewals' ? (
          <EmptyState message="Nothing expires in the next 60 days." testID="owner-renewals-empty" />
        ) : (
          <EmptyState message="No contracts yet." testID="owner-contracts-empty" />
        )
      ) : desk ? (
        <DeskTable
          data={shown}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={setSort}
          scrollTestID={props.variant === 'renewals' ? 'owner-renewals-table' : 'owner-contracts-table'}
          onRowPress={(r) => props.onOpenContract(r.id)}
          columns={[
            {
              key: 'contractNumber',
              label: 'Number',
              width: 130,
              render: (r) => (
                <Text style={styles.monoCell} testID={`contract-number-${r.id}`}>
                  {r.contractNumber ?? 'Draft'}
                </Text>
              ),
              sortValue: (r) => r.contractNumber ?? '',
            },
            {
              key: 'site',
              label: 'Site',
              width: null,
              render: (r) => <Text style={styles.cell}>{r.site}</Text>,
              sortValue: (r) => r.site,
            },
            {
              key: 'billing',
              label: 'Billing',
              width: 84,
              render: (r) => <Text style={styles.cell}>{r.billing === 'upfront' ? 'Upfront' : 'On visit'}</Text>,
              sortValue: (r) => r.billing,
            },
            {
              key: 'visits',
              label: 'Visits',
              width: 72,
              align: 'right',
              render: visitsCell,
              sortValue: (r) => r.visitsUsed,
            },
            {
              key: 'startDate',
              label: 'Start',
              width: 96,
              render: (r) => <Text style={styles.monoCell}>{formatDateEnIN(r.startDate, nowYear)}</Text>,
              sortValue: (r) => r.startDate,
            },
            {
              key: 'endDate',
              label: 'End',
              width: 96,
              render: (r) => (
                <Text style={styles.monoCell} testID={`contract-end-${r.id}`}>
                  {formatDateEnIN(r.endDate, nowYear)}
                </Text>
              ),
              sortValue: (r) => r.endDate,
            },
            {
              key: 'value',
              label: 'Value',
              width: 110,
              align: 'right',
              render: (r) => <Text style={styles.monoCell}>{`₹${formatMoneyEnIN(r.value)}`}</Text>,
              sortValue: (r) => Number(r.value),
            },
            {
              key: 'soldByName',
              label: 'Sold by',
              width: 120,
              render: (r) => <Text style={styles.cell}>{r.soldByName ?? '—'}</Text>,
              sortValue: (r) => r.soldByName ?? '',
            },
            ...(props.variant === 'renewals'
              ? [
                  {
                    key: 'daysRemaining',
                    label: 'Days',
                    width: 64,
                    align: 'right' as const,
                    render: (r: ContractRowWithDays) => (
                      <Text style={styles.monoCell} testID={`contract-days-${r.id}`}>
                        {String(r.daysRemaining)}
                      </Text>
                    ),
                    sortValue: (r: ContractRowWithDays) => r.daysRemaining,
                  },
                ]
              : []),
          ]}
        />
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {shown.map((row) => (
            <View key={row.id} style={styles.card} testID={`contract-row-${row.id}`}>
              <View style={styles.cardMain}>
                <Text style={styles.monoCell} testID={`contract-number-${row.id}`}>
                  {row.contractNumber ?? 'Draft'}
                </Text>
                <Text style={styles.cellStrong}>{row.site}</Text>
                <Text style={styles.secondary}>
                  {`${row.billing === 'upfront' ? 'Upfront' : 'On visit'} · ${row.visitsUsed}/${row.visitsIncluded} visits`}
                </Text>
                <Text style={styles.secondary}>
                  {`${formatDateEnIN(row.startDate, nowYear)} → ${formatDateEnIN(row.endDate, nowYear)}`}
                </Text>
                <Text style={styles.secondary}>
                  {`₹${formatMoneyEnIN(row.value)}${row.soldByName === null ? '' : ` · sold by ${row.soldByName}`}`}
                </Text>
              </View>
              {props.variant === 'renewals' ? (
                <View style={styles.cardSide}>
                  <Text style={styles.days} testID={`contract-days-${row.id}`}>
                    {`${row.daysRemaining}d`}
                  </Text>
                </View>
              ) : null}
            </View>
          ))}
        </ScrollView>
      )}
    </View>
  );
}

/** Calendar days from `today` to `iso` for the list's End column — the
 * renewals view's own count comes from `renewalsOf`. */
function nullSafeDays(iso: string, today: string): number {
  const [y = 1970, m = 1, d = 1] = iso.split('-').map(Number);
  const [ty = 1970, tm = 1, td = 1] = today.split('-').map(Number);
  return Math.round((Date.UTC(y, m - 1, d) - Date.UTC(ty, tm - 1, td)) / 86_400_000);
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  card: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  cardMain: { flex: 1, gap: 2 },
  cardSide: { alignItems: 'flex-end' },
  days: {
    ...textStyle('h2'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  cell: {
    ...textStyle('body', 'desk'),
    color: SEMANTIC.text.primary,
  },
  cellStrong: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
  monoCell: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
  },
  secondary: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
});
