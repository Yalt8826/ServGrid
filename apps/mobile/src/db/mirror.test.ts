/**
 * T1.13 — the SQLite mirror's tests (apps/mobile/src/db/mirror.test.ts).
 *
 * The database under test is REAL: vitest aliases `expo-sqlite` to the
 * node:sqlite-backed seam (src/test-stubs/expo-sqlite.ts), so the mirror's
 * upserts, tombstone deletes, CHECK constraints and savepoint transactions
 * run against a genuine SQLite engine — no mocked database.
 *
 * The four cases the spec names, plus the ones its "Done when" boxes demand:
 *  - a delta page applies atomically — a failure mid-page leaves the cursor
 *    unmoved (and the cursor DOES advance on a fully-applied page)
 *  - `deleted` and `out_of_scope` tombstones both remove the row
 *  - bootstrap then delta converges on the same state as a fresh bootstrap
 *    carrying the later data
 *  - a dispatcher session never opens the database — the module is never
 *    even imported (asserted against the seam's module-evaluation counter,
 *    so a cached re-import cannot hide from the assertion)
 *  - the mirror clears on user switch
 */
import { beforeEach, describe, expect, it, vi } from 'vitest';

import type { SyncBootstrapResponse, SyncDeltaResponse, SyncWorkingSet } from '@servgrid/shared';

import {
  MirrorUnavailableError,
  applyBootstrap,
  applyDeltaPage,
  clearMirror,
  openMirror,
  roleHasMirror,
  readCursor,
  readRows,
  type Mirror,
  type MirrorCustomer,
  type MirrorCustomerProduct,
  type MirrorEntity,
  type MirrorJob,
  type MirrorProduct,
  type MirrorService,
} from './mirror';
import { __expoSqliteModuleLoads, __expoSqliteOpenCalls, __resetSqliteSeam } from '../test-stubs/expo-sqlite';

// ── fixtures ────────────────────────────────────────────────────────────────

function makeJob(overrides: Partial<MirrorJob> = {}): MirrorJob {
  return {
    id: '01890a5e-1000-7000-8000-000000000001',
    jobNumber: 'JC-2627-00001',
    title: 'UPS battery swap',
    status: 'assigned',
    priority: 'normal',
    scheduledFor: '2026-09-11T05:30:00+05:30',
    customerId: '01890a5e-2000-7000-8000-000000000001',
    contactName: 'Ravi Kumar',
    contactPhone: '+919000000001',
    description: null,
    contract: null,
    version: 1,
    ...overrides,
  };
}

function makeCustomer(overrides: Partial<MirrorCustomer> = {}): MirrorCustomer {
  return {
    id: '01890a5e-2000-7000-8000-000000000001',
    name: 'Sri Balaji Agencies',
    phone: '+919000000001',
    altPhone: null,
    addressLine1: '14, Gandhi Bazaar',
    addressLine2: null,
    city: 'Coimbatore',
    state: 'Tamil Nadu',
    pincode: '641012',
    latitude: 11.0168,
    longitude: 76.9558,
    notes: null,
    companyId: null,
    version: 1,
    ...overrides,
  };
}

function makeCustomerProduct(overrides: Partial<MirrorCustomerProduct> = {}): MirrorCustomerProduct {
  return {
    id: '01890a5e-3000-7000-8000-000000000001',
    customerId: '01890a5e-2000-7000-8000-000000000001',
    productId: '01890a5e-4000-7000-8000-000000000001',
    freeTextName: null,
    serialNumber: 'APC-2024-000111',
    quantity: 1,
    installedOn: '2024-06-10',
    warrantyExpiresOn: '2027-06-10',
    notes: null,
    version: 1,
    ...overrides,
  };
}

function makeProduct(overrides: Partial<MirrorProduct> = {}): MirrorProduct {
  return {
    id: '01890a5e-4000-7000-8000-000000000001',
    sku: 'BAT-150-12',
    name: '150Ah tubular battery',
    category: 'battery',
    brand: 'Amaron',
    modelNumber: null,
    capacityLabel: '150Ah',
    unit: null,
    defaultPrice: '14500.00',
    warrantyMonths: 36,
    version: 1,
    ...overrides,
  };
}

function makeService(overrides: Partial<MirrorService> = {}): MirrorService {
  return {
    id: '01890a5e-5000-7000-8000-000000000001',
    code: 'PM-QUARTERLY',
    name: 'Quarterly preventive maintenance',
    description: null,
    defaultCharge: '0.00',
    version: 1,
    ...overrides,
  };
}

function bootstrapOf(workingSet: Partial<SyncWorkingSet>, cursor: string): SyncBootstrapResponse {
  return {
    data: {
      jobs: [],
      customers: [],
      customerProducts: [],
      products: [],
      services: [],
      ...workingSet,
    },
    cursor,
  };
}

function deltaOf(
  workingSet: Partial<SyncWorkingSet>,
  tombstones: SyncDeltaResponse['tombstones'],
  cursor: string,
): SyncDeltaResponse {
  return {
    data: {
      jobs: [],
      customers: [],
      customerProducts: [],
      products: [],
      services: [],
      ...workingSet,
    },
    tombstones,
    cursor,
    hasMore: false,
  };
}

async function openedTechnicianMirror(): Promise<Mirror> {
  return openMirror('technician');
}

/** Everything the mirror persists, keyed the way tombstones name entities. */
function snapshot(mirror: Mirror): Record<MirrorEntity, Array<Record<string, unknown>>> {
  return {
    job: readRows(mirror, 'job'),
    customer: readRows(mirror, 'customer'),
    customer_product: readRows(mirror, 'customer_product'),
    product: readRows(mirror, 'product'),
    service: readRows(mirror, 'service'),
  };
}

beforeEach(() => {
  __resetSqliteSeam();
});

// ── the role gate (PLAN-FRONTEND.md §4) ─────────────────────────────────────

describe('openMirror — the role gate', () => {
  it('opens for an offline role, ensures the schema, and really opens the database', async () => {
    const opensBefore = __expoSqliteOpenCalls();

    const mirror = await openedTechnicianMirror();

    expect(__expoSqliteOpenCalls()).toBeGreaterThan(opensBefore);

    // Fresh mirror: schema exists (a bootstrap applies cleanly), no cursor yet.
    expect(readCursor(mirror)).toBeNull();
    applyBootstrap(mirror, bootstrapOf({ jobs: [makeJob()] }, '2026-09-11T09:00:00+05:30'));
    expect(readCursor(mirror)).toBe('2026-09-11T09:00:00+05:30');
  });

  it('a fresh import after vi.resetModules() moves the load counter — the signal the gate test reads', async () => {
    const loadsBefore = __expoSqliteModuleLoads();
    vi.resetModules();

    const mirror = await openMirror('technician');

    // The dynamic import re-evaluated the seam: the counter the dispatcher
    // test asserts against demonstrably moves when expo-sqlite is imported.
    expect(__expoSqliteModuleLoads()).toBe(loadsBefore + 1);
    expect(readCursor(mirror)).toBeNull();
  });

  it('a dispatcher session never opens the database — the module is never even imported', async () => {
    // Fresh module registry: if the gate DID import `./sqliteMirror`, the
    // re-import re-evaluates the seam and the load counter rises. Without
    // the reset a cached import would be invisible to the counter.
    vi.resetModules();
    const loadsBefore = __expoSqliteModuleLoads();
    const opensBefore = __expoSqliteOpenCalls();

    await expect(openMirror('dispatcher')).rejects.toBeInstanceOf(MirrorUnavailableError);
    await expect(openMirror('dispatcher')).rejects.toThrow(/dispatcher/);

    expect(__expoSqliteModuleLoads()).toBe(loadsBefore);
    expect(__expoSqliteOpenCalls()).toBe(opensBefore);
  });

  it('an owner session is refused the same way', async () => {
    vi.resetModules();
    const loadsBefore = __expoSqliteModuleLoads();

    await expect(openMirror('owner')).rejects.toBeInstanceOf(MirrorUnavailableError);
    expect(__expoSqliteModuleLoads()).toBe(loadsBefore);
  });
});

// ── atomic delta application (T1.13, PLAN-DATA-MODEL.md §6) ─────────────────

describe('atomic delta application', () => {
  it('applying a delta page is atomic: a failure mid-page leaves the cursor unmoved', async () => {
    const mirror = await openedTechnicianMirror();
    const existing = makeJob({ id: '01890a5e-1000-7000-8000-00000000000a', jobNumber: 'JC-2627-0000A' });
    applyBootstrap(mirror, bootstrapOf({ jobs: [existing] }, '2026-09-11T09:00:00+05:30'));

    // Two good rows, then a malformed one — a version below zero violates
    // the mirror's CHECK. The page must die WHOLE: no J1, no J2, cursor
    // still at the bootstrap value, so the next poll re-requests everything.
    const page = deltaOf(
      {
        jobs: [
          makeJob({ id: '01890a5e-1000-7000-8000-00000000000b', jobNumber: 'JC-2627-0000B' }),
          makeJob({ id: '01890a5e-1000-7000-8000-00000000000c', jobNumber: 'JC-2627-0000C' }),
          makeJob({ id: '01890a5e-1000-7000-8000-00000000000d', jobNumber: 'JC-2627-0000D', version: -1 }),
        ],
      },
      [],
      '2026-09-11T10:00:00+05:30',
    );

    expect(() => applyDeltaPage(mirror, page)).toThrow(/CHECK constraint failed/);

    expect(readCursor(mirror)).toBe('2026-09-11T09:00:00+05:30');
    expect(readRows(mirror, 'job')).toEqual([
      {
        id: '01890a5e-1000-7000-8000-00000000000a',
        job_number: 'JC-2627-0000A',
        title: 'UPS battery swap',
        status: 'assigned',
        priority: 'normal',
        scheduled_for: '2026-09-11T05:30:00+05:30',
        customer_id: '01890a5e-2000-7000-8000-000000000001',
        contact_name: 'Ravi Kumar',
        contact_phone: '+919000000001',
        description: null,
        contract_number: null,
        contract_billing: null,
        contract_visits_remaining: null,
        version: 1,
      },
    ]);
  });

  it('advances the cursor when — and only when — the whole page applies', async () => {
    const mirror = await openedTechnicianMirror();
    applyBootstrap(mirror, bootstrapOf({ jobs: [makeJob()] }, '2026-09-11T09:00:00+05:30'));

    applyDeltaPage(
      mirror,
      deltaOf({ jobs: [makeJob({ status: 'en_route', version: 2 })] }, [], '2026-09-11T10:00:00+05:30'),
    );

    expect(readCursor(mirror)).toBe('2026-09-11T10:00:00+05:30');
    const jobs = readRows(mirror, 'job');
    expect(jobs).toHaveLength(1);
    expect(jobs[0]).toMatchObject({ status: 'en_route', version: 2 });
  });

  it('a deleted tombstone and an out_of_scope tombstone both remove the row', async () => {
    const mirror = await openedTechnicianMirror();
    const softDeletedJob = makeJob({ id: '01890a5e-1000-7000-8000-00000000000a' });
    const reassignedJob = makeJob({ id: '01890a5e-1000-7000-8000-00000000000b' });
    const keptCustomer = makeCustomer();
    const outOfScopeCustomer = makeCustomer({
      id: '01890a5e-2000-7000-8000-000000000002',
      name: 'Other site, reassigned away',
    });
    applyBootstrap(
      mirror,
      bootstrapOf(
        { jobs: [softDeletedJob, reassignedJob], customers: [keptCustomer, outOfScopeCustomer] },
        '2026-09-11T09:00:00+05:30',
      ),
    );

    // `deleted` — the row went inactive. `out_of_scope` — the reassigned job
    // is perfectly alive, just no longer this technician's. Both must leave
    // the mirror. A tombstone for a row already gone must not error.
    applyDeltaPage(
      mirror,
      deltaOf(
        {},
        [
          { entity: 'job', id: softDeletedJob.id, reason: 'deleted' },
          { entity: 'customer', id: outOfScopeCustomer.id, reason: 'out_of_scope' },
          { entity: 'job', id: '01890a5e-1000-7000-8000-0000000000ff', reason: 'out_of_scope' },
        ],
        '2026-09-11T10:00:00+05:30',
      ),
    );

    expect(readRows(mirror, 'job')).toHaveLength(1);
    expect(readRows(mirror, 'job')[0]?.id).toBe(reassignedJob.id);
    expect(readRows(mirror, 'customer')).toHaveLength(1);
    expect(readRows(mirror, 'customer')[0]?.id).toBe(keptCustomer.id);
    expect(readCursor(mirror)).toBe('2026-09-11T10:00:00+05:30');
  });

  it('bootstrap then delta produces the same state as bootstrap alone with the later data', async () => {
    const customer = makeCustomer();
    const jobV1 = makeJob();
    const jobV2 = makeJob({ status: 'en_route', version: 2 });
    const freshJob = makeJob({ id: '01890a5e-1000-7000-8000-000000000002', jobNumber: 'JC-2627-00002' });
    const product = makeProduct();
    const service = makeService();

    // Path A: yesterday's bootstrap, then today's delta.
    const mirror = await openedTechnicianMirror();
    applyBootstrap(mirror, bootstrapOf({ jobs: [jobV1], customers: [customer] }, '2026-09-11T09:00:00+05:30'));
    applyDeltaPage(
      mirror,
      deltaOf({ jobs: [jobV2, freshJob], products: [product], services: [service] }, [], '2026-09-11T10:00:00+05:30'),
    );
    const afterBootstrapThenDelta = snapshot(mirror);

    // Path B: a fresh bootstrap that already carries the later data — the
    // state a technician who was offline the whole time sees.
    clearMirror(mirror);
    applyBootstrap(
      mirror,
      bootstrapOf(
        { jobs: [jobV2, freshJob], customers: [customer], products: [product], services: [service] },
        '2026-09-11T10:00:00+05:30',
      ),
    );
    const bootstrapAlone = snapshot(mirror);

    expect(afterBootstrapThenDelta).toEqual(bootstrapAlone);
  });
});

// ── user switch (PLAN-FRONTEND.md §5) ───────────────────────────────────────

describe('user switch', () => {
  it('clearMirror wipes the working set and the cursor', async () => {
    const mirror = await openedTechnicianMirror();
    applyBootstrap(
      mirror,
      bootstrapOf(
        {
          jobs: [makeJob()],
          customers: [makeCustomer()],
          customerProducts: [makeCustomerProduct()],
          products: [makeProduct()],
          services: [makeService()],
        },
        '2026-09-11T09:00:00+05:30',
      ),
    );

    clearMirror(mirror);

    for (const entity of ['job', 'customer', 'customer_product', 'product', 'service'] as const) {
      expect(readRows(mirror, entity)).toEqual([]);
    }
    expect(readCursor(mirror)).toBeNull();
    // The outbox (T1.14) is filtered by employee_id, not wiped — clearing
    // the mirror must not (and here cannot) reach another module's table.
  });
});

describe('the mirror capability is role AND platform, not role alone', () => {
  // PLAN.md §1: technicians and sales reps are Android-only; the web build
  // exists for the owner. So there is no offline *session* on web, and a
  // role-only gate is how a browser ended up asking wa-sqlite for a
  // database and getting `SharedArrayBuffer is not defined`.
  const withDocument = (fn: () => void): void => {
    const g = globalThis as { window?: unknown; document?: unknown };
    const hadWindow = 'window' in g;
    const hadDocument = 'document' in g;
    const prevWindow = g.window;
    const prevDocument = g.document;
    const doc = { nodeType: 9 };
    g.document = doc;
    g.window = { document: doc };
    try {
      fn();
    } finally {
      if (hadWindow) g.window = prevWindow;
      else delete g.window;
      if (hadDocument) g.document = prevDocument;
      else delete g.document;
    }
  };

  it('an offline role has a mirror on native', () => {
    expect(roleHasMirror('technician')).toBe(true);
    expect(roleHasMirror('sales_rep')).toBe(true);
  });

  it('an online role never has one', () => {
    expect(roleHasMirror('dispatcher')).toBe(false);
    expect(roleHasMirror('owner')).toBe(false);
  });

  it('NO role has one in a browser — including the offline roles', () => {
    withDocument(() => {
      for (const role of ['technician', 'sales_rep', 'dispatcher', 'owner'] as const) {
        expect(roleHasMirror(role), `${role} must not open a mirror on web`).toBe(false);
      }
    });
  });

  it('openMirror refuses on web rather than reaching expo-sqlite', async () => {
    // The provider does catch, but wa-sqlite initialises in a Web Worker
    // and a throw on the worker thread never reaches the awaiting promise.
    // Not causing the failure is the only reliable way not to handle it.
    await withDocumentAsync(async () => {
      await expect(openMirror('technician')).rejects.toThrow(/technician/);
    });
  });

  async function withDocumentAsync(fn: () => Promise<void>): Promise<void> {
    const g = globalThis as { window?: unknown; document?: unknown };
    const doc = { nodeType: 9 };
    g.document = doc;
    g.window = { document: doc };
    try {
      await fn();
    } finally {
      delete g.window;
      delete g.document;
    }
  }
});
