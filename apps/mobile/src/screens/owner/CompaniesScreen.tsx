/**
 * O5 Companies — the owner's list (UI/plan-2/07-OWNER.md §O5). Every
 * account, both reps', plus the house accounts, with the **owner rep
 * column** — and the **reassignment control that exists nowhere else in
 * the product**: Reassign opens the sheet whose *Nobody* option makes
 * the account a house account, which is how leave gets covered.
 *
 * The rep's companies screen carries no reassign surface by
 * construction — the owner's is the only one (companies.test.tsx greps
 * the rep's tree to hold that line).
 *
 * Phone: cards. Desktop: table with a running total of outstanding dues.
 */
import { useMemo, useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, DeskListShell, EmptyState, Panel, Select, TextField, useDensity } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { creditView } from '../rep/money';
import { DeskTable } from './deskTable';
import type { SortState } from './deskTable';
import { sortOwnerCompanies, type OwnerCompanyRow } from './model';
import { ReassignSheet } from './ReassignSheet';
import type { RepOption } from './ReassignSheet';

/** The house-account option — first, because it is the answer when
 * nobody owns the account (§O5: how leave gets covered). */
const HOUSE_OPTION: RepOption = { id: null, name: 'Nobody — house account' };

/** The filter select's facets — the questions the owner actually asks
 * of this list: who do I chase, what runs on the house. */
const FILTER_OPTIONS = [
  { value: 'all', label: 'All accounts' },
  { value: 'dues', label: 'With outstanding dues' },
  { value: 'house', label: 'House accounts' },
] as const;

type AccountFilter = (typeof FILTER_OPTIONS)[number]['value'];

export interface OwnerCompaniesScreenProps {
  rows: OwnerCompanyRow[];
  error: string | null;
  loading: boolean;
  onOpenCompany: (companyId: string) => void;
  /** The sales reps — the reassignment options. */
  reps: readonly RepOption[];
  /** Confirms the move; `ownerRepId: null` makes it a house account. */
  onReassign: (companyId: string, ownerRepId: string | null) => void;
  reassignBusy: boolean;
  reassignError: string | null;
  onRetry: () => void;
  testID?: string;
}

export function OwnerCompaniesScreen(props: OwnerCompaniesScreenProps): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'balance', dir: 'desc' });
  const [reassignTarget, setReassignTarget] = useState<OwnerCompanyRow | null>(null);
  const [query, setQuery] = useState('');
  const [filter, setFilter] = useState<AccountFilter>('all');
  const density = useDensity();
  const desk = density === 'desk';
  const sorted = sortOwnerCompanies(props.rows);

  // Client-side by design: the account list is small (it is the whole
  // customer base of the business, capped well under the table's 200),
  // and the reads already carry every field the facets need.
  const rows = useMemo(() => {
    const q = query.trim().toLowerCase();
    return sorted.filter((r) => {
      if (q !== '' && !r.name.toLowerCase().includes(q)) return false;
      if (filter === 'dues') return r.balance !== null && Number(r.balance) > 0;
      if (filter === 'house') return r.shared;
      return true;
    });
  }, [sorted, query, filter]);

  const openReassign = (row: OwnerCompanyRow): void => setReassignTarget(row);

  const totalDues = sorted.reduce((acc, r) => (r.balance !== null && Number(r.balance) > 0 ? acc + Number(r.balance) : acc), 0);

  const repColumn = {
    key: 'ownerRepName',
    label: 'Owner rep',
    width: 150,
    render: (r: OwnerCompanyRow) => (
      <Text numberOfLines={1} style={styles.cell} testID={`company-rep-${r.companyId}`}>
        {r.shared ? 'House account' : (r.ownerRepName ?? '—')}
      </Text>
    ),
    sortValue: (r: OwnerCompanyRow) => (r.shared ? '' : (r.ownerRepName ?? '')),
  };

  const reassignColumn = {
    key: 'reassign',
    label: '',
    width: 112,
    render: (r: OwnerCompanyRow) => (
      <Button
        label="Reassign"
        variant="ghost"
        onPress={() => openReassign(r)}
        testID={`company-reassign-${r.companyId}`}
      />
    ),
  };

  const filtered = query.trim() !== '' || filter !== 'all';

  return (
    <DeskListShell
      title="Companies"
      subtitle={
        desk
          ? filtered
            ? `${rows.length} of ${sorted.length} accounts`
            : `${sorted.length} accounts`
          : undefined
      }
      actions={
        <>
          <View style={{ minWidth: 240 }}>
            <TextField label="Search" value={query} onChangeText={setQuery} placeholder="Company name" testID="owner-companies-search" />
          </View>
          <View style={{ minWidth: 220 }}>
            <Select
              label="Filter"
              value={filter}
              options={FILTER_OPTIONS.map((o) => ({ ...o }))}
              onSelect={(v) => setFilter(v as AccountFilter)}
              testID="owner-companies-filter"
            />
          </View>
        </>
      }
      testID={props.testID ?? 'owner-companies'}
    >
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-companies-error" />
      ) : null}

      {!props.loading && props.error === null && rows.length === 0 ? (
        <EmptyState message="No accounts yet." testID="owner-companies-empty" />
      ) : desk ? (
        <>
          <View style={styles.totalsBar} testID="owner-companies-running-total">
            <Text style={styles.totalsLabel}>Outstanding dues</Text>
            <Text style={styles.totalsValue}>{`₹${formatMoneyEnIN(String(totalDues))}`}</Text>
          </View>
          <Panel padded={false}>
            <DeskTable
              data={rows}
              rowKey={(r) => r.companyId}
              sort={sort}
              onSort={setSort}
              scrollTestID="owner-companies-table"
              onRowPress={(r) => props.onOpenCompany(r.companyId)}
              maxHeight={640}
              columns={[
                {
                  key: 'name',
                  label: 'Company',
                  width: null,
                  render: (r) => (
                    <Text numberOfLines={1} style={styles.cell} testID={`company-name-${r.companyId}`}>
                      {r.name}
                    </Text>
                  ),
                  sortValue: (r) => r.name,
                },
                {
                  key: 'balance',
                  label: 'Balance',
                  width: 130,
                  align: 'right',
                  render: (r) => {
                    const view = r.balance === null ? null : creditView(r.balance);
                    if (view === null) return null;
                    return (
                      <Text numberOfLines={1} style={[styles.monoCell, { color: view.color }]} testID={`company-balance-${r.companyId}`}>
                        {view.text}
                      </Text>
                    );
                  },
                  sortValue: (r) => (r.balance === null ? Number.NEGATIVE_INFINITY : Number(r.balance)),
                },
                repColumn,
                reassignColumn,
              ]}
            />
          </Panel>
        </>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          <View style={styles.totalsBar} testID="owner-companies-running-total">
            <Text style={styles.totalsLabel}>Outstanding dues</Text>
            <Text style={styles.totalsValue}>{`₹${formatMoneyEnIN(String(totalDues))}`}</Text>
          </View>
          {rows.map((row) => {
            const balance = row.balance === null ? null : creditView(row.balance);
            return (
              <View key={row.companyId} style={styles.card} testID={`company-row-${row.companyId}`}>
                <View style={styles.cardMain}>
                  <Text style={styles.name} testID={`company-name-${row.companyId}`}>
                    {row.name}
                  </Text>
                  <Text style={styles.secondary} testID={`company-rep-${row.companyId}`}>
                    {row.shared ? 'House account' : (row.ownerRepName ?? '—')}
                  </Text>
                </View>
                <View style={styles.cardSide}>
                  {balance !== null ? (
                    <Text style={[styles.monoCell, { color: balance.color }]} testID={`company-balance-${row.companyId}`}>
                      {balance.text}
                    </Text>
                  ) : null}
                  <Button
                    label="Reassign"
                    variant="ghost"
                    onPress={() => openReassign(row)}
                    testID={`company-reassign-${row.companyId}`}
                  />
                </View>
              </View>
            );
          })}
        </ScrollView>
      )}

      <ReassignSheet
        visible={reassignTarget !== null}
        companyName={reassignTarget === null ? '' : reassignTarget.name}
        currentName={reassignTarget === null ? null : reassignTarget.shared ? null : (reassignTarget.ownerRepName ?? null)}
        options={[HOUSE_OPTION, ...props.reps]}
        busy={props.reassignBusy}
        error={props.reassignError}
        onConfirm={(ownerRepId) => {
          if (reassignTarget !== null) props.onReassign(reassignTarget.companyId, ownerRepId);
        }}
        onDismiss={() => setReassignTarget(null)}
        testID="owner-reassign-sheet"
      />
    </DeskListShell>
  );
}

const styles = StyleSheet.create({
  root: { flex: 1 },
  content: {
    padding: SPACE[4],
    paddingBottom: SPACE[8],
    gap: SPACE[2],
  },
  totalsBar: {
    flexDirection: 'row',
    alignItems: 'center',
    justifyContent: 'space-between',
    paddingVertical: SPACE[2],
    paddingHorizontal: SPACE[3],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
  },
  totalsLabel: {
    ...textStyle('label'),
    color: SEMANTIC.text.secondary,
  },
  totalsValue: {
    ...textStyle('mono'),
    color: SEMANTIC.text.primary,
    fontVariant: ['tabular-nums'],
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
  cardSide: { alignItems: 'flex-end', gap: SPACE[1] },
  name: {
    ...textStyle('bodyStrong'),
    color: SEMANTIC.text.primary,
  },
  cell: {
    ...textStyle('body', 'desk'),
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
