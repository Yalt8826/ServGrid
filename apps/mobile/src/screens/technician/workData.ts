/**
 * Work read → views: the one pure transform the technician's screens are
 * built on (PLAN-FRONTEND.md §4). Takes `GET /v1/technician/work` and
 * returns the joined `JobView[]`, the completion instants and the parts
 * catalogue — the shapes `DashboardScreen`, `JobsScreen` and the complete
 * sheet render. No React, no I/O, so the tests run it directly.
 *
 * The join is the point: the technician's job card names only the
 * customer's id, and *Navigate* needs the site's coordinates from the
 * customer row. This replaces the SQL join the offline mirror ran.
 */
import type { TechnicianWork } from '@servgrid/shared';
import type { JobView, UnitView } from './jobView';

type WorkProduct = TechnicianWork['products'][number];
type WorkUnit = TechnicianWork['customerProducts'][number];

/**
 * The unit line (§T3): the unit with serial and warranty expiry. The job
 * card carries no `customer_product_id`, so a job cannot name its unit; a
 * site with exactly one active unit makes it unambiguous. A site with five
 * UPS units names nothing — the section is omitted rather than guessed.
 */
function unitViewOf(unit: WorkUnit, product: WorkProduct | undefined): UnitView {
  const descriptor = [product?.name ?? null, product?.capacityLabel ?? null]
    .filter((part): part is string => part !== null)
    .join(' ');
  return {
    name: descriptor !== '' ? descriptor : (unit.freeTextName ?? 'Unit'),
    brand: product?.brand ?? null,
    serialNumber: unit.serialNumber,
    warrantyExpiresOn: unit.warrantyExpiresOn,
  };
}

export interface TechnicianWorkViews {
  views: JobView[];
  /** Job id → the instant the server closed a completed job. */
  completedAtById: Record<string, string>;
  /** The active catalogue, in name order — the complete sheet's parts picker. */
  products: Array<{ id: string; name: string; category: string }>;
  /**
   * The service catalogue, in name order (2026-09-16) — the complete
   * sheet's first question, and where the cost comes from. The server
   * answers with the active rows only, so a retired service cannot be
   * chosen here even though a completion may still reference one.
   */
  services: Array<{ id: string; name: string; defaultCharge: string | null }>;
}

export function buildJobViews(work: TechnicianWork): TechnicianWorkViews {
  const customers = new Map(work.customers.map((customer) => [customer.id, customer]));
  const products = new Map(work.products.map((product) => [product.id, product]));
  const unitsByCustomer = new Map<string, WorkUnit[]>();
  for (const unit of work.customerProducts) {
    const units = unitsByCustomer.get(unit.customerId) ?? [];
    units.push(unit);
    unitsByCustomer.set(unit.customerId, units);
  }

  const completedAtById: Record<string, string> = {};
  const views: JobView[] = work.jobs.map(({ closedAt, ...job }) => {
    if (job.status === 'completed' && closedAt !== null) completedAtById[job.id] = closedAt;
    const customer = customers.get(job.customerId);
    const units = unitsByCustomer.get(job.customerId) ?? [];
    const lone = units.length === 1 ? units[0]! : null;
    return {
      job,
      customerName: customer?.name ?? 'Customer',
      // The site's locality (migration 021) when someone has named it;
      // the address tail is the fallback for sites nobody has yet. This
      // is the line the technician scans to tell two jobs apart, so the
      // real locality beats a guess derived from the address lines.
      area: customer?.area ?? customer?.addressLine2 ?? customer?.city ?? '',
      coordinates:
        customer !== undefined && customer.latitude !== null && customer.longitude !== null
          ? { latitude: customer.latitude, longitude: customer.longitude }
          : null,
      // The hook overlays these: a write in flight, and the server's refusal.
      pending: false,
      rejectedMessage: null,
      unit: lone === null ? null : unitViewOf(lone, lone.productId === null ? undefined : products.get(lone.productId)),
    };
  });

  const catalogue = [...work.products]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((product) => ({ id: product.id, name: product.name, category: product.category }));

  // The service catalogue the complete sheet prices a visit from — name
  // order, like the parts catalogue, so the dropdown reads as a list.
  const serviceCatalogue = [...work.services]
    .sort((a, b) => a.name.localeCompare(b.name))
    .map((service) => ({ id: service.id, name: service.name, defaultCharge: service.defaultCharge }));

  return { views, completedAtById, products: catalogue, services: serviceCatalogue };
}
