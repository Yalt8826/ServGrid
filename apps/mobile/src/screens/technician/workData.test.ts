/**
 * `buildJobViews` — the join the technician's screens render
 * (PLAN-FRONTEND.md §4). Pure over the work read, so no network and no
 * database: the input is exactly what `GET /v1/technician/work` answers.
 */
import { describe, expect, it } from 'vitest';

import type { TechnicianWork } from '@servgrid/shared';
import { buildJobViews } from './workData';

const SITE = '01890a5e-2000-7000-8000-000000000001';
const OTHER_SITE = '01890a5e-2000-7000-8000-000000000002';
const UPS = '01890a5e-3000-7000-8000-000000000001';

function job(id: string, overrides: Partial<TechnicianWork['jobs'][number]> = {}): TechnicianWork['jobs'][number] {
  return {
    id,
    jobNumber: `JC-2627-${id.slice(-5)}`,
    title: 'UPS battery swap',
    status: 'assigned',
    priority: 'normal',
    scheduledFor: '2026-09-11T14:30:00+05:30',
    customerId: SITE,
    contactName: null,
    contactPhone: null,
    description: null,
    contract: null,
    version: 1,
    closedAt: null,
    ...overrides,
  };
}

function customer(id: string, overrides: Partial<TechnicianWork['customers'][number]> = {}): TechnicianWork['customers'][number] {
  return {
    id,
    name: 'Sunrise Apartments',
    phone: '+919000000001',
    altPhone: null,
    addressLine1: '14, Gandhi Bazaar',
    addressLine2: 'Kormangala 3rd Blk',
    city: 'Bengaluru',
    state: 'Karnataka',
    pincode: '560034',
    latitude: 12.9352,
    longitude: 77.6245,
    notes: null,
    companyId: null,
    version: 1,
    ...overrides,
  };
}

function unit(id: string, customerId: string): TechnicianWork['customerProducts'][number] {
  return {
    id,
    customerId,
    productId: UPS,
    freeTextName: null,
    serialNumber: `SN-${id.slice(-4)}`,
    quantity: 1,
    installedOn: null,
    warrantyExpiresOn: '2027-03-14',
    notes: null,
    version: 1,
  };
}

const PRODUCT: TechnicianWork['products'][number] = {
  id: UPS,
  sku: 'LUM-850',
  name: 'UPS',
  category: 'ups',
  brand: 'Luminous',
  modelNumber: null,
  capacityLabel: '850VA',
  unit: null,
  defaultPrice: null,
  warrantyMonths: 24,
  version: 1,
};

function work(overrides: Partial<TechnicianWork> = {}): TechnicianWork {
  return { jobs: [], customers: [], customerProducts: [], products: [PRODUCT], services: [], ...overrides };
}

describe('buildJobViews', () => {
  it('joins each job to its site: name, area and the coordinates Navigate needs', () => {
    const { views } = buildJobViews(work({ jobs: [job('a0000000-0000-4000-8000-000000000001')], customers: [customer(SITE)] }));
    expect(views).toHaveLength(1);
    expect(views[0]!.customerName).toBe('Sunrise Apartments');
    expect(views[0]!.area).toBe('Kormangala 3rd Blk');
    expect(views[0]!.coordinates).toEqual({ latitude: 12.9352, longitude: 77.6245 });
    expect(views[0]!.pending).toBe(false);
    expect(views[0]!.rejectedMessage).toBeNull();
    expect(views[0]!.job).not.toHaveProperty('closedAt');
  });

  it('a site without coordinates offers no Navigate; a missing site still renders', () => {
    const { views } = buildJobViews(
      work({
        jobs: [job('a0000000-0000-4000-8000-000000000001'), job('a0000000-0000-4000-8000-000000000002', { customerId: OTHER_SITE })],
        customers: [customer(SITE, { latitude: null, addressLine2: null })],
      }),
    );
    expect(views[0]!.coordinates).toBeNull();
    expect(views[0]!.area).toBe('Bengaluru');
    expect(views[1]!.customerName).toBe('Customer');
  });

  it('names the unit only when the site has exactly one — five units name nothing', () => {
    const single = buildJobViews(
      work({ jobs: [job('a0000000-0000-4000-8000-000000000001')], customers: [customer(SITE)], customerProducts: [unit('b0000000-0000-4000-8000-000000000001', SITE)] }),
    );
    expect(single.views[0]!.unit).toEqual({ name: 'UPS 850VA', brand: 'Luminous', serialNumber: 'SN-0001', warrantyExpiresOn: '2027-03-14' });

    const many = buildJobViews(
      work({
        jobs: [job('a0000000-0000-4000-8000-000000000001')],
        customers: [customer(SITE)],
        customerProducts: [unit('b0000000-0000-4000-8000-000000000001', SITE), unit('b0000000-0000-4000-8000-000000000002', SITE)],
      }),
    );
    expect(many.views[0]!.unit).toBeNull();
  });

  it('dates a completed job by the server’s closedAt — and only a completed one', () => {
    const { completedAtById } = buildJobViews(
      work({
        jobs: [
          job('a0000000-0000-4000-8000-000000000001', { status: 'completed', closedAt: '2026-09-11T03:30:00.000Z' }),
          job('a0000000-0000-4000-8000-000000000002', { status: 'cancelled', closedAt: '2026-09-11T04:00:00.000Z' }),
          job('a0000000-0000-4000-8000-000000000003'),
        ],
        customers: [customer(SITE)],
      }),
    );
    expect(completedAtById).toEqual({ 'a0000000-0000-4000-8000-000000000001': '2026-09-11T03:30:00.000Z' });
  });

  it('offers the catalogue in name order for the parts picker', () => {
    const { products } = buildJobViews(
      work({ products: [{ ...PRODUCT, id: 'p2', name: 'Battery 150Ah', category: 'battery' }, PRODUCT] }),
    );
    expect(products.map((p) => p.name)).toEqual(['Battery 150Ah', 'UPS']);
  });
});
