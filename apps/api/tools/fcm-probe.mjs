#!/usr/bin/env node
/**
 * T0.15 probe: send one data-only FCM message to a device token (the
 * exact message shape apps/api/src/lib/fcm.ts sends — no `notification`
 * key, no job content). No dependencies; Node 22+.
 *
 *   FCM_SERVICE_ACCOUNT=./service-account.json \
 *   node tools/fcm-probe.mjs <device-token> [--data type=data-only-sync]
 *
 * FCM_SERVICE_ACCOUNT accepts the service-account JSON inline or as a
 * file path. Exit 0 = FCM accepted the message; exit 1 = it did not
 * (the JSON result is printed either way — paste it into the issue).
 */
import { createSign } from 'node:crypto';
import { readFileSync } from 'node:fs';

const TOKEN_URL = 'https://oauth2.googleapis.com/token';
const SCOPE = 'https://www.googleapis.com/auth/firebase.messaging';

function fail(message) {
  console.error(`fcm-probe: ${message}`);
  process.exit(1);
}

const args = process.argv.slice(2);
const dataPairs = [];
const positional = [];
for (let i = 0; i < args.length; i++) {
  if (args[i] === '--data') {
    const pair = args[i + 1];
    if (pair === undefined) fail('--data needs a key=value pair');
    dataPairs.push(pair);
    i++;
  } else {
    positional.push(args[i]);
  }
}
const token = positional[0];
if (token === undefined) fail('usage: node tools/fcm-probe.mjs <device-token> [--data k=v ...]');

const raw = process.env.FCM_SERVICE_ACCOUNT;
if (raw === undefined || raw.trim().length === 0) {
  fail('FCM_SERVICE_ACCOUNT is not set (inline JSON or path to the service-account file)');
}
const text = raw.trim().startsWith('{') ? raw : readFileSync(raw, 'utf8');
let sa;
try {
  sa = JSON.parse(text);
} catch {
  fail('FCM_SERVICE_ACCOUNT is not valid JSON');
}
for (const field of ['project_id', 'client_email', 'private_key']) {
  if (typeof sa[field] !== 'string' || sa[field].length === 0) fail(`service account missing "${field}"`);
}

function base64url(input) {
  return Buffer.from(input).toString('base64url');
}

const iat = Math.floor(Date.now() / 1000);
const header = base64url(JSON.stringify({ alg: 'RS256', typ: 'JWT' }));
const claims = base64url(
  JSON.stringify({
    iss: sa.client_email,
    scope: SCOPE,
    aud: TOKEN_URL,
    iat,
    exp: iat + 3600,
  }),
);
const signer = createSign('RSA-SHA256');
signer.update(`${header}.${claims}`);
const assertion = `${header}.${claims}.${signer.sign(sa.private_key).toString('base64url')}`;

const tokenRes = await fetch(TOKEN_URL, {
  method: 'POST',
  headers: { 'Content-Type': 'application/x-www-form-urlencoded' },
  body: new URLSearchParams({ grant_type: 'urn:ietf:params:oauth:grant-type:jwt-bearer', assertion }),
});
if (!tokenRes.ok) {
  console.error(await tokenRes.text());
  fail(`OAuth token exchange failed: HTTP ${tokenRes.status}`);
}
const { access_token: accessToken } = await tokenRes.json();

const data = Object.fromEntries(
  dataPairs.map((pair) => {
    const eq = pair.indexOf('=');
    return eq === -1 ? [pair, ''] : [pair.slice(0, eq), pair.slice(eq + 1)];
  }),
);

// Data-only: the `notification` key stays absent — the app syncs and
// raises its own local notification (PLAN-BACKEND.md §12.1).
const res = await fetch(`https://fcm.googleapis.com/v1/projects/${sa.project_id}/messages:send`, {
  method: 'POST',
  headers: { Authorization: `Bearer ${accessToken}`, 'Content-Type': 'application/json' },
  body: JSON.stringify({ message: { token, data } }),
});
const body = await res.json().catch(() => null);
console.log(
  JSON.stringify({ httpStatus: res.status, ok: res.ok, response: body, sentData: data }, null, 2),
);
process.exit(res.ok ? 0 : 1);
