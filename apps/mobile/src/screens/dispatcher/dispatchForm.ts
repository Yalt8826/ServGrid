/**
 * Pure helpers for the D3 Dispatch Job form (T2.9, UI/plan-2/05-DISPATCHER.md
 * §D3) — the seam the screen renders over and the tests assert against,
 * with no react-native import (the same split T2.8's `jobLogsFilters.ts`
 * uses): sort, labels, the toast sentence, the schedule compose and the
 * submit-time validation.
 *
 * The two rules the spec states hardest live here so they cannot drift
 * in the JSX:
 *
 * - **The picker sorts by load ascending, never alphabetically** — the
 *   answer is at the top, and a stable sort keeps equal loads in roster
 *   order (the order the server answered, never a name re-sort).
 * - ***Leave unassigned* is an explicit choice, never the silent
 *   default** — validation refuses a submit where the dispatcher never
 *   chose: neither a technician nor the explicit unassigned option.
 */

/** One customer the search answered — the two-line row's content. */
export interface DispatchCustomerOption {
  id: string;
  name: string;
  phone: string;
  /** `addressLine1`, or the city when the line is missing — one line. */
  addressLabel: string | null;
}

/** One unit of the selected site's stack — `UPS 850VA · SN LM8842219`. */
export interface DispatchUnitOption {
  id: string;
  label: string;
}

/** One job-type catalogue row (`GET /v1/services`, read: all, §6.4). */
export interface DispatchServiceOption {
  id: string;
  name: string;
}

/** One roster row for `TechnicianPicker` — the load comparison only
 * (owner, 2026-09-17: no tracking state reaches the dispatcher). */
export interface DispatchTechnician {
  employeeId: string;
  name: string;
  openTotal: number;
}

export type DispatchPriority = 'low' | 'normal' | 'high' | 'urgent';

/** Priority as four segments, not a dropdown (§D3) — display order. */
export const PRIORITY_SEGMENTS: readonly { value: DispatchPriority; label: string }[] = [
  { value: 'low', label: 'Low' },
  { value: 'normal', label: 'Normal' },
  { value: 'high', label: 'High' },
  { value: 'urgent', label: 'Urgent' },
];

/**
 * Why Urgent is worth a segment of its own: it is the only value that
 * overrides notification work-window suppression (§D3, PLAN-BACKEND.md
 * §6.3). The dispatcher sees the choice they are making, in words.
 */
export const URGENT_SUPPRESSION_NOTE = 'Urgent notifies the technician even outside the work window.';

/**
 * The picker's order IS the answer: load ascending, **stable** — equal
 * loads keep the roster's order. Never a name sort: the alphabet is not
 * a decision about who is free.
 */
export function sortTechniciansByLoad(technicians: readonly DispatchTechnician[]): DispatchTechnician[] {
  return technicians
    .map((technician, index) => ({ technician, index }))
    .sort((a, b) => a.technician.openTotal - b.technician.openTotal || a.index - b.index)
    .map((entry) => entry.technician);
}

/** `Ravi Kumar` → `Ravi` — the toast reads the name down the phone. */
export function firstNameOf(technicianName: string): string {
  return technicianName.split(' ')[0] ?? technicianName;
}

/**
 * The submit sentence (§D3 motion): *"JC-2627-0044 assigned to Ravi"* —
 * the number first, because the dispatcher may need to read it back
 * before the sentence ends. Unassigned is its own honest sentence; it
 * never pretends a technician was chosen.
 */
export function formatSubmitToast(jobNumber: string, technicianName: string | null): string {
  if (technicianName === null) return `${jobNumber} raised, unassigned`;
  return `${jobNumber} assigned to ${firstNameOf(technicianName)}`;
}

/**
 * `UPS 850VA · SN LM8842219` — the catalogue name when the unit has one,
 * the technician's free text when he fitted something off-catalogue,
 * `Unit` when neither. The serial is what actually discriminates a site
 * with five UPS units (PLAN-DATA-MODEL.md §3.4).
 */
export function unitLabelOf(unit: { productName?: string | null; freeTextName?: string | null; serialNumber: string }): string {
  const name = unit.productName ?? unit.freeTextName ?? 'Unit';
  return `${name} · SN ${unit.serialNumber}`;
}

/** Half-hour slots across the working day (09:00–19:00 IST, §8). */
export const TIME_SLOTS: readonly string[] = [
  '09:00', '09:30', '10:00', '10:30', '11:00', '11:30', '12:00', '12:30',
  '13:00', '13:30', '14:00', '14:30', '15:00', '15:30', '16:00', '16:30',
  '17:00', '17:30', '18:00', '18:30',
];

/**
 * `2026-09-13` + `14:30` → an IST instant — the card's `scheduled_for`
 * carries the offset so the server's `business_date` lands on the day
 * the dispatcher promised, never on the device's UTC day.
 */
export function scheduledForOf(dateIso: string, time: string): string {
  return `${dateIso}T${time}:00+05:30`;
}

/** The fields one submit carries — `technicianId: null` is the EXPLICIT
 * leave-unassigned choice, never an unnoticed default. */
export interface DispatchJobFields {
  unitId: string | null;
  serviceId: string | null;
  priority: DispatchPriority;
  /** `YYYY-MM-DD`, or null when the dispatcher did not set a day. */
  scheduledDate: string | null;
  /** Composed IST instant, or null without a time slot. */
  scheduledFor: string | null;
  contactName: string;
  contactPhone: string;
  notes: string;
  technicianId: string | null;
}

/** Which field the submit refused, worded for the dispatcher mid-call. */
export interface DispatchFormProblems {
  customer?: string;
  service?: string;
  assignment?: string;
}

/**
 * Submit-time validation (03-COMPONENTS.md: no inline validation while
 * typing — validate on submit). A customer and a service are the two
 * things the server cannot raise a card without; the assignment is the
 * one thing this form will not decide silently.
 */
export function validateDispatchForm(input: {
  hasCustomer: boolean;
  serviceId: string | null;
  technicianId: string | null;
  unassignedChosen: boolean;
}): DispatchFormProblems {
  const problems: DispatchFormProblems = {};
  if (!input.hasCustomer) problems.customer = 'Who is the job for? Pick a customer first.';
  if (input.serviceId === null) problems.service = 'What is the work? Pick a service.';
  if (!input.unassignedChosen && input.technicianId === null) {
    problems.assignment = 'Choose who to send — or leave it unassigned, explicitly.';
  }
  return problems;
}
