/**
 * O7 Employees — the list (UI/plan-2/07-OWNER.md §O7). name · role ·
 * active · tracking health · last login — phone rows and desktop table
 * alike, sorted by health severity (the person with a problem is at the
 * top), then name. *New employee* opens the create form.
 *
 * Pure UI over injected data; `useOwnerData` owns the reads.
 */
import { useState } from 'react';
import { Pressable, ScrollView, StyleSheet, Text, View } from 'react-native';

import { SEMANTIC, SPACE } from '@servgrid/shared';
import { Banner, Button, DeskListShell, EmptyState, Panel, useDensity } from '../../components/ui';
import { formatDateEnIN } from '../../components/ui';
import { textStyle } from '../../fonts/textStyle';
import { DeskTable } from './deskTable';
import type { SortState } from './deskTable';
import { healthLabel, sortEmployeeRows, type EmployeeListRow } from './model';

export interface OwnerEmployeesScreenProps {
  rows: EmployeeListRow[];
  error: string | null;
  loading: boolean;
  onOpenEmployee: (employeeId: string) => void;
  onNewEmployee: () => void;
  onRetry: () => void;
  testID?: string;
}

/** The health cell's colour — severity words, not a second chip design. */
export function healthColor(health: EmployeeListRow['health']): string {
  switch (health) {
    case 'active':
      return SEMANTIC.feedback.success;
    case 'stale':
      return SEMANTIC.feedback.warning;
    case 'permission_missing':
    case 'never_reported':
    case 'not_tracked':
      return SEMANTIC.feedback.danger;
    default:
      return SEMANTIC.text.secondary;
  }
}

export function OwnerEmployeesScreen(props: OwnerEmployeesScreenProps): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'fullName', dir: 'asc' });
  const density = useDensity();
  const desk = density === 'desk';
  const rows = sortEmployeeRows(props.rows);
  const nowYear = new Date().getFullYear();

  return (
    <DeskListShell title="Employees" subtitle={desk ? `${rows.length} ${rows.length === 1 ? 'person' : 'people'} on the roster` : undefined} testID={props.testID ?? 'owner-employees'}>
      {props.error !== null ? (
        <Banner tone="danger" message={props.error} onDismiss={props.onRetry} testID="owner-employees-error" />
      ) : null}

      {!props.loading && props.error === null && rows.length === 0 ? (
        <EmptyState message="No employees yet." testID="owner-employees-empty" />
      ) : desk ? (
        <Panel padded={false} grow>
          <DeskTable
          data={rows}
          rowKey={(r) => r.id}
          sort={sort}
          onSort={setSort}
          scrollTestID="owner-employees-table"
          onRowPress={(r) => props.onOpenEmployee(r.id)}
          columns={[
            {
              key: 'fullName',
              label: 'Name',
              width: null,
              render: (r) => (
                <View>
                  <Text style={styles.cellStrong} testID={`employee-name-${r.id}`}>
                    {r.fullName}
                  </Text>
                  <Text style={styles.secondary}>{r.username}</Text>
                </View>
              ),
              sortValue: (r) => r.fullName,
            },
            {
              key: 'role',
              label: 'Role',
              width: 110,
              render: (r) => <Text style={styles.cell}>{r.role}</Text>,
              sortValue: (r) => r.role,
            },
            {
              key: 'isActive',
              label: 'Active',
              width: 76,
              render: (r) => (
                <Text style={[styles.cell, { color: r.isActive ? SEMANTIC.text.primary : SEMANTIC.feedback.danger }]} testID={`employee-active-${r.id}`}>
                  {r.isActive ? 'Yes' : 'No'}
                </Text>
              ),
              sortValue: (r) => (r.isActive ? 1 : 0),
            },
            {
              key: 'health',
              label: 'Tracking health',
              width: 130,
              render: (r) => (
                <Text style={[styles.cell, { color: healthColor(r.health) }]} testID={`employee-health-${r.id}`}>
                  {healthLabel(r.health)}
                </Text>
              ),
              sortValue: (r) => (r.health === null ? '' : healthLabel(r.health)),
            },
            {
              key: 'lastLoginAt',
              label: 'Last login',
              width: 120,
              render: (r) => (
                <Text style={styles.monoCell} testID={`employee-last-login-${r.id}`}>
                  {r.lastLoginAt === null ? 'Never' : formatDateEnIN(r.lastLoginAt.slice(0, 10), nowYear)}
                </Text>
              ),
              sortValue: (r) => r.lastLoginAt ?? '',
            },
          ]}
        />
        </Panel>
      ) : (
        <ScrollView contentContainerStyle={styles.content}>
          {rows.map((row) => (
            <Pressable
              key={row.id}
              accessibilityRole="button"
              onPress={() => props.onOpenEmployee(row.id)}
              style={styles.row}
              testID={`employee-row-${row.id}`}
            >
              <View style={styles.rowMain}>
                <Text style={styles.cellStrong} testID={`employee-name-${row.id}`}>
                  {row.fullName}
                </Text>
                <Text style={styles.secondary}>
                  {`${row.role} · ${row.isActive ? 'Active' : 'Deactivated'} · last login ${
                    row.lastLoginAt === null ? 'never' : formatDateEnIN(row.lastLoginAt.slice(0, 10), nowYear)
                  }`}
                </Text>
              </View>
              <Text style={[styles.health, { color: healthColor(row.health) }]} testID={`employee-health-${row.id}`}>
                {healthLabel(row.health)}
              </Text>
            </Pressable>
          ))}
        </ScrollView>
      )}

      <View style={styles.actionBar}>
        <Button label="+ New employee" onPress={props.onNewEmployee} testID="employees-new" />
      </View>
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
  actionBar: {
    position: 'absolute',
    left: 0,
    right: 0,
    bottom: 0,
    padding: SPACE[4],
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
  health: {
    ...textStyle('label'),
  },
});
