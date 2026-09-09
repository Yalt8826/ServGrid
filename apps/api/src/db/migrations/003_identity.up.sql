-- Migration 003 — identity (PLAN-DATA-MODEL.md §3.1).
-- employees, devices, refresh_tokens, consents.
--
-- Owner-created accounts only: no self-registration, no email, no
-- password reset flow — 14 people, the owner resets it. employees,
-- devices and refresh_tokens are mutable, so each carries
-- version/created_at/updated_at and the touch_updated_at trigger
-- (migration 001); consents is append-only evidence and deliberately
-- carries none of that plumbing (see its comment below).

-- -----------------------------------------------------------------------
-- employees
--
-- username is citext, so uniqueness is case-insensitive, but the shape
-- CHECK keeps the stored value lowercase-ASCII. The cast to text is
-- load-bearing: citext defines a case-insensitive ~ operator, so a bare
-- `username ~ ...` would accept 'Ravi.K'. must_change_password defaults
-- true so the owner can hand over a temporary credential.
-- -----------------------------------------------------------------------
CREATE TABLE employees (
  id                   uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  username             citext NOT NULL,
  CONSTRAINT employees_username_unique UNIQUE (username),
  CONSTRAINT employees_username_shape CHECK (username::text ~ '^[a-z0-9._-]{3,32}$'),
  password_hash        text NOT NULL, -- argon2id encoded, never a raw password
  full_name            text NOT NULL,
  phone                text,
  role                 employee_role NOT NULL,
  is_active            boolean NOT NULL DEFAULT true, -- soft delete, never DELETE
  must_change_password boolean NOT NULL DEFAULT true,
  created_by           uuid REFERENCES employees(id), -- NULL for the seeded owner
  last_login_at        timestamptz,
  created_at           timestamptz NOT NULL DEFAULT now(),
  updated_at           timestamptz NOT NULL DEFAULT now(),
  version              integer NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------
-- devices — one row per install.
--
-- The four diagnostics (location_permission, battery_opt_exempt,
-- autostart_confirmed, notifications_enabled) are not decoration:
-- PLAN.md §11 names OEM task-killing as the dominant risk, and without a
-- per-handset record of which mitigations were completed, a "tracking
-- stopped" report in Phase 5 is unfalsifiable. Defaults are the
-- unconfirmed state — a mitigation counts only once the app has reported
-- it, so a device that never checks in reads as unhealthy rather than
-- silently healthy.
-- -----------------------------------------------------------------------
CREATE TABLE devices (
  id                    uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id           uuid NOT NULL REFERENCES employees(id),
  install_id            text NOT NULL,
  CONSTRAINT devices_employee_install_unique UNIQUE (employee_id, install_id),
  fcm_token             text, -- for "Locate now"; registered after first launch
  manufacturer          text,
  model                 text,
  os_version            text,
  app_version           text,
  location_permission   device_location_permission NOT NULL DEFAULT 'none',
  battery_opt_exempt    boolean NOT NULL DEFAULT false,
  autostart_confirmed   boolean NOT NULL DEFAULT false,
  notifications_enabled boolean NOT NULL DEFAULT false,
  last_seen_at          timestamptz,
  is_active             boolean NOT NULL DEFAULT true,
  created_at            timestamptz NOT NULL DEFAULT now(),
  updated_at            timestamptz NOT NULL DEFAULT now(),
  version               integer NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------
-- refresh_tokens
--
-- token_hash is the sha256 hex of the opaque token; the raw token exists
-- only on the handset. Rotation on every use: the old row gets
-- revoked_at and replaced_by. Reuse of a revoked token revokes the whole
-- chain — cheap detection of a stolen token on a shared handset.
-- -----------------------------------------------------------------------
CREATE TABLE refresh_tokens (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  token_hash  text NOT NULL,
  CONSTRAINT refresh_tokens_token_hash_unique UNIQUE (token_hash),
  employee_id uuid NOT NULL REFERENCES employees(id),
  device_id   uuid REFERENCES devices(id),
  issued_at   timestamptz NOT NULL DEFAULT now(),
  expires_at  timestamptz NOT NULL,
  revoked_at  timestamptz,
  replaced_by uuid REFERENCES refresh_tokens(id),
  user_agent  text,
  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);

-- -----------------------------------------------------------------------
-- consents — the DPDP Act evidence trail (PLAN.md §7).
--
-- version is the consent text's version, a date string: a reworded
-- consent screen ships as a new version and forces re-acceptance.
-- Re-acceptance INSERTs a new row for the new version; the UNIQUE
-- constraint keeps one acceptance per (employee, kind, version).
--
-- Deliberately NOT a mutable table: the rows are evidence and nothing
-- updates them, so there is no updated_at and no touch_updated_at
-- trigger — and there has to be no optimistic-concurrency version
-- counter either, because §3.1 gives the name `version` to the date
-- string, and the trigger's `NEW.version := OLD.version + 1` would
-- explode on it at the first UPDATE. (job_events follows the same
-- append-only shape: no version counter, its own timestamps.)
-- -----------------------------------------------------------------------
CREATE TABLE consents (
  id          uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id uuid NOT NULL REFERENCES employees(id),
  kind        consent_kind NOT NULL,
  version     text NOT NULL, -- the consent text's version, a date string
  CONSTRAINT consents_version_is_date CHECK (version::text ~ '^\d{4}-\d{2}-\d{2}$'),
  accepted_at timestamptz NOT NULL DEFAULT now(),
  device_id   uuid REFERENCES devices(id),
  ip_address  inet,
  CONSTRAINT consents_employee_kind_version_unique UNIQUE (employee_id, kind, version)
);

-- touch_updated_at on every mutable table (PLAN-DATA-MODEL.md §2), with
-- the WHEN clause from migration 001: the trigger stays out of the hot
-- path whenever the caller supplied updated_at deliberately. consents is
-- append-only evidence, not mutable — see its comment above.
CREATE TRIGGER employees_touch BEFORE UPDATE ON employees
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER devices_touch BEFORE UPDATE ON devices
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

CREATE TRIGGER refresh_tokens_touch BEFORE UPDATE ON refresh_tokens
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();
