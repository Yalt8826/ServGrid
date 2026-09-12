-- Migration 011 — assignment notifications (PLAN-BACKEND.md §12.1,
-- PHASE-2-DISPATCHER.md T2.5). Two additions, one concern: the wake the
-- office's mutations send to a technician's handsets, and the record of
-- what became of it.
--
-- 1. devices.failure_reason — §12.1: "FCM failures (UNREGISTERED,
--    SENDER_ID_MISMATCH) clear the stale fcm_token and set failure_reason
--    — a device that cannot be reached is itself a tracking-health
--    finding." The finding lives on the device row, next to the
--    diagnostics the health chip already reads: the failure is a property
--    of the handset, not of the job that happened to expose it. NULL
--    means the last push we attempted went out (or none has); the text is
--    the FCM-level outcome, exactly as location_requests.failure_reason
--    carries the "Locate now" outcome (migration 009).
--
-- 2. held_notifications — PLAN-BACKEND.md §15 item 6, closed as B1
--    (docs/decisions/2026-09-12-phase-2-entry-decisions.md, Memo B):
--    "Hold, don't drop — assignments outside the window are released at
--    window-open (09:00, or immediately if promoted to urgent); urgent
--    bypasses and pushes immediately; in-window assignments push
--    immediately." A row here is a wake the send path held because the
--    IST wall clock was outside WORK_WINDOW_START/END and the job was
--    not urgent. Held ≠ dropped: the window-open release (a batch, one
--    collapsed wake per technician) marks rows released. The row carries
--    the trigger and the priority AT HOLD TIME for audit; it carries no
--    job content, because the released push does not either (§12.1: the
--    message wakes the app, the delta sync brings the rows).
--
--    trigger_kind is TEXT + CHECK rather than a new enum, on purpose: the
--    enum catalogue (PLAN-DATA-MODEL.md §2.1) is pinned by
--    schema-identity.test.ts as the plan's whole truth, and this
--    vocabulary was born after that plan was written (decision B1,
--    2026-09-12). A CHECK guards the boundary without quietly amending
--    the catalogue; if the plan later grows the type, promote it then.

ALTER TABLE devices ADD COLUMN failure_reason text;

CREATE TABLE held_notifications (
  id            uuid                 PRIMARY KEY DEFAULT gen_random_uuid(),
  employee_id   uuid                 NOT NULL REFERENCES employees(id) ON DELETE CASCADE,
  job_card_id   uuid                 REFERENCES job_cards(id) ON DELETE SET NULL,
  trigger_kind  text                 NOT NULL CHECK (trigger_kind IN
                  ('assigned', 'reassigned', 'cancelled', 'priority_escalated')),
  priority      job_priority         NOT NULL,
  held_at       timestamptz          NOT NULL DEFAULT now(),
  released_at   timestamptz
);

-- The release batch reads exactly the unreleased rows, oldest first; the
-- partial index is empty between releases, which is the steady state.
CREATE INDEX held_notifications_unreleased_idx
  ON held_notifications (held_at)
  WHERE released_at IS NULL;
