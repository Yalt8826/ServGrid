/**
 * O8 Services — settings, not work (UI/plan-2/07-OWNER.md §O8). A simple
 * table: code · name · description · default charge · active — same
 * deactivation rule as products.
 *
 * Pure UI over injected data; the route owns the PATCH.
 */
import { useState } from 'react';
import { ScrollView, StyleSheet, Text, View } from 'react-native';

import { formatMoneyEnIN, SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, DeskListShell, EmptyState, Panel, useDensity } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { DeskTable } from './deskTable';
import type { SortState } from './deskTable';
import type { OwnerServiceRow } from './model';

export interface OwnerServicesScreenProps {
  rows: OwnerServiceRow[];
  error: string | null;
  loading: boolean;
  onDeactivate: (serviceId: string) => void;
  deactivateBusyId: string | null;
  onRetry: () => void;
  testID?: string;
}

export function OwnerServicesScreen(props: OwnerServicesScreenProps): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'name', dir: 'asc' });
  const density = useDensity();
  const desk = density === 'desk';
  const rows = props.rows;

  return (
    <DeskListShell title="Services" subtitle={desk ? `${rows.length} job types` : undefined} testID={props.testID ?? 'owner-services'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-services-error" />
      ) : null}

      {!props.loading && props.error === null && rows.length === 0 ? (
        <EmptyState message="No services in the catalogue yet." testID="owner-services-empty" />
      ) : desk ? (
        <Panel padded={false} grow>
          <DeskTable
          data={rows}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={setSort}
          scrollTestID="owner-services-table"
          columns={[
            {
              key: 'code',
              label: 'Code',
              width: 110,
              render: (r) => (
                <Text style={styles.monoCell} testID={`service-code-${r.id}`}>
                  {r.code}
                </Text>
              ),
              sortValue: (r) => r.code,
            },
            {
              key: 'name',
              label: 'Name',
              width: null,
              render: (r) => <Text style={styles.cell}>{r.name}</Text>,
              sortValue: (r) => r.name,
            },
            {
              key: 'description',
              label: 'Description',
              width: 240,
              render: (r) => <Text style={styles.secondary}>{r.description ?? '—'}</Text>,
              sortValue: (r) => r.description ?? '',
            },
            {
              key: 'defaultCharge',
              label: 'Default charge',
              width: 120,
              align: 'right',
              render: (r) => <Text style={styles.monoCell}>{r.defaultCharge === null ? '—' : `₹${formatMoneyEnIN(r.defaultCharge)}`}</Text>,
              sortValue: (r) => (r.defaultCharge === null ? -1 : Number(r.defaultCharge)),
            },
            {
              key: 'isActive',
              label: 'Active',
              width: 70,
              render: (r) => (
                <Text style={[styles.cell, { color: r.isActive ? SEMANTIC.text.primary : SEMANTIC.text.secondary }]} testID={`service-active-${r.id}`}>
                  {r.isActive ? 'Yes' : 'No'}
                </Text>
              ),
              sortValue: (r) => (r.isActive ? 1 : 0),
            },
            {
              key: 'actions',
              label: '',
              width: 110,
              render: (r) =>
                r.isActive ? (
                  <Button
                    label="Deactivate"
                    variant="ghost"
                    disabled={props.deactivateBusyId === r.id}
                    onPress={() => props.onDeactivate(r.id)}
                    testID={`service-deactivate-${r.id}`}
                  />
                ) : null,
            },
          ]}
        />
        </Panel>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {rows.map((row) => (
            <View key={row.id} style={styles.row} testID={`service-row-${row.id}`}>
              <View style={styles.rowMain}>
                <Text style={styles.cellStrong} testID={`service-code-${row.id}`}>
                  {row.code}
                </Text>
                <Text style={styles.cell}>{row.name}</Text>
                <Text style={styles.secondary}>
                  {row.defaultCharge === null ? 'No default charge' : `₹${formatMoneyEnIN(row.defaultCharge)}`}
                </Text>
              </View>
              {row.isActive ? (
                <Button
                  label="Deactivate"
                  variant="ghost"
                  disabled={props.deactivateBusyId === row.id}
                  onPress={() => props.onDeactivate(row.id)}
                  testID={`service-deactivate-${row.id}`}
                />
              ) : (
                <Text style={styles.inactive} testID={`service-active-${row.id}`}>
                  Deactivated
                </Text>
              )}
            </View>
          ))}
        </ScrollView>
      )}
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
  row: {
    flexDirection: 'row',
    alignItems: 'center',
    minHeight: 56,
    paddingVertical: SPACE[2],
    borderBottomWidth: 1,
    borderBottomColor: SEMANTIC.line.default,
    gap: SPACE[3],
  },
  rowMain: { flex: 1, gap: 2 },
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
  inactive: {
    ...textStyle('caption'),
    color: SEMANTIC.text.secondary,
  },
});
