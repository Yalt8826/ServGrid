import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import { z } from 'zod';
import {
  ProductSchema,
  ServiceSchema,
  productCreateRequestSchema,
  productPatchRequestSchema,
  serviceCreateRequestSchema,
  servicePatchRequestSchema,
  uuid,
} from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import { createCatalogService } from './service.js';

/**
 * The catalogue routes (PLAN-BACKEND.md §6.4): GET/POST /v1/products,
 * /v1/services, PATCH by id. Read by EVERYONE — the completion form and
 * the sales line-item picker both need them — written only by the owner,
 * under `If-Match`, deactivated rather than deleted.
 *
 * [impl] The permission matrix has no catalogue resource: §6.4 fixes the
 * whole rule ("read: all; write: owner") as a role fact, not a scope, and
 * `packages/shared` is serial within the phase — so the write gate here
 * is a role check, server-side and single-sourced in this one preHandler.
 * If catalogue permissions ever need scopes (per-category owners, say),
 * that is the moment to add the matrix rows.
 */

const CATALOGUE_WRITER_MESSAGE = 'Products and services are maintained by the owner.';

/** A whole-table write surface for a resource the matrix does not carry — owner only, checked at the door. */
async function requireOwner(request: FastifyRequest): Promise<void> {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  if (auth.role !== 'owner') {
    throw new AppError('FORBIDDEN', CATALOGUE_WRITER_MESSAGE);
  }
}

/** A path id that is not even a uuid names a row that cannot exist; no need to let pg say so. */
function uuidParam(request: FastifyRequest): string {
  const id = (request.params as Record<string, string | undefined>).id ?? '';
  if (!uuid.safeParse(id).success) {
    throw new AppError('NOT_FOUND', "We couldn't find that.");
  }
  return id;
}

function ifMatchVersion(request: FastifyRequest): number {
  const raw = request.headers['if-match'];
  const text = Array.isArray(raw) ? raw[0] : raw;
  const version = Number(text);
  if (text === undefined || !Number.isInteger(version) || version < 1) {
    throw new AppError(
      'VALIDATION_FAILED',
      'This change did not say which version of the record it is editing — reload and try again.',
    );
  }
  return version;
}

export const catalogRoutes: FastifyPluginAsync = async (app) => {
  const service = createCatalogService();

  app.get(
    '/v1/products',
    {
      preHandler: app.requireAuth,
      config: { responseSchema: z.array(ProductSchema) },
    },
    async () => service.listProducts(),
  );

  app.post(
    '/v1/products',
    {
      preHandler: [app.requireAuth, requireOwner],
      config: { responseSchema: ProductSchema },
    },
    async (request) => {
      const body = productCreateRequestSchema.parse(request.body);
      return service.createProduct({
        sku: body.sku,
        name: body.name,
        category: body.category,
        brand: body.brand ?? null,
        modelNumber: body.modelNumber ?? null,
        capacityLabel: body.capacityLabel ?? null,
        unit: body.unit ?? null,
        defaultPrice: body.defaultPrice ?? null,
        warrantyMonths: body.warrantyMonths ?? null,
      });
    },
  );

  app.patch(
    '/v1/products/:id',
    {
      preHandler: [app.requireAuth, requireOwner],
      config: { responseSchema: ProductSchema },
    },
    async (request) => {
      const ifMatch = ifMatchVersion(request);
      const body = productPatchRequestSchema.parse(request.body);
      return service.patchProduct(uuidParam(request), ifMatch, body);
    },
  );

  app.get(
    '/v1/services',
    {
      preHandler: app.requireAuth,
      config: { responseSchema: z.array(ServiceSchema) },
    },
    async () => service.listServices(),
  );

  app.post(
    '/v1/services',
    {
      preHandler: [app.requireAuth, requireOwner],
      config: { responseSchema: ServiceSchema },
    },
    async (request) => {
      const body = serviceCreateRequestSchema.parse(request.body);
      return service.createService({
        code: body.code,
        name: body.name,
        description: body.description ?? null,
        defaultCharge: body.defaultCharge ?? null,
      });
    },
  );

  app.patch(
    '/v1/services/:id',
    {
      preHandler: [app.requireAuth, requireOwner],
      config: { responseSchema: ServiceSchema },
    },
    async (request) => {
      const ifMatch = ifMatchVersion(request);
      const body = servicePatchRequestSchema.parse(request.body);
      return service.patchService(uuidParam(request), ifMatch, body);
    },
  );
};
