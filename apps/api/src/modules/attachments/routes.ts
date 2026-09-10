import type { FastifyPluginAsync, FastifyRequest } from 'fastify';
import multipart from '@fastify/multipart';
import { z } from 'zod';
import { isoDateTime, uuid } from '@servgrid/shared';
import { UNAUTHENTICATED_MESSAGE } from '../../plugins/auth.js';
import { AppError } from '../../plugins/errors.js';
import type { StorageConfig } from '../../lib/storage.js';
import { UPLOAD_BODY_LIMIT_BYTES, MAX_UPLOAD_BYTES, uploadHashPayload, createAttachmentsService, type Actor, type ParsedUpload } from './service.js';
import type { AttachmentKind, AttachmentOwnerType } from './repo.js';

/**
 * Attachments routes (PLAN-BACKEND.md §9):
 *
 *   POST /v1/attachments   — one multipart request: file + ownerType +
 *                            ownerId + kind + capturedAt + fileChecksum,
 *                            guarded by the Idempotency-Key the handset
 *                            minted at enqueue.
 *   GET  /v1/attachments/:id — permission check, then 302 to a
 *                            five-minute presigned URL. Never proxied.
 *
 * Ordering is load-bearing: `preHandler: [requireAuth, parseUpload]`
 * runs both BEFORE the idempotency plugin appends its claim preHandler,
 * so by the time the key is claimed the multipart body is fully parsed —
 * the claim hashes the parsed `fileChecksum`-based payload (§9), an
 * aborted upload never leaves a claim row behind, and a malformed one
 * never burns the key. The claim then wraps the handler in the request
 * transaction, so the INSERT and the stored response commit together.
 */

/** The DB enum `attachment_owner_type` (migration 002), as the wire spells it. */
const OWNER_TYPES: readonly AttachmentOwnerType[] = [
  'job_card',
  'job_completion',
  'payment',
  'sales_card',
  'customer',
  'employee',
  'service_contract',
];
const KINDS: readonly AttachmentKind[] = ['photo', 'signature', 'document'];

/** Form fields of the multipart upload (§9) — validated before the claim so a bad body never takes a key. */
const uploadFieldsSchema = z
  .object({
    ownerType: z.enum(OWNER_TYPES as unknown as [AttachmentOwnerType, ...AttachmentOwnerType[]]),
    ownerId: uuid,
    kind: z.enum(KINDS as unknown as [AttachmentKind, ...AttachmentKind[]]),
    capturedAt: isoDateTime,
    fileChecksum: z
      .string()
      .regex(/^[0-9a-fA-F]{64}$/, 'fileChecksum must be hex sha256')
      .transform((s) => s.toLowerCase()),
    caption: z.string().min(1).max(1000).optional(),
  })
  .strict();

/** The created attachment — the exact shape of `Attachment` in packages/shared (domain.ts). */
export const attachmentResponseSchema = z
  .object({
    id: uuid,
    ownerType: z.enum(OWNER_TYPES as unknown as [AttachmentOwnerType, ...AttachmentOwnerType[]]),
    ownerId: uuid,
    kind: z.enum(KINDS as unknown as [AttachmentKind, ...AttachmentKind[]]),
    storageKey: z.string().min(1),
    mimeType: z.string().min(1),
    sizeBytes: z.number().int().nonnegative(),
    width: z.number().int().positive().nullable(),
    height: z.number().int().positive().nullable(),
    checksumSha256: z.string().regex(/^[0-9a-f]{64}$/),
    caption: z.string().max(1000).nullable(),
    uploadedBy: uuid,
    capturedAt: z.string().nullable(),
    uploadedAt: z.string(),
  })
  .strict();

declare module 'fastify' {
  interface FastifyRequest {
    /** Set by parseUpload before the idempotency claim; read by the hash payload and the handler. */
    attachmentsUpload: ParsedUpload | null;
  }
}

function actorOf(request: FastifyRequest): Actor {
  const auth = request.auth;
  if (!auth) throw new AppError('UNAUTHENTICATED', UNAUTHENTICATED_MESSAGE);
  return { id: auth.sub, role: auth.role };
}

/** A path id that is not even a uuid names a row that cannot exist (same rule as jobs). */
function attachmentIdParam(request: FastifyRequest): string {
  const id = (request.params as { id?: string }).id ?? '';
  if (!/^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i.test(id)) {
    throw new AppError('NOT_FOUND', "We couldn't find that attachment.");
  }
  return id;
}

export interface AttachmentsRoutesOptions {
  s3: StorageConfig;
}

export const attachmentsRoutes: FastifyPluginAsync<AttachmentsRoutesOptions> = async (app, opts) => {
  app.decorateRequest('attachmentsUpload', null);
  await app.register(multipart, {
    // The size the handler enforces anyway, cut at the stream level so an
    // oversized part is never fully buffered; `files: 2` lets a second
    // file part surface (and be refused with a clear error) instead of
    // the stream dying mid-parse with a parser artifact.
    limits: { fileSize: MAX_UPLOAD_BYTES, files: 2 },
  });

  const service = createAttachmentsService(opts.s3);

  /**
   * Collect exactly one file and the §9 fields. Runs after requireAuth
   * and before the idempotency claim (see module header) — so it must
   * not do slow or remote work, only parse and validate.
   */
  async function parseUpload(request: FastifyRequest): Promise<void> {
    const fields: Record<string, string> = {};
    let file: Buffer | undefined;
    let truncated = false;

    for await (const part of request.parts()) {
      if (part.type === 'file') {
        if (file !== undefined) {
          throw new AppError('VALIDATION_FAILED', 'Attach one file per upload.');
        }
        file = await part.toBuffer();
        // Set when busboy cut the stream at the fileSize limit — only
        // knowable once the part has been consumed.
        if (part.file.truncated) truncated = true;
      } else if (typeof part.value === 'string') {
        fields[part.fieldname] = part.value;
      }
    }

    if (file === undefined) {
      throw new AppError('VALIDATION_FAILED', 'Attach the file to upload.');
    }

    let parsed: z.infer<typeof uploadFieldsSchema>;
    try {
      parsed = uploadFieldsSchema.parse(fields);
    } catch (error) {
      // Same refusal the errors plugin would give a bad JSON body — but
      // here the issues name the multipart field, which is what the
      // sender can fix.
      if (error instanceof z.ZodError) {
        throw new AppError('VALIDATION_FAILED', 'Some of the upload details are missing or malformed.', {
          issues: error.issues.map((issue) => ({ path: issue.path.join('.'), message: issue.message })),
        });
      }
      throw error;
    }

    request.attachmentsUpload = {
      ...parsed,
      caption: parsed.caption ?? null,
      file,
      truncated,
    };
  }

  /** §9's multipart request_hash input, read once the body is parsed. */
  function requestHashPayload(request: FastifyRequest): string {
    const upload = request.attachmentsUpload;
    if (upload === null) {
      // Unreachable: parseUpload runs before the claim that reads this.
      throw new AppError('VALIDATION_FAILED', 'Upload details missing.');
    }
    return uploadHashPayload(upload);
  }

  app.post(
    '/v1/attachments',
    {
      preHandler: [app.requireAuth, parseUpload],
      // Cap + multipart framing slack: anything larger dies in the
      // content-type parser as a 413, before the handler and before any
      // bytes are stored (§9: 20 MB → 413).
      bodyLimit: UPLOAD_BODY_LIMIT_BYTES,
      config: {
        responseSchema: attachmentResponseSchema,
        idempotencyRequestHashPayload: requestHashPayload,
      },
    },
    async (request) => {
      const upload = request.attachmentsUpload;
      if (upload === null) {
        // Unreachable: parseUpload precedes this handler in the chain.
        throw new AppError('VALIDATION_FAILED', 'Upload details missing.');
      }
      return service.upload(actorOf(request), upload);
    },
  );

  app.get(
    '/v1/attachments/:id',
    { preHandler: app.requireAuth },
    async (request, reply) => {
      const { url } = await service.readUrl(actorOf(request), attachmentIdParam(request));
      // §9: a 302 to the presigned URL — status and Location only, no
      // body, and nothing cacheable (the URL outlives its usefulness in
      // five minutes and must not outlive it in anyone's cache).
      reply.status(302);
      reply.header('location', url);
      reply.header('cache-control', 'private, no-store');
      // No return value: Fastify sends the empty body a redirect should
      // have (returning null would serialise the text "null").
    },
  );
};
