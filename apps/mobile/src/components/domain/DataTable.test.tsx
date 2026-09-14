/**
 * DataTable tests (T4.7, UI/plan-2/07-OWNER.md §O4). The seam renders
 * every row through the FlashList test stub, so the REAL component logic
 * — controlled sort, memoised rows, the leading status rail, zebra
 * stripes — is exercised at the spec's volume (500 rows).
 *
 * Two claims need the T4.1 spike's recorded context
 * (`spikes/rnw-desktop/VERDICT.md` §3):
 *
 * - **"500 rows sort without a full re-render" is asserted on render
 *   counts.** On the device, virtualisation bounds the cost to the live
 *   window — the spike measured 40–51 of 500 rows re-rendering per sort.
 *   The stub mounts all 500, and the component's answer to that is the
 *   memoised row keyed on the row object: a sort reorders the array
 *   without mutating it, so the assertion below is that NOT ONE row body
 *   re-runs (a zebra parity flip repaints a host wrapper, outside the
 *   memo, by construction).
 * - **Order assertions here read tree order**, which under the stub is
 *   data order. The spike's transform trap — FlashList v2 positions rows
 *   with transforms, so *browser* DOM order lies — does not apply to
 *   this seam; it is recorded for any future browser-harness test.
 *
 * The sticky header's pinned-clone behaviour itself (header as item 0 on
 * `stickyHeaderIndices`) was measured in real Chrome and Firefox to the
 * very bottom of a 500-row scroll — scrollTop ≈ 19,000px, clone top ==
 * container top in 4/4 runs. This suite asserts the wiring that
 * produces it: the header is item 0 of the list data, on every sort
 * state, and is handed to FlashList as sticky.
 *
 * The last block is the APK guarantee: Metro's platform resolution must
 * find NO native counterpart for this `.web.tsx` module (PLAN-FRONTEND.md
 * §8 — "never bundled into the APK"), checked against the source
 * extensions of the app's own Metro config.
 */
import { describe, expect, it, vi, beforeEach } from 'vitest';
import { existsSync } from 'node:fs';
import { createRequire } from 'node:module';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { act, useState } from 'react';

import { DENSITY, JOB_STATUSES, SEMANTIC, STATUS, groupEnIN, type JobStatus } from '@servgrid/shared';
// The stubbed primitive, for the columns' cell renderers.
import { Text } from 'react-native';

import { findAll, findAllByTestID, findByTestID, allText, create, toJson, type Node } from '../ui/testing';
import { lastStickyHeaderIndices } from '../../test-stubs/flash-list';
import { DataTable, type DataTableColumn, type SortState } from './DataTable.web';

/* ------------------------------------------------------------------ */
/* Fixture — 500 seeded, real-shaped owner jobs (the spike's discipline) */

interface Job {
  id: number;
  jobNumber: string;
  customer: string;
  service: string;
  technician: string;
  scheduledForMs: number;
  amount: number;
  status: JobStatus;
}

/** mulberry32 — deterministic, seedable, tiny (as the spike's fixture). */
function rng(seed: number): () => number {
  let a = seed >>> 0;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

const CUSTOMERS = [
  'Meenakshi Enterprises', 'Sri Balaji Agencies', 'Nova Power Systems', 'Krishna Traders',
  'Sunrise Cold Storage', 'Banashankari Motors', 'Guardian Security', 'Lotus Textiles',
  'Deccan Hydraulics', 'Metro Facilities', 'Anand Electricals', 'Prestige Hospitality',
  'Sigma Instruments', 'Whitefield Bakery', 'Cauvery Pharmaceuticals', 'Trident Logistics',
];
const SERVICES = ['UPS maintenance', 'Battery bank swap', 'Inverter repair', 'AMC visit', 'Installation'];
const TECHS = ['Ravi Kumar', 'Suresh Naik', 'Anitha Prasad', 'Farhan Ali', 'Lakshmi Iyer', null];

function makeJobs(count: number): Job[] {
  const next = rng(20260914);
  return Array.from({ length: count }, (_, i) => {
    const tech = TECHS[Math.floor(next() * TECHS.length)] ?? null;
    return {
      id: i + 1,
      jobNumber: `JC-2627-${String(i + 1).padStart(5, '0')}`,
      customer: `${CUSTOMERS[Math.floor(next() * CUSTOMERS.length)]} #${i + 1}`,
      service: SERVICES[Math.floor(next() * SERVICES.length)] ?? SERVICES[0]!,
      technician: tech ?? 'Unassigned',
      scheduledForMs: Date.UTC(2026, 8, 1) + Math.floor(next() * 10 * 86_400_000),
      amount: Math.floor(next() * 90_000) + 500,
      status: JOB_STATUSES[Math.floor(next() * JOB_STATUSES.length)] ?? 'unassigned',
    };
  });
}

/* ------------------------------------------------------------------ */
/* Columns — the owner's job table (§O4): number · customer · service ·
 * technician · scheduled · status · amount. Cell text is desk body
 * (14px, §3.3); numbers carry tabular figures. Every callback below is
 * a stable module reference — the memoised row's bail-out depends on it. */

// Desk body: 14px on a 20px line (01-FOUNDATIONS.md §3.3).
const cell = { fontSize: 14, lineHeight: 20 };

const renderCustomer = vi.fn((job: Job): React.ReactNode => <Text style={cell}>{job.customer}</Text>);

const COLUMNS: DataTableColumn<Job>[] = [
  {
    key: 'jobNumber',
    label: 'Number',
    width: 140,
    render: (job) => <Text style={{ ...cell, fontVariant: ['tabular-nums'] }}>{job.jobNumber}</Text>,
    sortValue: (job) => job.jobNumber,
  },
  { key: 'customer', label: 'Customer', width: null, render: renderCustomer, sortValue: (job) => job.customer },
  { key: 'service', label: 'Service', width: 128, render: (job) => <Text style={cell}>{job.service}</Text> },
  { key: 'technician', label: 'Technician', width: 122, render: (job) => <Text style={cell}>{job.technician}</Text> },
  {
    key: 'scheduled',
    label: 'Scheduled',
    width: 128,
    render: (job) => <Text style={cell}>{new Date(job.scheduledForMs).toISOString().slice(0, 10)}</Text>,
    sortValue: (job) => job.scheduledForMs,
  },
  { key: 'status', label: 'Status', width: 116, render: (job) => <Text style={cell}>{job.status}</Text> },
  {
    key: 'amount',
    label: 'Amount',
    width: 100,
    align: 'right',
    render: (job) => (
      <Text style={{ ...cell, fontVariant: ['tabular-nums'] }}>{`₹${groupEnIN(String(job.amount))}`}</Text>
    ),
    sortValue: (job) => job.amount,
  },
];

const rowKey = (job: Job): string => String(job.id);

/** STATUS carries the five rail colours; `assigned` rides the muted
 * slate exactly as the JobCard renders it (no state, not a state). */
function statusColour(status: JobStatus): string {
  return (STATUS as Record<string, string>)[status] ?? STATUS.unassigned;
}

const edgeColor = (job: Job): string | null => statusColour(job.status);
const onRowPress = vi.fn();
const rowAccessibilityLabel = (job: Job): string => `${job.jobNumber} ${job.status}`;

/** Sort state lives with the consumer (the screen); the shell below is
 * the test's stand-in for it, so header presses drive real reorders.
 * `setSort` is stable, so the memoised rows' props stay shallow-equal. */
function Shell({ jobs }: { jobs: Job[] }): React.ReactNode {
  const [sort, setSort] = useState<SortState>({ key: 'jobNumber', dir: 'asc' });
  return (
    <DataTable
      data={jobs}
      columns={COLUMNS}
      rowKey={rowKey}
      sort={sort}
      onSort={setSort}
      edgeColor={edgeColor}
      onRowPress={onRowPress}
      rowAccessibilityLabel={rowAccessibilityLabel}
      scrollTestID="data-table-scroll"
    />
  );
}

type Renderer = Awaited<ReturnType<typeof create>>;

async function mountShell(jobs: Job[]): Promise<Renderer> {
  let renderer!: Renderer;
  await act(async () => {
    renderer = await create(<Shell jobs={jobs} />);
  });
  return renderer;
}

async function press(renderer: Renderer, testID: string): Promise<void> {
  const node = findByTestID(toJson(renderer), testID);
  expect(node, testID).toBeTruthy();
  const onPress = node?.props.onPress as () => void;
  await act(async () => {
    onPress();
  });
}

function rowNodes(renderer: Renderer): Node[] {
  return findAll(toJson(renderer), (n) => typeof n.props.testID === 'string' && n.props.testID.startsWith('data-row-'));
}

function rowTestIdOf(job: Job): string {
  return `data-row-${job.id}`;
}

function flatten(style: unknown): Record<string, unknown> {
  const arr = (Array.isArray(style) ? style : [style]) as (Record<string, unknown> | null)[];
  return Object.assign({}, ...arr.filter((s): s is Record<string, unknown> => s !== null && s !== undefined));
}

beforeEach(() => {
  vi.clearAllMocks();
});

describe('DataTable — 500 rows sort without a full re-render', () => {
  it('mounts all 500 rows, each row body exactly once (render counts)', async () => {
    await mountShell(makeJobs(500));
    expect(renderCustomer).toHaveBeenCalledTimes(500);
  });

  it('a sort re-renders zero row bodies; order follows the sort key', async () => {
    const jobs = makeJobs(500);
    const renderer = await mountShell(jobs);
    expect(rowNodes(renderer)).toHaveLength(500);
    expect(renderCustomer).toHaveBeenCalledTimes(500);

    await press(renderer, 'header-sort-customer');
    // +0 — the memo held every row: a reorder mutates no row object.
    // (On the device the virtualised window re-renders 40–51 of 500;
    // the stub mounts all 500 and the memo still holds them all.)
    expect(renderCustomer).toHaveBeenCalledTimes(500);

    const expectedFirst = jobs.slice().sort((a, b) => a.customer.localeCompare(b.customer))[0]!;
    expect(findByTestID(toJson(renderer), rowTestIdOf(expectedFirst))).toBeTruthy();
    // Tree order is data order under the seam (see file comment): the
    // first ROW wrapper sits at children[1] — item 0 is the sticky
    // header — and it is the alphabetically first customer.
    const list = findByTestID(toJson(renderer), 'data-table-scroll');
    const firstRowWrapper = list?.children?.[1];
    const firstRow = firstRowWrapper !== undefined && typeof firstRowWrapper !== 'string' ? findByTestID(firstRowWrapper, rowTestIdOf(expectedFirst)) : undefined;
    expect(firstRow).toBeTruthy();

    await press(renderer, 'header-sort-customer'); // toggle to desc
    expect(renderCustomer).toHaveBeenCalledTimes(500); // still zero row bodies
    const ids = rowNodes(renderer).map((n) => n.props.testID);
    expect(ids[0]).not.toBe(rowTestIdOf(expectedFirst));
  });
});

describe('DataTable — sticky header over the virtualised rows', () => {
  it('the header is item 0, handed to FlashList as sticky, and stays there through sorts', async () => {
    const renderer = await mountShell(makeJobs(500));
    // The wiring the spike measured in real browsers: header as item 0
    // on FlashList's own sticky machinery.
    expect(lastStickyHeaderIndices()).toEqual([0]);

    const list = findByTestID(toJson(renderer), 'data-table-scroll');
    expect(list).toBeTruthy();
    const firstItem = list?.children?.[0];
    const header = firstItem && typeof firstItem !== 'string' ? findByTestID(firstItem, 'table-header') : undefined;
    expect(header).toBeTruthy();
    // One header in the tree — the pinned-clone double match the spike
    // hit is a browser overlay artifact; the seam mounts the data as-is.
    expect(findAllByTestID(toJson(renderer), 'table-header')).toHaveLength(1);

    await press(renderer, 'header-sort-amount');
    expect(lastStickyHeaderIndices()).toEqual([0]); // still item 0 after a sort
    expect(findByTestID(toJson(renderer), 'table-header')).toBeTruthy();
  });
});

describe('DataTable — every row carries the status colour on its left edge', () => {
  const SIX: Job[] = JOB_STATUSES.map((status, i) => ({
    id: i + 1,
    jobNumber: `JC-2627-${String(i + 1).padStart(5, '0')}`,
    customer: `Edge case ${i + 1}`,
    service: SERVICES[0]!,
    technician: 'Ravi Kumar',
    scheduledForMs: Date.UTC(2026, 8, 1),
    amount: 1000,
    status,
  }));

  it('renders one row per status with the STATUS-map colour as its 4px leading edge', async () => {
    const renderer = await mountShell(SIX);

    for (let i = 0; i < JOB_STATUSES.length; i += 1) {
      const status = JOB_STATUSES[i]!;
      const row = findByTestID(toJson(renderer), `data-row-${i + 1}`);
      expect(row, status).toBeTruthy();
      const edge = row?.children?.[0];
      expect(edge !== null && edge !== undefined && typeof edge !== 'string' ? edge.type : undefined, status).toBe('View');
      const flat = flatten(
        edge !== null && edge !== undefined && typeof edge !== 'string' ? edge.props.style : undefined,
      );
      // `assigned` rides the muted slate, exactly as the JobCard does.
      expect(flat.backgroundColor, status).toBe(statusColour(status));
      expect(flat.width, status).toBe(4);
      // §1.6 — the two rails below the 3:1 non-text floor carry the 1px
      // slate.900 outer edge on the leading side; the rest do not.
      if (status === 'in_progress' || status === 'en_route') {
        expect(flat.borderLeftWidth, status).toBe(1);
        expect(flat.borderLeftColor, status).toBe(SEMANTIC.line.focus);
      } else {
        expect(flat.borderLeftWidth, status).toBeUndefined();
      }
      // A rail never appears without its word (§1.6): the status column
      // of the same row carries the word.
      expect(allText(row ?? null)).toContain(status);
    }
  });

  it('zebra stripes slate.100 on odd rows, raised white on even', async () => {
    const renderer = await mountShell(SIX);
    const rows = rowNodes(renderer);
    expect(rows).toHaveLength(6);
    rows.forEach((row) => {
      // The memoised row itself always paints raised; the stripe is the
      // wrapper's, asserted below.
      const flat = flatten(row.props.style);
      expect(flat.height).toBe(DENSITY.desk.rowHeight);
      expect(flat.backgroundColor).toBe('#FFFFFF');
    });
    const stripes = findAll(toJson(renderer), (n) => n.type === 'View' && flatten(n.props.style).backgroundColor === SEMANTIC.bg.dense);
    // Odd indices of six rows: 1, 3, 5 — the slate.100 stripes.
    expect(stripes).toHaveLength(3);
  });

  it('desk density geometry — 40pt rows, 14px body; a row press reaches the consumer', async () => {
    const renderer = await mountShell(SIX);
    const row = findByTestID(toJson(renderer), 'data-row-3');
    expect(flatten(row?.props.style).height).toBe(DENSITY.desk.rowHeight);
    await act(async () => {
      (row?.props.onPress as () => void)();
    });
    expect(onRowPress).toHaveBeenCalledTimes(1);
    expect(onRowPress).toHaveBeenCalledWith(SIX[2]);
    // Desk body size rides the consumer's cell style — the component's
    // contract is that columns render at desk density (§3.3).
    const statusText = findAll(row ?? null, (n) => n.type === 'Text' && (flatten(n.props.style).fontSize === 14));
    expect(statusText.length).toBeGreaterThan(0);
  });
});

describe('DataTable — sort state machine', () => {
  it('a new column starts asc; the same column toggles; the header names the state', async () => {
    const renderer = await mountShell(makeJobs(20));
    // The sort arrow is a second text child of the header cell, so the
    // state reads off the header's JOINED text.
    const headerText = (): string => allText(findByTestID(toJson(renderer), 'table-header') ?? null).join('');
    await press(renderer, 'header-sort-amount');
    expect(headerText()).toContain('Amount ↑');
    await press(renderer, 'header-sort-amount');
    expect(headerText()).toContain('Amount ↓');
    await press(renderer, 'header-sort-scheduled');
    expect(headerText()).toContain('Scheduled ↑');
    expect(headerText()).not.toContain('Amount ↑');
  });

  it('sorts numbers numerically', async () => {
    const jobs = makeJobs(50);
    const renderer = await mountShell(jobs);
    await press(renderer, 'header-sort-amount');
    const byId = new Map(jobs.map((j) => [j.id, j]));
    const amounts = rowNodes(renderer)
      .map((n) => byId.get(Number((n.props.testID as string).replace('data-row-', '')))?.amount)
      .filter((a): a is number => a !== undefined);
    expect(amounts).toEqual(amounts.slice().sort((a, b) => a - b));
  });
});

describe('DataTable is web-only — never bundled into the APK', () => {
  // The real resolver inputs, from the app's own Metro config. Loaded
  // once at collection: the expo config chain is heavy, and on a loaded
  // machine it can exceed the per-test floor.
  const require = createRequire(import.meta.url);
  const { getDefaultConfig } = require('expo/metro-config') as {
    getDefaultConfig: (dir: string) => { resolver: { sourceExts: string[] } };
  };
  const { sourceExts } = getDefaultConfig(join(dirname(fileURLToPath(import.meta.url)), '..', '..', '..')).resolver;

  it(
    'Metro platform resolution finds the .web.tsx and no native counterpart',
    () => {
      const domainDir = dirname(fileURLToPath(import.meta.url));

      const candidates = (suffix: string): string[] =>
        sourceExts.map((ext) => join(domainDir, suffix === '' ? `DataTable.${ext}` : `DataTable.${suffix}.${ext}`));

      // Metro resolves a native request (android/ios) through
      // `.<platform>.<ext>`, then `.native.<ext>`, then plain `.<ext>` —
      // over every source extension, NO candidate may exist, or the APK
      // would carry this module.
      for (const platform of ['android', 'ios']) {
        for (const file of [...candidates(platform), ...candidates('native'), ...candidates('')]) {
          expect(existsSync(file), `${platform} would resolve ${file}`).toBe(false);
        }
      }
      // The web request hits the web file — and nothing else answers.
      const webHits = candidates('web').filter((file) => existsSync(file));
      expect(webHits).toEqual([join(domainDir, 'DataTable.web.tsx')]);
    },
    30_000,
  );
});
