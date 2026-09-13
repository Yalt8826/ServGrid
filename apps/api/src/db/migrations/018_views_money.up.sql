-- Migration 018 — views_money (PLAN-DATA-MODEL.md §4, PHASE-3-SALES-REP.md
-- T3.1). Four views: v_sales_card_totals, v_company_balances,
-- v_employee_expected_cash, v_cash_reconciliation_queue.
--
-- THE MONEY LAYER IS DERIVED, NOT STORED. Company dues and expected cash
-- are views, never counters (PLAN.md §9 promise 3): a stored total is
-- correct until the first edit, void or retried request, and these views
-- cannot drift because they are recomputed from the rows themselves on
-- every read. Plain views, not materialized — the largest aggregates a
-- few thousand rows.
--
-- Depends only on tables already shipped: sales_cards/sales_card_items/
-- payments (017), job_completions (007), cash_reconciliations (010),
-- employees/companies (003/005).

-- -----------------------------------------------------------------------
-- v_sales_card_totals — per card, SUM(line_total) with status carried
-- through. EVERY other total in the system reads this view, so "what is
-- a sale worth" is defined once, here — a card's worth is the sum of its
-- generated line totals, and nothing else gets to recompute it.
-- -----------------------------------------------------------------------
CREATE VIEW v_sales_card_totals AS
SELECT
  sc.id            AS sales_card_id,
  sc.sale_number,
  sc.company_id,
  sc.sales_rep_id,
  sc.sale_date,
  sc.status,
  -- A card with no lines is worth zero, not NULL. The cast keeps the
  -- zero at the money scale — a bare integer 0 would render as '0'
  -- instead of '0.00' and every consumer would format it twice.
  COALESCE(SUM(i.line_total), 0::numeric(14,2)) AS total
FROM sales_cards sc
LEFT JOIN sales_card_items i ON i.sales_card_id = sc.id
GROUP BY sc.id; -- id is the PK: the other sc.* columns group by function

-- -----------------------------------------------------------------------
-- v_company_balances — SUM(confirmed sales) − SUM(collected payments)
-- per company, plus last_sale_date and last_payment_at. Drafts and voids
-- are excluded on BOTH sides: a draft is not money yet, a void is a
-- reversal. This is the number that rises the moment a sale is confirmed
-- — and it cannot drift, where a stored counter is correct until the
-- first edit, void or retried request.
--
-- Reads v_sales_card_totals (not sales_card_items directly) because every
-- total in the system reads the one definition. An overpayment produces
-- a NEGATIVE balance and the view does not clamp it — a credit is a real
-- state and good news; the UI renders it as "Credit" (UI/plan-2
-- 06-SALES-REP.md §S4).
--
-- Sales with status='collected' do not exist and payments with
-- status='confirmed' do not exist; the filters are spelled out per side
-- ('confirmed' on sales, 'collected' on payments) rather than "not
-- excluded", so adding a future status lands on the safe side.
--
-- One row per company, including companies with no activity (balance 0,
-- NULL last-activity): the Pending tab reads
-- v_company_balances WHERE balance > 0, so the zero rows must exist to
-- be filtered, not be absent by construction.
-- -----------------------------------------------------------------------
CREATE VIEW v_company_balances AS
SELECT
  c.id                                            AS company_id,
  -- Same scale rule as v_sales_card_totals: a dormant company's zero is
  -- '0.00', never a bare '0'.
  COALESCE(s.sold_total, 0::numeric(14,2)) - COALESCE(p.paid_total, 0::numeric(14,2)) AS balance,
  s.last_sale_date,
  p.last_payment_at
FROM companies c
LEFT JOIN (
  SELECT company_id, SUM(total) AS sold_total, MAX(sale_date) AS last_sale_date
  FROM v_sales_card_totals
  WHERE status = 'confirmed'
  GROUP BY company_id
) s ON s.company_id = c.id
LEFT JOIN (
  SELECT company_id, SUM(amount) AS paid_total, MAX(received_at) AS last_payment_at
  FROM payments
  WHERE status = 'collected'
  GROUP BY company_id
) p ON p.company_id = c.id;

-- -----------------------------------------------------------------------
-- v_employee_expected_cash — cash that passed through a person's hands
-- on a day, from BOTH sources, then summed per (employee_id,
-- business_date):
--
--   * job_completions: grouped by completed_by — NOT job_cards.assigned_to.
--     If a job is reassigned mid-day, the cash is with whoever CLOSED it.
--   * payments: grouped by received_by — a rep may legitimately hold cash
--     for an account he does not own; the record says who did the thing,
--     not who was supposed to.
--
-- Only cash reaches this view: collection_mode = 'cash' and
-- payment_mode = 'cash' with status = 'collected'. UPI, card, cheque and
-- bank transfer land in the company account and never pass through
-- anyone's hands; a VOIDED cash payment creates no expectation either —
-- otherwise the rep is short exactly that amount at handover and gets
-- asked about a variance that is not one. If either enum ever gains
-- another value that represents physical currency, the filter here must
-- change with it (migration 002's load-bearing note).
-- -----------------------------------------------------------------------
CREATE VIEW v_employee_expected_cash AS
SELECT
  days.employee_id,
  days.business_date,
  SUM(days.cash) AS expected_cash
FROM (
  SELECT completed_by AS employee_id,
         business_date,
         SUM(amount_collected) AS cash
  FROM job_completions
  WHERE collection_mode = 'cash'
  GROUP BY completed_by, business_date

  UNION ALL

  SELECT received_by AS employee_id,
         business_date,
         SUM(amount) AS cash
  FROM payments
  WHERE mode = 'cash' AND status = 'collected'
  GROUP BY received_by, business_date
) days
GROUP BY days.employee_id, days.business_date;

-- -----------------------------------------------------------------------
-- v_cash_reconciliation_queue — the owner's daily handover queue: what
-- each person SHOULD have handed over (derived, above) against what they
-- DECLARED (cash_reconciliations, migration 010), one row per
-- (employee, business_date) present on either side.
--
-- FULL OUTER JOIN, and NOT a LEFT JOIN — this is the load-bearing choice
-- in the whole migration. missing_submission is the only flag whose row
-- does not exist on one side of the join (expected cash, no declaration
-- row), so it is the only one a LEFT JOIN would silently drop — and it
-- is the row the entire feature exists to catch. Every other flag still
-- works under a LEFT JOIN, which is exactly what makes the defect
-- invisible; the integration suite proves this flag from BOTH sides of
-- the join (a completion-day and a payment-day) for that reason.
--
-- No expenses term, because employees do not spend from collections
-- (§3.7): every variance is therefore a real one, which is what makes
-- the flag worth reading.
--
-- variance = declared − expected: positive means handed over MORE than
-- expected (check the declared figure), negative means short. It is NULL
-- exactly when one side is missing — there is no variance against
-- nothing. Flags, in precedence order:
--
--   missing_submission  collected cash, no declaration — the row the
--                       feature exists for
--   no_expected_cash    declared money the system did not expect
--   variance            declared ≠ expected
--   match               reconciled
-- -----------------------------------------------------------------------
CREATE VIEW v_cash_reconciliation_queue AS
SELECT
  emp.id            AS employee_id,
  emp.full_name     AS employee_name,
  COALESCE(x.business_date, cr.business_date) AS business_date,
  x.expected_cash,
  cr.declared_amount,
  cr.declared_at,
  cr.status         AS declaration_status,
  cr.employee_note,
  cr.declared_amount - x.expected_cash AS variance,
  CASE
    WHEN cr.declared_amount IS NULL              THEN 'missing_submission'
    WHEN x.expected_cash IS NULL                 THEN 'no_expected_cash'
    WHEN cr.declared_amount <> x.expected_cash   THEN 'variance'
    ELSE 'match'
  END               AS flag
FROM v_employee_expected_cash x
FULL OUTER JOIN cash_reconciliations cr
  ON cr.employee_id = x.employee_id
 AND cr.business_date = x.business_date
JOIN employees emp
  ON emp.id = COALESCE(x.employee_id, cr.employee_id);
