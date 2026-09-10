import { createHash, createHmac } from 'node:crypto';

/**
 * S3-compatible storage (PLAN-BACKEND.md §2 lib/storage.ts, §9). MinIO
 * locally and on the VPS. Requests are signed with AWS SigV4 over plain
 * `fetch` — a few dozen lines against a stable spec, versus the SDK's
 * dependency tree for the handful of verbs this API ever uses.
 *
 * T0.6 ships the signer and the reachability probe `/healthz` stands on.
 * T1.10 adds the attachment half (`putObject`, `presignedGetUrl`) on the
 * same `signedRequest` core — plus presigning, which is query-string
 * SigV4: the signature goes in the URL rather than an Authorization
 * header, so the client the URL is minted for needs no credentials.
 */

export interface StorageConfig {
  endpoint: string;
  bucket: string;
  accessKeyId: string;
  secretAccessKey: string;
  region: string;
}

const EMPTY_SHA256 = createHash('sha256').update('').digest('hex');

function sha256Hex(data: string | Uint8Array): string {
  return createHash('sha256').update(data).digest('hex');
}

function hmac(key: string | Buffer, data: string): Buffer {
  return createHmac('sha256', key).update(data, 'utf8').digest();
}

/** RFC 3986 encoding, as SigV4 requires (encodeURIComponent leaves !'()* alone). */
function uriEncode(value: string, encodeSlash: boolean): string {
  const encoded = encodeURIComponent(value).replace(
    /[!'()*]/g,
    (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`,
  );
  return encodeSlash ? encoded : encoded.replace(/%2F/g, '/');
}

function amzDate(now: Date): { dateTime: string; date: string } {
  const dateTime = now.toISOString().replace(/[:-]|\.\d{3}/g, '');
  return { dateTime, date: dateTime.slice(0, 8) };
}

export interface SignedRequestInit {
  method: 'GET' | 'PUT' | 'HEAD' | 'DELETE';
  /** Path relative to the endpoint, e.g. `/bucket/key`. */
  path: string;
  query?: Record<string, string>;
  body?: Uint8Array;
  headers?: Record<string, string>;
  signal?: AbortSignal;
  now?: Date;
}

/** Path-style addressing: MinIO's default, and it needs no wildcard DNS. */
export function signedRequest(config: StorageConfig, init: SignedRequestInit): Promise<Response> {
  const url = new URL(config.endpoint);
  url.pathname = init.path
    .split('/')
    .map((segment) => uriEncode(segment, true))
    .join('/');
  const query = Object.entries(init.query ?? {}).sort(([a], [b]) => (a < b ? -1 : a > b ? 1 : 0));
  const canonicalQuery = query
    .map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`)
    .join('&');
  url.search = canonicalQuery;

  const { dateTime, date } = amzDate(init.now ?? new Date());
  const payloadHash = init.body ? sha256Hex(init.body) : EMPTY_SHA256;
  const headers: Record<string, string> = {
    ...Object.fromEntries(
      Object.entries(init.headers ?? {}).map(([k, v]) => [k.toLowerCase(), v.trim()]),
    ),
    host: url.host,
    'x-amz-content-sha256': payloadHash,
    'x-amz-date': dateTime,
  };
  const signedHeaderNames = Object.keys(headers).sort();
  const canonicalHeaders = signedHeaderNames.map((k) => `${k}:${headers[k]}\n`).join('');
  const signedHeaders = signedHeaderNames.join(';');

  const canonicalRequest = [
    init.method,
    url.pathname,
    canonicalQuery,
    canonicalHeaders,
    signedHeaders,
    payloadHash,
  ].join('\n');

  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  const { host: _host, ...sendHeaders } = headers;
  sendHeaders.authorization =
    `AWS4-HMAC-SHA256 Credential=${config.accessKeyId}/${scope}, ` +
    `SignedHeaders=${signedHeaders}, Signature=${signature}`;

  return fetch(url, {
    method: init.method,
    headers: sendHeaders,
    body: init.body as RequestInit['body'],
    signal: init.signal,
  });
}

export interface StorageProbe {
  ok: boolean;
  /** Present when `ok` is false — the log line, not a user-facing message. */
  detail?: string;
}

/** The outcome of a single object write. `detail` is for the log, never the client. */
export interface PutObjectResult {
  ok: boolean;
  status: number;
  detail?: string;
}

/**
 * PUT the bytes at `key` (§9: attachments write to
 * `{ownerType}/{yyyy}/{mm}/{uuid}.{ext}`). The object's Content-Type
 * rides the PUT so a presigned GET answers with the right type — the
 * owner's browser renders the image instead of offering a download.
 */
export async function putObject(
  config: StorageConfig,
  key: string,
  body: Uint8Array,
  contentType: string,
): Promise<PutObjectResult> {
  let res: Response;
  try {
    res = await signedRequest(config, {
      method: 'PUT',
      path: `/${config.bucket}/${key}`,
      body,
      headers: { 'content-type': contentType },
    });
  } catch (error) {
    return { ok: false, status: 0, detail: error instanceof Error ? error.message : String(error) };
  }
  if (res.ok) return { ok: true, status: res.status };
  const text = await res.text().catch(() => '');
  return { ok: false, status: res.status, detail: `storage PUT answered HTTP ${res.status}: ${text.slice(0, 200)}` };
}

/**
 * A presigned GET URL (§9: `GET /v1/attachments/:id` answers 302 with
 * one of these; the API never proxies the bytes). Query-string SigV4:
 * the same canonical request as `signedRequest` but with the signature
 * in `X-Amz-Signature`, `UNSIGNED-PAYLOAD` in place of a body hash (the
 * bytes flow browser→MinIO, not through this signature), and
 * `X-Amz-Expires` instead of a signed header date window. MinIO enforces
 * the expiry at download time.
 */
export function presignedGetUrl(
  config: StorageConfig,
  key: string,
  expiresSeconds: number,
  now: Date = new Date(),
): string {
  const url = new URL(config.endpoint);
  url.pathname = `/${config.bucket}/${key}`
    .split('/')
    .map((segment) => uriEncode(segment, true))
    .join('/');

  const { dateTime, date } = amzDate(now);
  // Query parameters must be in canonical (sorted) order for the
  // signature to verify; these five names already sort into place.
  const query: Array<[string, string]> = [
    ['X-Amz-Algorithm', 'AWS4-HMAC-SHA256'],
    ['X-Amz-Credential', `${config.accessKeyId}/${date}/${config.region}/s3/aws4_request`],
    ['X-Amz-Date', dateTime],
    ['X-Amz-Expires', String(expiresSeconds)],
    ['X-Amz-SignedHeaders', 'host'],
  ];
  const canonicalQuery = query
    .map(([k, v]) => `${uriEncode(k, true)}=${uriEncode(v, true)}`)
    .join('&');

  const canonicalRequest = [
    'GET',
    url.pathname,
    canonicalQuery,
    `host:${url.host}\n`,
    'host',
    'UNSIGNED-PAYLOAD',
  ].join('\n');

  const scope = `${date}/${config.region}/s3/aws4_request`;
  const stringToSign = ['AWS4-HMAC-SHA256', dateTime, scope, sha256Hex(canonicalRequest)].join('\n');
  const kDate = hmac(`AWS4${config.secretAccessKey}`, date);
  const kRegion = hmac(kDate, config.region);
  const kService = hmac(kRegion, 's3');
  const kSigning = hmac(kService, 'aws4_request');
  const signature = hmac(kSigning, stringToSign).toString('hex');

  url.search = `${canonicalQuery}&X-Amz-Signature=${signature}`;
  return url.toString();
}

/**
 * Reachability + credentials in one round trip: a signed ListBuckets.
 * A connection failure, a timeout and a 403 all read as "down", because
 * every one of them is an attachment upload failing at 09:00 (§13).
 */
export async function probeStorage(
  config: StorageConfig,
  timeoutMs = 2_000,
): Promise<StorageProbe> {
  try {
    const res = await signedRequest(config, {
      method: 'GET',
      path: '/',
      signal: AbortSignal.timeout(timeoutMs),
    });
    if (res.ok) return { ok: true };
    return { ok: false, detail: `storage responded HTTP ${res.status}` };
  } catch (error) {
    return { ok: false, detail: error instanceof Error ? error.message : String(error) };
  }
}
