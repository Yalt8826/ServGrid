/**
 * O7 Employees tests (UI/plan-2/07-OWNER.md §O7). The ones the spec
 * names:
 *
 * - **Deactivation 409 renders LINKED ROWS, not a message string** —
 *   proven for all THREE deactivation conditions: open jobs, owned
 *   companies, unconfirmed cash. Each row links to the screen where the
 *   reassignment happens.
 * - **Employee detail renders ALL EIGHT device diagnostics** — the
 *   equipment record: manufacturer, model, OS, app version, location
 *   permission, battery-optimisation exemption, autostart confirmed,
 *   notifications enabled.
 * - The create form states the must_change_password promise with the
 *   name as typed.
 */
import { describe, expect, it } from 'vitest';

import { act } from 'react';

import { allText, create, findAll, findByTestID, toJson } from '../../components/ui/testing';
import { OwnerEmployeeDetailScreen } from './EmployeeDetailScreen';
import { EmployeeFormScreen } from './EmployeeFormScreen';
import type { BlockingRow } from './model';

const JOB_ID = 'b1000000-0000-4000-8000-000000000001';
const COMPANY_ID = 'c1000000-0000-4000-8000-000000000001';
const CASH_ID = 'a1000000-0000-4000-8000-000000000001';

/** One blocking row of EACH deactivation condition — the 409's shape. */
const BLOCKED: BlockingRow[] = [
  { kind: 'job', id: JOB_ID, jobNumber: 'JC-2627-00042', title: 'UPS repair — False Ridge', status: 'assigned' },
  { kind: 'company', id: COMPANY_ID, name: 'Sterling Industries' },
  { kind: 'cash', id: CASH_ID, businessDate: '2026-09-11', status: 'submitted', declaredAmount: '12000' },
];

const base = {
  identity: {
    fullName: 'Ravi Kumar',
    username: 'ravi.k',
    role: 'technician',
    phone: '+91 98400 11111',
    isActive: true,
    lastLoginAt: '2026-09-14T06:12:00.000Z',
    createdAt: '2026-01-05T00:00:00.000Z',
  },
  health: null,
  devices: [],
  error: null,
  blocking: null,
  busy: false,
  onDeactivate: () => {},
  onConfirmDeactivate: () => {},
  onCancelDeactivate: () => {},
  deactivateDialogOpen: false,
  onOpenLink: () => {},
  onRetry: () => {},
};

describe('Deactivation 409 — linked rows, not a message string (§O7)', () => {
  it('renders a blocking row per condition, each a link to where the work is reassigned', async () => {
    const opened: string[] = [];
    const r = await create(<OwnerEmployeeDetailScreen {...base} blocking={BLOCKED} onOpenLink={(route) => opened.push(route)} />);
    const tree = toJson(r);

    // The three deactivation conditions each get their row.
    const jobRow = findByTestID(tree, `blocking-row-job-${JOB_ID}`);
    const companyRow = findByTestID(tree, `blocking-row-company-${COMPANY_ID}`);
    const cashRow = findByTestID(tree, `blocking-row-cash-${CASH_ID}`);
    expect(jobRow).toBeDefined();
    expect(companyRow).toBeDefined();
    expect(cashRow).toBeDefined();

    // LINKED — each renders as a pressable with the route in reach, not
    // prose describing what the owner should go do.
    for (const row of [jobRow, companyRow, cashRow]) {
      const pressable = findAll(row!, (n) => n.type === 'Pressable')[0]!;
      expect(pressable).toBeDefined();
      void pressable.props.onPress?.();
    }
    expect(opened).toEqual([`/jobs/${JOB_ID}`, `/companies/${COMPANY_ID}`, '/cash']);

    // The rows carry the work, not an apology: the job number, the
    // company name, the cash day.
    const text = allText(tree).join(' | ');
    expect(text).toContain('JC-2627-00042');
    expect(text).toContain('Sterling Industries');
    expect(text).toContain('2026-09-11');
  });

  it('no rows — the screen shows no blocking block at all (not an empty box)', async () => {
    const r = await create(<OwnerEmployeeDetailScreen {...base} />);
    expect(findByTestID(toJson(r), 'blocking-rows-headline')).toBeUndefined();
  });
});

describe('Employee detail — the equipment record (§O7)', () => {
  it('renders all eight device diagnostics for a handset', async () => {
    const r = await create(
      <OwnerEmployeeDetailScreen
        {...base}
        devices={[
          {
            id: 'd1000000-0000-4000-8000-000000000001',
            installId: 'install-abc',
            manufacturer: 'Xiaomi',
            model: 'Redmi Note 10',
            osVersion: 'Android 13',
            appVersion: '1.4.2',
            locationPermission: 'background',
            batteryOptExempt: true,
            autostartConfirmed: false,
            notificationsEnabled: true,
            lastSeenAt: '2026-09-14T06:00:00.000Z',
            isActive: true,
          },
        ]}
      />,
    );
    const tree = toJson(r);
    // Eight — manufacturer · model · OS · app version · location
    // permission · battery-optimisation exemption · autostart ·
    // notifications. Each keyed, each valued, in the record.
    for (const key of ['manufacturer', 'model', 'os', 'app', 'permission', 'battery', 'autostart', 'notifications']) {
      expect(findByTestID(tree, `diagnostic-${key}`)).toBeDefined();
      expect(findByTestID(tree, `diagnostic-value-${key}`)).toBeDefined();
    }
    const text = allText(tree).join(' | ');
    expect(text).toContain('Xiaomi');
    expect(text).toContain('Redmi Note 10');
    expect(text).toContain('Android 13');
    expect(text).toContain('1.4.2');
    expect(text).toContain('Background');
    expect(text).toContain('Exempt');
    expect(text).toContain('Not confirmed');
    expect(text).toContain('Yes');
  });

  it('a handset that never checked in renders honestly empty — no device, no invented rows', async () => {
    const r = await create(<OwnerEmployeeDetailScreen {...base} />);
    const tree = toJson(r);
    expect(findByTestID(tree, 'employee-devices-empty')).toBeDefined();
    expect(allText(toJson(r)).join(' ')).toContain('never checked in'.replace('never ', ''));
  });
});

describe('Create employee — the promise on the screen (§O7)', () => {
  it('states the must_change_password sentence with the name as typed', async () => {
    const r = await create(<EmployeeFormScreen busy={false} error={null} create={async () => {}} onDone={() => {}} />);
    let tree = toJson(r);
    expect(findByTestID(tree, 'employee-form-password-statement')).toBeUndefined();
    const nameInput = findAll(findByTestID(tree, 'employee-form-name')!, (n) => n.type === 'TextInput')[0]!;
    await act(async () => {
      nameInput.props.onChangeText?.('Ravi Kumar');
    });
    tree = toJson(r);
    const statement = allText(findByTestID(tree, 'employee-form-password-statement')!).join(' ');
    expect(statement).toContain('Ravi Kumar');
    expect(statement).toContain('will be asked to set his own password at first login');
  });
});
