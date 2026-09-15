-- Migration 019 — sale line discounts (PHASE-ON-ONLINE.md TON.6; decision 7
-- of docs/decisions/2026-09-15-online-only.md).
--
-- A rep's discount used to reach the server only as a reduced unit_price:
-- the list price and the percentage stayed on the phone, so nobody could
-- see afterwards what discount had been given. Each line now keeps both
-- beside the price they produced.
--
-- Both columns are NULL for lines recorded before this migration and for a
-- line entered at a typed price with no list price behind it — the pair is
-- all-or-nothing. When present, unit_price must be exactly the list price
-- less the discount, rounded to the paisa. The server computes it; this
-- CHECK is the backstop, so no client can store a price its discount does
-- not explain. line_total stays the generated round(quantity × unit_price).

ALTER TABLE sales_card_items
  ADD COLUMN list_price   numeric(12,2),
  ADD COLUMN discount_pct numeric(5,2);

ALTER TABLE sales_card_items
  ADD CONSTRAINT sales_card_items_discount_paired
    CHECK ((list_price IS NULL) = (discount_pct IS NULL)),
  ADD CONSTRAINT sales_card_items_list_price_non_negative
    CHECK (list_price IS NULL OR list_price >= 0),
  ADD CONSTRAINT sales_card_items_discount_pct_range
    CHECK (discount_pct IS NULL OR (discount_pct >= 0 AND discount_pct <= 100)),
  ADD CONSTRAINT sales_card_items_discount_explains_price
    CHECK (list_price IS NULL OR unit_price = round(list_price * (100 - discount_pct) / 100, 2));
