/**
 * DeskTable — the WEB side of the seam. On web Metro resolves this file
 * for `./deskTable`, and it is a thin re-presentation of the T4.7
 * `DataTable` (FlashList, sticky header, memoised rows): the owner's
 * desktop tables ARE that component, by construction — a screen task
 * cannot grow a second table implementation (07-OWNER.md §O4's rule,
 * ORCHESTRATION.md's conflict policy: the DataTable API is T4.7's).
 *
 * The native counterpart (deskTable.tsx) carries the same contract, so
 * a screen file imports `./deskTable` and stays platform-plain.
 */
export { DataTable as DeskTable } from '../../components/domain/DataTable.web';
export type { DataTableProps as DeskTableProps, DataTableColumn as DeskTableColumn, SortState } from '../../components/domain/DataTable.web';
