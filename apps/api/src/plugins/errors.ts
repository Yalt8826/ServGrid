import fp from 'fastify-plugin';
import type { FastifyError, FastifyReply, FastifyRequest } from 'fastify';
import { ZodError, type ZodIssue, type ZodTypeAny } from 'zod';
import { ERROR_HTTP_STATUS, type ErrorCode, type ErrorEnvelope } from '@servgrid/shared';
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
 */

declare module 'fastify' {
  interface FastifyContextConfig {
    responseSchema?: ZodTypeAny;
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
      const schema = request.routeOptions.config.responseSchema;
      if (!schema || reply.statusCode >= 400) return payload;
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
