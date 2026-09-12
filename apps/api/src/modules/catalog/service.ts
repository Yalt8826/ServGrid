import type { ProductRecord, ServiceRecord } from '@servgrid/shared';
import { AppError } from '../../plugins/errors.js';
import { getPool } from '../../db/pool.js';
import { withTransaction } from '../../db/tx.js';
import * as repo from './repo.js';

/**
 * Catalogue service (PLAN-BACKEND.md §6.4): products and services are
 * read by everyone and written only by the owner. Everything here is
 * deliberately unexciting — small, slow-moving tables, no pagination, no
 * search beyond a client-side filter — because the interesting rules live
 * in the database: the SKU/code uniqueness (a retired code must not be
 * reissued onto records that still cite it) and the "deactivate rather
 * than delete" correction path.
 */

const NOT_FOUND_MESSAGE = "We couldn't find that.";

interface PgViolation {
  code: string;
  constraint?: string;
}

function isPgViolation(error: unknown): error is PgViolation {
  return typeof error === 'object' && error !== null && typeof (error as { code?: unknown }).code === 'string';
}

function mapDbRefusal(error: unknown): Error {
  if (!isPgViolation(error)) return error instanceof Error ? error : new Error(String(error));
  if (error.code === '23505') {
    // products_sku_unique / services_code_unique — outright unique, active
    // or not (§3.2: a retired code is never reissued).
    return new AppError('VALIDATION_FAILED', 'That code already exists in the catalogue.');
  }
  if (error.code === '23514' || error.code === '23503') {
    return new AppError(
      'VALIDATION_FAILED',
      'One of the details conflicts with a business rule — check the form and try again.',
    );
  }
  return error instanceof Error ? error : new Error(String(error));
}

function toProduct(row: repo.ProductRow): ProductRecord {
  return {
    id: row.id,
    sku: row.sku,
    name: row.name,
    category: row.category,
    brand: row.brand,
    modelNumber: row.model_number,
    capacityLabel: row.capacity_label,
    unit: row.unit,
    defaultPrice: row.default_price,
    warrantyMonths: row.warranty_months,
    version: row.version,
  };
}

function toService(row: repo.ServiceRow): ServiceRecord {
  return {
    id: row.id,
    code: row.code,
    name: row.name,
    description: row.description,
    defaultCharge: row.default_charge,
    version: row.version,
  };
}

export function createCatalogService() {
  async function listProducts(): Promise<ProductRecord[]> {
    return (await repo.listProducts(getPool())).map(toProduct);
  }

  async function listServices(): Promise<ServiceRecord[]> {
    return (await repo.listServices(getPool())).map(toService);
  }

  async function createProduct(input: repo.ProductInsert): Promise<ProductRecord> {
    let id: string;
    try {
      id = await repo.insertProduct(getPool(), input);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapDbRefusal(error);
    }
    const row = await repo.findProduct(getPool(), id);
    if (row === null) {
      throw new AppError('INTERNAL', 'The product could not be read back — nothing was lost, try again.');
    }
    return toProduct(row);
  }

  async function createService(input: repo.ServiceInsert): Promise<ServiceRecord> {
    let id: string;
    try {
      id = await repo.insertService(getPool(), input);
    } catch (error) {
      if (error instanceof AppError) throw error;
      throw mapDbRefusal(error);
    }
    const row = await repo.findService(getPool(), id);
    if (row === null) {
      throw new AppError('INTERNAL', 'The service could not be read back — nothing was lost, try again.');
    }
    return toService(row);
  }

  /** PATCH /v1/products/:id (§6.4) — under `If-Match`; `isActive: false` is the deactivation, never a delete. */
  async function patchProduct(productId: string, ifMatch: number, fields: repo.ProductPatchFields): Promise<ProductRecord> {
    return withTransaction(async (client) => {
      const locked = await repo.lockProduct(client, productId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (locked.version !== ifMatch) {
        throw new AppError('VERSION_CONFLICT', 'This product changed after you opened it — reload it and try again.', {
          currentVersion: locked.version,
        });
      }
      try {
        await repo.patchProduct(client, productId, fields);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw mapDbRefusal(error);
      }
      const row = await repo.findProduct(client, productId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The product could not be read back — nothing was lost, try again.');
      }
      return toProduct(row);
    });
  }

  async function patchService(serviceId: string, ifMatch: number, fields: repo.ServicePatchFields): Promise<ServiceRecord> {
    return withTransaction(async (client) => {
      const locked = await repo.lockService(client, serviceId);
      if (locked === null) throw new AppError('NOT_FOUND', NOT_FOUND_MESSAGE);
      if (locked.version !== ifMatch) {
        throw new AppError('VERSION_CONFLICT', 'This service changed after you opened it — reload it and try again.', {
          currentVersion: locked.version,
        });
      }
      try {
        await repo.patchService(client, serviceId, fields);
      } catch (error) {
        if (error instanceof AppError) throw error;
        throw mapDbRefusal(error);
      }
      const row = await repo.findService(client, serviceId);
      if (row === null) {
        throw new AppError('INTERNAL', 'The service could not be read back — nothing was lost, try again.');
      }
      return toService(row);
    });
  }

  return { listProducts, listServices, createProduct, createService, patchProduct, patchService };
}

export type CatalogService = ReturnType<typeof createCatalogService>;
