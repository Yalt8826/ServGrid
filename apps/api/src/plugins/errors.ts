import fp from 'fastify-plugin';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodIssue, type ZodTypeAny } from 'zod';
import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorEnvelope, type Role } from '@servgrid/shared';
import { responseValidationEnabled, type NodeEnv } from '../config.js';

/**
 * Error envelope (PLAN-BACKEND.md §3.1) — one shape, always. `message`
 * is written for the technician holding the phone: the offline conflict
 * banner shows it verbatim, so it says what happened, not what failed.
 *
 * Also the response-validation hook (§3.4): routes attach a zod schema
 * as `config.responseSchema`, and outside production every 2xx payload
 * is asserted against it before serialisation. Use `.strict()` schemas —
 * the check is an assertion, never a transform, so an unknown key must
 * be a failure rather than something zod quietly drops.
 *
 * Routes whose payload depends on the actor's role (§6.3: one job card
 * shape per role) attach `config.responseSchemaByRole` instead — a map
 * from role to schema, and the hook asserts against the actor's entry.
 * Three separate schemas, one asserted per response: a payload that
 * carries a field another role's shape forbids fails its own schema.
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    responseSchema?: ZodTypeAny;
    /** Per-role response shapes (§6.3); the hook asserts the actor's entry and nothing else. */
    responseSchemaByRole?: Partial<Record<Role, ZodTypeAny>>;
  }
}

/** A refusal the client can act on. `message` is user-facing and shown verbatim. */
export class AppError extends Error {
  readonly status: number;

  constructor(
    readonly code: ErrorCode,
    message: string,
    readonly details?: unknown,
  ) {
    super(message);
    this.name = 'AppError';
    this.status = ERROR_HTTP_STATUS[code];
  }
}

/** A handler produced a payload its own schema rejects — a server bug, surfaced as 500. */
export class ResponseValidationError extends Error {
  constructor(
    readonly route: string,
    readonly issues: readonly ZodIssue[],
  ) {
    super(`response for ${route} failed schema validation`);
    this.name = 'ResponseValidationError';
  }
}

/** Generic wording for the cases no handler got to phrase. */
export const GENERIC_MESSAGES = {
  NOT_FOUND: "We couldn't find that. It may have been removed since you last synced.",
  VALIDATION_FAILED: "Some of the details don't look right. Check the form and try again.",
  INTERNAL: 'Something went wrong on our side. Nothing was lost — try again in a moment.',
} as const satisfies Partial<Record<ErrorCode, string>>;

/** §9: the size cap refusal — says the limit, because the fix is shrinking the file. */
export const PAYLOAD_TOO_LARGE_MESSAGE =
  'That file is too large to upload. The limit is 15 MB — attach a smaller one.';

function isZodError(error: unknown): error is ZodError {
  return (
    error instanceof ZodError ||
    (typeof error === 'object' &&
      error !== null &&
      (error as { name?: unknown }).name === 'ZodError' &&
      Array.isArray((error as { issues?: unknown }).issues))
  );
}

function issueSummary(issues: readonly ZodIssue[]): Array<{ path: string; message: string; code: string }> {
  return issues.map((issue) => ({
    path: issue.path.join('.'),
    message: issue.message,
    code: issue.code,
  }));
}

function envelope(code: ErrorCode, message: string, requestId: string, details?: unknown): ErrorEnvelope {
  return { error: details === undefined ? { code, message, requestId } : { code, message, details, requestId } };
}

function send(reply: FastifyReply, code: ErrorCode, message: string, details?: unknown): FastifyReply {
  return reply
    .status(ERROR_HTTP_STATUS[code])
    .type('application/json; charset=utf-8')
    .send(envelope(code, message, reply.request.id, details));
}

function handleError(error: unknown, request: FastifyRequest, reply: FastifyReply): FastifyReply {
  if (error instanceof AppError) {
    request.log.info({ code: error.code, details: error.details }, error.message);
    return send(reply, error.code, error.message, error.details);
  }

  if (isZodError(error)) {
    return send(reply, 'VALIDATION_FAILED', GENERIC_MESSAGES.VALIDATION_FAILED, {
      issues: issueSummary(error.issues),
    });
  }

  if (error instanceof ResponseValidationError) {
    // The leak is the finding; log everything, send the client only the shape of it.
    request.log.error({ err: error, issues: error.issues }, 'response failed schema validation');
    return send(reply, 'INTERNAL', GENERIC_MESSAGES.INTERNAL, {
      issues: issueSummary(error.issues),
    });
  }

  const status = (error as Partial<FastifyError>).statusCode;
  if (typeof status === 'number' && status >= 400 && status < 500) {
    // Fastify's own client errors: bad JSON, oversized body, unsupported media type.
    if (status === 404) return send(reply, 'NOT_FOUND', GENERIC_MESSAGES.NOT_FOUND);
    if (status === 413) {
      // The body limit fires in the content-type parser, before any
      // handler runs — a 20 MB upload must die as a 413 (§9: the client
      // has to learn "too large, do not resend as-is"), not as the
      // generic 422 the branch below would give it.
      request.log.info({ err: error }, 'request body over the limit');
      return send(reply, 'PAYLOAD_TOO_LARGE', PAYLOAD_TOO_LARGE_MESSAGE);
    }
    request.log.info({ err: error }, 'request rejected');
    return send(reply, 'VALIDATION_FAILED', GENERIC_MESSAGES.VALIDATION_FAILED, {
      issues: [{ path: '', message: (error as Error).message ?? 'malformed request', code: 'request' }],
    });
  }

  // Unhandled: full error with stack into the log, none of it into the body.
  request.log.error({ err: error }, 'unhandled error');
  return send(reply, 'INTERNAL', GENERIC_MESSAGES.INTERNAL);
}

export interface ErrorsPluginOptions {
  nodeEnv: NodeEnv;
}

export const errorsPlugin = fp<ErrorsPluginOptions>(
  async (app, opts) => {
    app.setErrorHandler(handleError);
    app.setNotFoundHandler((_request, reply) =>
      send(reply, 'NOT_FOUND', GENERIC_MESSAGES.NOT_FOUND),
    );

    if (!responseValidationEnabled(opts.nodeEnv)) return;

    app.addHook('preSerialization', async (request, reply, payload) => {
      if (reply.statusCode >= 400) return payload;
      const config = request.routeOptions.config;
      let schema: ZodTypeAny | undefined;
      if (config.responseSchemaByRole) {
        const role = request.auth?.role;
        schema = role === undefined ? undefined : config.responseSchemaByRole[role];
        if (!schema) {
          // A per-role route without this actor's shape is a route
          // definition bug: fail loudly rather than letting the payload
          // through unasserted. (Roles the route refuses 403 before any
          // payload never reach this point.)
          throw new Error(
            `responseSchemaByRole has no entry for role ${String(role)} on ` +
              `${request.method} ${request.routeOptions.url ?? request.url}`,
          );
        }
      } else {
        schema = config.responseSchema;
      }
      if (!schema) return payload;
      const result = schema.safeParse(payload);
      if (!result.success) {
        throw new ResponseValidationError(
          `${request.method} ${request.routeOptions.url ?? request.url}`,
          result.error.issues,
        );
      }
      return payload;
    });
  },
  { name: 'errors', fastify: '5.x', dependencies: ['request-context'] },
);
