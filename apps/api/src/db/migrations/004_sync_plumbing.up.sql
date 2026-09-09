-- Migration 004 — sync_plumbing (PLAN-DATA-MODEL.md §3.9).
-- idempotency_keys, sequences + next_in_sequence().
--
-- Both tables serve the offline-first client: writes queue on the
-- handset and replay against the API, so the server must make a replayed
-- request harmless and give every business record a number no other
-- device can hand out twice.

-- -----------------------------------------------------------------------
-- idempotency_keys — one row per (employee, key) replay attempt.
--
-- The PK is scoped by employee so a client-generated UUID collision
-- across devices cannot cross-contaminate two people's submissions.
-- request_hash is the sha256 hex of the canonical body: the same key
-- replayed with a different body is a client bug and must be a 422, not
-- a silent replay of the old response. locked_at marks a claim whose
-- request is still in flight — a concurrent duplicate gets 409 with a
-- retry-after, not a half-written response. response_status/_body fill
-- in once the endpoint finishes, which is why they are nullable while
-- locked_at is not: a row with a NULL response is a replay in progress.
--
-- Not a mutable business table: no is_active, no version, no
-- touch_updated_at trigger — rows are written by the sync middleware,
-- read back on replay, pruned wholesale past expires_at. The tombstone
-- protocol (§6) does not apply; expiry is the delete.
-- -----------------------------------------------------------------------
CREATE TABLE idempotency_keys (
  employee_id     uuid NOT NULL REFERENCES employees(id),
  key             text NOT NULL,
  endpoint        text NOT NULL,
  request_hash    text NOT NULL, -- sha256 hex of the canonical request body
  response_status integer,
  response_body   jsonb,
  locked_at       timestamptz,
  created_at      timestamptz NOT NULL DEFAULT now(),
  expires_at      timestamptz NOT NULL DEFAULT now() + interval '30 days',
  CONSTRAINT idempotency_keys_pk PRIMARY KEY (employee_id, key)
);

-- The nightly prune walks expires_at; without this index it is a scan.
CREATE INDEX idempotency_keys_expires_at_idx ON idempotency_keys (expires_at);

-- -----------------------------------------------------------------------
-- sequences — per-scope business counters.
--
-- scope carries the prefix AND the fiscal year: 'job:2627', 'sale:2627',
-- 'payment:2627', 'contract:2627' render as JC-2627-00042 — 2627 is FY
-- 2026–27, the numeric part zero-padded to five digits. The padding and
-- prefix live in the formatting layer; this table stores bare integers.
-- Deliberately not a Postgres SEQUENCE: a sequence cannot reset per
-- fiscal year and cannot carry a prefix, while a new scope row is the
-- reset — the first job of FY 2027–28 implicitly creates 'job:2628'.
--
-- No gap-free guarantee: a rolled-back transaction still consumes a
-- value, and a gap in job numbers harms nothing. Gaps would cost either
-- an explicit lock serialising every allocation or a gap-repair table
-- both of which buy nothing the business asked for.
-- -----------------------------------------------------------------------
CREATE TABLE sequences (
  scope         text NOT NULL,
  current_value bigint NOT NULL,
  updated_at    timestamptz NOT NULL DEFAULT now(),
  CONSTRAINT sequences_pk PRIMARY KEY (scope)
);

-- next_in_sequence(p_scope): the allocation primitive. One atomic
-- statement — INSERT ... ON CONFLICT DO UPDATE ... RETURNING — so two
-- devices allocating concurrently line up on the tuple lock inside the
-- upsert and each walks away with a distinct value. No explicit SELECT
-- ... FOR UPDATE plus UPDATE rewrite: the atomicity is the point, and
-- the concurrency suite (test/integration/sequences.test.ts) fails if
-- anyone splits it. First call for a scope inserts current_value = 1 —
-- that implicit creation is the fiscal-year rollover path
-- (PLAN-DATA-MODEL.md §9 open item 5).
CREATE OR REPLACE FUNCTION next_in_sequence(p_scope text) RETURNS bigint
  LANGUAGE sql AS $$
  INSERT INTO sequences AS s (scope, current_value) VALUES (p_scope, 1)
  ON CONFLICT (scope) DO UPDATE
    SET current_value = s.current_value + 1, updated_at = now()
  RETURNING current_value;
$$;
