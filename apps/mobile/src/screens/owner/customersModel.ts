/**
 * The owner customers screens' pure model (T4.11, UI/plan-2/07-OWNER.md
 * §O4b). No react-native, no api, no hooks — the screens' tests assert
 * these rules directly.
 *
 * §O4b is the dispatcher's §D4 with the scope opened up, and the model
 * says so structurally: the row reuses the dispatcher's stack/history
 * labelling, and the three differences (company present, stack
 * editable, desk as a table) are the owner's additions on top.
 */
import type { JobStatus } from '@servgrid/shared';

/** One row of the owner's customers table — §O4b's columns verbatim. */
export interface OwnerCustomerRow {
  id: string;
  name: string;
  /** `addressLine1`, or the city when the line is missing. */
  area: string | null;
  phone: string;
  companyId: string | null;
  companyName: string | null;
  /** Active units at the site; null while the stack read is in flight. */
  units: number | null;
  /** Open jobs (not completed, not cancelled). */
  openJobs: number;
  /** The newest job's number, short form, or null when none. */
  lastJob: string | null;
}

/** Name ascending — a scanning table reads alphabetically. */
export function sortOwnerCustomers(rows: readonly OwnerCustomerRow[]): OwnerCustomerRow[] {
  return [...rows].sort((a, b) => a.name.localeCompare(b.name));
}

/** The units cell — an unknown count renders as `…`, not as a fake 0. */
export function unitsLabelOf(units: number | null): string {
  return units === null ? '…' : String(units);
}

/** Short job number — `JC-2627-0042` → `JC-…0042` (the D2 convention). */
export function shortCustomerJobNumber(jobNumber: string): string {
  if (jobNumber.length <= 8) return jobNumber;
  return `${jobNumber.slice(0, 3)}…${jobNumber.slice(-4)}`;
}

/** The last-job cell's label: number · short date. */
export function lastJobLabelOf(jobNumber: string, scheduledFor: string | null, nowYear: number): string {
  const months = ['Jan', 'Feb', 'Mar', 'Apr', 'May', 'Jun', 'Jul', 'Aug', 'Sep', 'Oct', 'Nov', 'Dec'];
  const date =
    scheduledFor === null
      ? null
      : (() => {
          const [y = '', m = '', d = ''] = scheduledFor.slice(0, 10).split('-');
          return `${Number(d)} ${months[Number(m) - 1] ?? m}${Number(y) === nowYear ? '' : ` ${y}`}`;
        })();
  return date === null ? shortCustomerJobNumber(jobNumber) : `${shortCustomerJobNumber(jobNumber)} · ${date}`;
}

/** Open = not completed and not cancelled (the same definition D1 counts). */
export function isOpenStatus(status: JobStatus): boolean {
  return status !== 'completed' && status !== 'cancelled';
}
