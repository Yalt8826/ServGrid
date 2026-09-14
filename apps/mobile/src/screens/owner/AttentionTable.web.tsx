/**
 * The desk attention table (T4.8, UI/plan-2/07-OWNER.md §O1: "Needs
 * attention as a table to the right") — the T4.7 DataTable's first
 * consumer, and the card-vs-row rule at work: the phone reads this feed
 * as rows; the owner's laptop reads it as sortable table rows with the
 * severity on the 4px leading edge, the same rail the phone row wears.
 *
 * The default sort state names no column, which is how DataTable says
 * "in data order": consequence order is the ENDPOINT's contract (T4.6 —
 * missing submissions, variances, overdue jobs, tracking health), so no
 * client sort may silently reorder it until the owner asks. From then
 * the columns sort: What, Detail, Flag.
 */
import { useState } from 'react';
import { Text } from 'react-native';

import { SEMANTIC } from '@servgrid/shared';
// The explicit .web specifier: tsc has no Metro platform resolution, and
// the DataTable suite already proves this module web-only by construction.
import { DataTable, type DataTableColumn, type SortState } from '../../components/domain/DataTable.web';
import { textStyle } from '../../fonts/textStyle';
import type { AttentionRowVm } from './model';

/** Matches no column key — DataTable's "leave the data's order alone". */
const CONSEQUENCE_ORDER: SortState = { key: 'consequence', dir: 'asc' };

export function AttentionTable({
  rows,
  onOpen,
}: {
  rows: AttentionRowVm[];
  onOpen: (target: string) => void;
}): React.ReactNode {
  const [sort, setSort] = useState<SortState>(CONSEQUENCE_ORDER);

  const columns: DataTableColumn<AttentionRowVm>[] = [
    {
      key: 'what',
      label: 'What',
      width: null, // the one flexing column
      sortValue: (row) => row.title,
      render: (row) => (
        <Text numberOfLines={1} style={[textStyle('bodyStrong', 'desk'), { color: SEMANTIC.text.primary }]}>
          {row.title}
        </Text>
      ),
    },
    {
      key: 'detail',
      label: 'Detail',
      width: 280,
      sortValue: (row) => row.meta,
      render: (row) => (
        <Text numberOfLines={1} style={[textStyle('body', 'desk'), { color: SEMANTIC.text.secondary }]}>
          {row.meta}
        </Text>
      ),
    },
    {
      key: 'flag',
      label: 'Flag',
      width: 150,
      align: 'right',
      sortValue: (row) => row.note,
      render: (row) => (
        <Text
          numberOfLines={1}
          style={[
            textStyle('body', 'desk'),
            { color: row.severity === 'danger' ? SEMANTIC.feedback.danger : SEMANTIC.feedback.warning },
          ]}
        >
          {row.note}
        </Text>
      ),
    },
  ];

  return (
    <DataTable
      data={rows}
      columns={columns}
      rowKey={(row) => row.key}
      sort={sort}
      onSort={setSort}
      edgeColor={(row) => (row.severity === 'danger' ? SEMANTIC.feedback.danger : SEMANTIC.feedback.warning)}
      onRowPress={(row) => onOpen(row.target)}
      scrollTestID="owner-attention-table"
    />
  );
}
