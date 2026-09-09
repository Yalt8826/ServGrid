-- Migration 002 — enums (PLAN-DATA-MODEL.md §2.1).
-- All eighteen non-contract enum types up front, before any table exists:
-- cheap, and it keeps every value list in one reviewable file instead of
-- scattering them across the migrations that first need them. The three
-- contract types (contract_billing, contract_status, visit_status) land
-- with migration 015.
--
-- The catalogue in §2.1 is the authority for these values; the
-- schema-identity integration suite enumerates pg_enum and diffs it
-- against that list, so a typo surfaces here rather than as a 500 in
-- Phase 3.
--
-- Adding a value is a safe expand step; removing one is a contract step
-- (PLAN-EXECUTION.md Part I §1). That asymmetry is why
-- cancellation_reason is generous up front — an unused value costs
-- nothing, a missing one costs a release cycle.
--
-- EXCEPT: collection_mode and payment_mode. These two are load-bearing,
-- not descriptive. v_employee_expected_cash (migration 012) filters on
-- the literal 'cash' in both to decide whether money enters the cash
-- reconciliation — everything else lands in the company account and
-- never passes through anyone's hands. If either enum ever gains another
-- value that represents physical currency, that view must change with
-- it. This is the one enum change in this schema that is not
-- automatically safe.

-- The whole permission matrix keys off this (packages/shared).
CREATE TYPE employee_role AS ENUM
  ('owner', 'dispatcher', 'technician', 'sales_rep');

-- Job lifecycle; transitions live in PLAN-BACKEND.md §6.1. en_route is
-- skippable.
CREATE TYPE job_status AS ENUM
  ('unassigned', 'assigned', 'en_route', 'in_progress', 'completed', 'cancelled');

-- urgent is the only value that overrides the notification work-window
-- suppression.
CREATE TYPE job_priority AS ENUM ('low', 'normal', 'high', 'urgent');

-- 'other' requires reason_note (CHECK on job_cancellations, migration 007).
CREATE TYPE cancellation_reason AS ENUM
  ('customer_unavailable', 'customer_cancelled', 'duplicate', 'wrong_details',
   'no_access', 'parts_unavailable', 'rescheduled_by_office',
   'contract_cancelled', 'other');

-- Append-only job_events; new values are additive and safe.
CREATE TYPE job_event_type AS ENUM
  ('created', 'assigned', 'reassigned', 'status_changed', 'rescheduled',
   'completed', 'completion_amended', 'cancelled', 'attachment_added',
   'stack_updated');

-- 'system' covers the contract-visit generator.
CREATE TYPE event_source AS ENUM ('mobile', 'web', 'system');

-- LOAD-BEARING — see the header comment: only 'cash' reaches
-- v_employee_expected_cash.
CREATE TYPE collection_mode AS ENUM ('cash', 'upi', 'card', 'bank_transfer', 'none');

-- Same cash rule as collection_mode. No 'none' — a payment of nothing is
-- not a payment.
CREATE TYPE payment_mode AS ENUM ('cash', 'upi', 'card', 'cheque', 'bank_transfer');

CREATE TYPE payment_status AS ENUM ('collected', 'void');

-- Only 'confirmed' moves a company balance.
CREATE TYPE sales_card_status AS ENUM ('draft', 'confirmed', 'void');

CREATE TYPE product_category AS ENUM ('ups', 'battery', 'inverter', 'accessory', 'spare');

CREATE TYPE attachment_owner_type AS ENUM
  ('job_card', 'job_completion', 'payment', 'sales_card', 'customer',
   'employee', 'service_contract');

-- 'signature' is a photo of a paper docket, not a drawing (§3.6).
CREATE TYPE attachment_kind AS ENUM ('photo', 'signature', 'document');

-- 'confirmed' blocks completion amendment until reopened.
CREATE TYPE reconciliation_status AS ENUM ('submitted', 'confirmed', 'disputed');

-- 'manual' is the descope path's check-in.
CREATE TYPE ping_source AS ENUM ('scheduled', 'on_demand', 'live', 'manual');

CREATE TYPE location_request_mode AS ENUM ('fix', 'live');

-- Anything but 'background' resolves the tracking-health chip to
-- permission_missing.
CREATE TYPE device_location_permission AS ENUM ('none', 'foreground', 'background');

-- Single-valued today; the type exists so a second consent kind never
-- needs a migration on a text column.
CREATE TYPE consent_kind AS ENUM ('location_tracking');
