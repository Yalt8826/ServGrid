-- Migration 017 — sales (PLAN-DATA-MODEL.md §3.5, PHASE-3-SALES-REP.md
-- T3.1). sales_cards, sales_card_items, payments.
--
-- The B2B money tables. Jobs carry no money columns (migration 007) —
-- sales to companies are the itemised documents, and these three tables
-- are the only new money-at-rest in Phase 3. What a sale is worth and
-- what a company owes is DERIVED in migration 018's views; nothing here
-- stores a balance, because a stored counter is correct only until the
-- first edit, void or retried request.
--
-- Numbered 017, not 011/012: Phase 2's 011 and Phase 1's 016 are already
-- applied and keep their numbers; 012 stays empty (PLAN-DATA-MODEL.md
-- §1, renumbered 13 Sep 2026). Nothing here depends on anything above
-- 018 that has not shipped.

-- -----------------------------------------------------------------------
-- sales_cards — one row per sale to a company.
--
-- sale_number is NULLABLE and that is load-bearing, not laxity. The
-- number is allocated at CONFIRM, not at create (PLAN-BACKEND.md §11:
-- next_in_sequence('sale:2627')), so a draft has none — a NOT NULL here,
-- which is what anyone writing this from the column list would reach
-- for, makes drafts impossible. The CHECK carries the real rule: draft
-- means no number, anything else (confirmed, void) means one. A draft
-- that never confirms burns no number, and the rep's device shows
-- "Draft" — the device never shows a fake local number.
--
-- VOID, never DELETE, and a void needs a reason. Dues are derived
-- (v_company_balances, migration 018), so a void is the only correct way
-- to reverse a sale — deleting the row would silently move a company's
-- balance with no trace. The void fields are coherent by constraint:
-- voided_at only on a void, and a void carries who and why. T4 (wrong
-- money) is void-and-re-enter for exactly this reason.
--
-- Mutable and syncable: the rep PATCHes a DRAFT (only a draft — a
-- confirmed card is corrected by void), so version/created_at/updated_at
-- and the touch trigger apply, with the (updated_at) delta-sync index
-- from §5.
-- -----------------------------------------------------------------------
CREATE TABLE sales_cards (
  id           uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- SC-2627-00042 — allocated via next_in_sequence('sale:2627') at
  -- confirm; NULL while draft. The format lives in the service layer.
  sale_number  text,
  CONSTRAINT sales_cards_sale_number_unique UNIQUE (sale_number),
  company_id   uuid NOT NULL REFERENCES companies(id),
  sales_rep_id uuid NOT NULL REFERENCES employees(id),
  -- The IST business day the sale was MADE, chosen by the rep (an
  -- offline sale made Monday can sync Tuesday) — never derived from the
  -- server clock, or every offline sale would backdate forward.
  sale_date    date NOT NULL,
  status       sales_card_status NOT NULL DEFAULT 'draft',
  notes        text,

  confirmed_at  timestamptz,
  voided_at     timestamptz,
  voided_by     uuid REFERENCES employees(id),
  void_reason   text,

  -- The spec's constraint, verbatim (§3.5). Status enum carries only
  -- draft/confirmed/void, so the boolean equation covers void: a voided
  -- sale was confirmed first and keeps its number.
  CONSTRAINT sale_number_when_confirmed
    CHECK ((status = 'draft') = (sale_number IS NULL)),
  -- A draft is unstamped; confirming stamps it; voiding keeps the stamp.
  CONSTRAINT sales_cards_confirmed_stamped
    CHECK ((status = 'draft') = (confirmed_at IS NULL)),
  -- Void is a real state, not a flag someone forgot to fill in.
  CONSTRAINT sales_cards_void_coherent
    CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  -- A void without the owner's reason is a balance that moved for
  -- nothing — unreviewable at month end (T3.9 reconciles to the rupee).
  CONSTRAINT sales_cards_void_justified
    CHECK (status <> 'void' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL)),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);

-- §5 index plan: company ledger, rep's sale list, delta-sync cursor.
CREATE INDEX sales_cards_company_date_idx ON sales_cards (company_id, sale_date DESC);
CREATE INDEX sales_cards_rep_date_idx ON sales_cards (sales_rep_id, sale_date DESC);
CREATE INDEX sales_cards_updated_at_idx ON sales_cards (updated_at);

CREATE TRIGGER sales_cards_touch BEFORE UPDATE ON sales_cards
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();

-- -----------------------------------------------------------------------
-- sales_card_items — the LINES, and the only itemised money in the
-- system (job_completion_parts records what was fitted; it is not a
-- bill, §3.4).
--
-- product_id is nullable and kept for reporting joins; it is NEVER read
-- for display, because the display reads the SNAPSHOTS:
-- product_name/product_sku/unit_price frozen at add time. A product
-- rename or repricing next quarter must not rewrite last quarter's sale
-- — the stored line is what was actually agreed (the unit price is
-- editable per line because a negotiated price is normal).
--
-- line_total is generated, not writable: "what is this sale worth" has
-- one definition, round(quantity × unit_price, 2), and v_sales_card_totals
-- (migration 018) sums it. Money is numeric(14,2) per line (§ conventions).
--
-- No mutable plumbing (no version/created_at/updated_at), the same shape
-- as job_completion_parts: a draft's lines are rewritten in full on each
-- edit, a confirmed card's lines never change, and the correction path
-- is void — there is no partial update to order and no mirror cursor
-- reads lines separately from their card.
-- -----------------------------------------------------------------------
CREATE TABLE sales_card_items (
  sales_card_id  uuid NOT NULL REFERENCES sales_cards(id),
  line_no        integer NOT NULL, -- unique within the card, via the PK
  product_id     uuid REFERENCES products(id), -- NULL = third-party kit
  -- Snapshots at add time; product_name is required even for third-party
  -- lines, which is why there is no free_text_name/product-or-name CHECK
  -- here — the snapshot column IS the name.
  product_name   text NOT NULL,
  product_sku    text,
  quantity       numeric(10,2) NOT NULL,
  unit_price     numeric(12,2) NOT NULL,
  -- One definition of a line's worth. round() to the paisa, store it.
  line_total     numeric(14,2) GENERATED ALWAYS AS (round(quantity * unit_price, 2)) STORED,
  serial_numbers text[], -- the fitted units' serials, when the line has any

  CONSTRAINT sales_card_items_pk PRIMARY KEY (sales_card_id, line_no),
  CONSTRAINT sales_card_items_quantity_positive CHECK (quantity > 0),
  -- A negative line price would move a balance silently; a discount is a
  -- smaller positive price, void-and-re-enter is the correction.
  CONSTRAINT sales_card_items_price_non_negative CHECK (unit_price >= 0)
);

-- -----------------------------------------------------------------------
-- payments — money actually received. payment_number is allocated at
-- CREATE because payments are not drafted; there is no 'pending'
-- payment status, DELIBERATELY — pending is a view of dues
-- (v_company_balances WHERE balance > 0, migration 018), not a row.
-- Modelling an intention to collect ₹40,000 as a row would create
-- exactly the stored-counter drift the plan rejects.
--
-- sales_card_id is nullable: NULL = on-account, the normal collection —
-- money lands on the company balance without pointing at one sale.
--
-- received_by records whoever ACTUALLY took the money, which may be a
-- rep who does not own the account (the completed_by precedent, §3.2).
-- received_at is the client's clamped instant (the money changed hands
-- at the customer's office, maybe offline), and business_date is
-- generated from it — cash received Monday lands on Monday whenever it
-- syncs, and the IST day is what v_employee_expected_cash (migration 018)
-- groups on.
--
-- Void, not delete, with the same coherent reason fields as sales_cards.
-- Mutable (a void updates it), so the full mutable plumbing applies.
-- -----------------------------------------------------------------------
CREATE TABLE payments (
  id             uuid PRIMARY KEY DEFAULT gen_random_uuid(),
  -- PM-2627-00042 — allocated via next_in_sequence('payment:2627') at
  -- create; the format lives in the service layer.
  payment_number text NOT NULL,
  CONSTRAINT payments_payment_number_unique UNIQUE (payment_number),
  company_id     uuid NOT NULL REFERENCES companies(id),
  sales_card_id  uuid REFERENCES sales_cards(id), -- NULL = on-account
  amount         numeric(12,2) NOT NULL,
  mode           payment_mode NOT NULL,
  reference_no   text, -- UPI txn id / cheque number; NULL for cash
  received_by    uuid NOT NULL REFERENCES employees(id),
  received_at    timestamptz NOT NULL,
  business_date  date GENERATED ALWAYS AS (business_date(received_at)) STORED,
  status         payment_status NOT NULL DEFAULT 'collected',

  voided_at      timestamptz,
  voided_by      uuid REFERENCES employees(id),
  void_reason    text,
  notes          text,

  -- A payment of nothing is not a payment (there is no 'none' mode for
  -- the same reason); a negative amount would be a refund with no trail.
  CONSTRAINT payments_amount_positive CHECK (amount > 0),
  CONSTRAINT payments_void_coherent
    CHECK ((status = 'void') = (voided_at IS NOT NULL)),
  CONSTRAINT payments_void_justified
    CHECK (status <> 'void' OR (void_reason IS NOT NULL AND voided_by IS NOT NULL)),

  created_at  timestamptz NOT NULL DEFAULT now(),
  updated_at  timestamptz NOT NULL DEFAULT now(),
  version     integer NOT NULL DEFAULT 1
);

-- §5 index plan: company ledger newest-first, the rep's collected tab,
-- and the cash partial for the payments side of the expected-cash view
-- (migration 018 walks exactly this predicate).
CREATE INDEX payments_company_received_idx ON payments (company_id, received_at DESC);
CREATE INDEX payments_rep_collected_idx ON payments (received_by, business_date DESC);
CREATE INDEX payments_cash_idx ON payments (received_by, business_date)
  WHERE mode = 'cash';

CREATE TRIGGER payments_touch BEFORE UPDATE ON payments
  FOR EACH ROW WHEN (NEW.updated_at IS NOT DISTINCT FROM OLD.updated_at)
  EXECUTE FUNCTION touch_updated_at();
