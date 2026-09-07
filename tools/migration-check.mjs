#!/usr/bin/env node
/**
 * Migration gate placeholder, wired by the `migrations` CI job.
 *
 * Real behaviour from T0.2 on: start a clean Postgres 16 (compose
 * service or testcontainers), run the node-pg-migrate set
 * `up → down → up`, and fail the job on any error — down-migrations are
 * never run in production (PLAN-EXECUTION.md Part I) but are how a
 * developer resets locally, and an untested one fails at the worst
 * moment.
 *
 * Until migration 001 exists (T0.2) this is a wiring check that exits 0.
 * The red path of this job is proven by tools/devnull.mjs + the
 * tools/fail-check fixture.
 */
console.log('migration-check: migrations 001-005 are not authored yet (T0.2) — nothing to rehearse.');
console.log('migration-check: from T0.2 on, this gate runs up -> down -> up on a clean Postgres 16 and fails on any error.');
