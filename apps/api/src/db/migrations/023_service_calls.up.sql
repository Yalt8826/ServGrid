-- The service call list (2026-09-17, Yashas): "the ups and batteries need
-- to be serviced every 6 months ... once a job is completed for a customer
-- the dispatcher is reminded of that customer 6 months later that its due
-- for his service".
--
-- Two halves, and the split is the design:
--
--   * The CYCLE is derived. A customer's last completed job is a fact the
--     database already has, and "due six months after that" is arithmetic
--     on it — so it lives in a view, exactly as `v_contracts` derives the
--     AMC reminders and for the same reason (a stored due-date is a fact
--     that drifts the moment a job is filed late, and no cron can forget
--     to run a view).
--   * The PUSH-BACK is stored, because it is a decision and not
--     arithmetic: a dispatcher rang the customer, was told "not now", and
--     moved the reminder three months. Nothing in the data can recover
--     that. `customer_follow_ups` is the record, one row per call, so the
--     history answers "did anyone ring this customer, and what did they
--     say" — which is the question the owner will ask the day a customer
--     says nobody called.
--
-- The reminder is due when the later of the two dates has arrived, and
-- only when nobody is already going to that site: `is_due` excludes a
-- customer with an open job, the same rule `v_contracts.is_visit_due`
-- uses. A customer the office has already booked is not a phone call.
--
-- A follow-up counts only when it was recorded AFTER the last completion:
-- a push-back from a previous cycle is history, and the moment a new job
-- is completed the six months start again from that job.
--
-- `outcome` is text + CHECK rather than an enum: Postgres enums cannot
-- drop a value, and this list is the kind a business edits (a "wrong
-- number" outcome added next month should not need a type migration).
CREATE TABLE customer_follow_ups (
  id            uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  customer_id   uuid NOT NULL REFERENCES customers(id),
  outcome       text NOT NULL CHECK (outcome IN ('called', 'no_answer', 'not_interested', 'scheduled')),
  note          text,
  -- The day to ring again. NULL means "do not remind me about this cycle
  -- again" — the dispatcher's way of closing a cycle without a job.
  next_call_on  date,
  created_by    uuid NOT NULL REFERENCES employees(id),
  created_at    timestamptz NOT NULL DEFAULT now(),
  -- A follow-up with neither a date nor a note records nothing the next
  -- dispatcher can act on; the API says the same, the table keeps it true.
  CONSTRAINT customer_follow_ups_says_something
    CHECK (next_call_on IS NOT NULL OR (note IS NOT NULL AND btrim(note) <> ''))
);

-- The latest follow-up per customer is the one that counts, and the view
-- below reads it with a LATERAL ordered by created_at.
CREATE INDEX customer_follow_ups_customer_created_idx
  ON customer_follow_ups (customer_id, created_at DESC);

-- ----------------------------------------------------------------------
-- v_service_calls — one row per customer who has ever been served.
--
--  - last_service_on is the business date of the customer's latest
--    COMPLETED job (any job, AMC or not — the office's rule); cancelled
--    jobs are not service.
--  - due_on = last_service_on + 6 months. Postgres clamps month ends
--    (31 Mar + 6 months = 30 Sep), which is the honest reading of "six
--    months later" for a monthly cycle.
--  - pushed_to is the latest follow-up's next_call_on, but only when that
--    follow-up was recorded after the last completion. Otherwise NULL.
--  - remind_on = GREATEST(due_on, pushed_to): a push-back moves the
--    reminder out and can never pull it in.
--  - is_due is remind_on arrived and no open job at the site.
--  - open_jobs counts the jobs nobody has finished or cancelled yet.
-- ----------------------------------------------------------------------
CREATE VIEW v_service_calls AS
SELECT
  cu.id                                       AS customer_id,
  cu.name                                     AS customer_name,
  cu.phone,
  cu.area,
  last_job.last_service_on,
  last_job.last_job_number,
  last_job.last_job_title,
  (last_job.last_service_on + interval '6 months')::date
                                              AS due_on,
  pushed.next_call_on                         AS pushed_to,
  pushed.outcome                              AS last_outcome,
  pushed.note                                 AS last_note,
  pushed.created_by_name                      AS last_called_by,
  GREATEST(
    (last_job.last_service_on + interval '6 months')::date,
    COALESCE(pushed.next_call_on, (last_job.last_service_on + interval '6 months')::date)
  )                                           AS remind_on,
  (business_date(now()) - GREATEST(
    (last_job.last_service_on + interval '6 months')::date,
    COALESCE(pushed.next_call_on, (last_job.last_service_on + interval '6 months')::date)
  ))                                          AS days_due,
  -- ::int, not bigint: node-postgres hands a bigint back as a string,
  -- and a count on the wire is a number (the response schema says so).
  open_jobs.open_count::int                   AS open_jobs,
  (
    GREATEST(
      (last_job.last_service_on + interval '6 months')::date,
      COALESCE(pushed.next_call_on, (last_job.last_service_on + interval '6 months')::date)
    ) <= business_date(now())
    AND open_jobs.open_count = 0
  )                                           AS is_due
FROM customers cu
JOIN LATERAL (
  SELECT
    max(business_date(j.closed_at)) AS last_service_on,
    (array_agg(j.job_number ORDER BY j.closed_at DESC))[1] AS last_job_number,
    (array_agg(j.title ORDER BY j.closed_at DESC))[1]      AS last_job_title
  FROM job_cards j
  WHERE j.customer_id = cu.id
    AND j.status = 'completed'
    AND j.closed_at IS NOT NULL
) last_job ON last_job.last_service_on IS NOT NULL
LEFT JOIN LATERAL (
  SELECT
    f.next_call_on,
    f.outcome,
    f.note,
    e.full_name AS created_by_name
  FROM customer_follow_ups f
  JOIN employees e ON e.id = f.created_by
  WHERE f.customer_id = cu.id
    AND f.created_at > (
      SELECT max(j2.closed_at) FROM job_cards j2
      WHERE j2.customer_id = cu.id AND j2.status = 'completed' AND j2.closed_at IS NOT NULL
    )
  ORDER BY f.created_at DESC
  LIMIT 1
) pushed ON true
LEFT JOIN LATERAL (
  SELECT count(*) AS open_count
  FROM job_cards j3
  WHERE j3.customer_id = cu.id
    AND j3.status NOT IN ('completed', 'cancelled')
) open_jobs ON true
WHERE cu.is_active;
