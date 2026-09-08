# 06 — Sales Rep screens

**The role's condition.** On the road between companies, in lobbies, sometimes at a desk.
Phone-first always. Signal is usually fine but the lobby basement is real. Both hands in the
car park, one hand in a lift. She is tracked like a technician (health chip on her profile)
and has the same outbox — a sale recorded in a dead zone must survive like a completion. Her
worst moment: she logged a sale and a ₹40,000 payment in a lobby with no signal, the customer
asked "did it go through?", and the app must answer honestly without the network. Second-
worst: month-end, a company disputes a balance, and the ledger with its running total is the
arbiter.

**Density:** `field` · **Offline:** yes — full outbox (reuses Phase 1 machinery unchanged) ·
**Tracked:** yes · **Money:** sees sales, payments and balances for **her accounts plus house
accounts** — never other reps', never contract values of accounts she didn't sell ·
**Signature moment:** none budgeted; her craft is capture speed.

## SAL-01. Dashboard

**Purpose.** My month: what did I sell, what is outstanding, what renewals need a call?

**Worst moment.** Month-end review with the owner in ten minutes.

### Anatomy
```
┌──────────────────────────────┐
│ Dashboard        ● 1 queued  │
│ Month-to-date   ₹ 4,82,500   │  display/Condensed, tabular
│ Outstanding across accounts  │
│ ₹ 1,20,000 · 4 companies     │
│ Renewals · 60 days: 3    →   │  the commercial heartbeat
│ Recent payments (3)          │
│ ┌──────────────────────────┐ │
│ │▐ Sunrise Traders ₹18,200 │ │  PaymentRow: company, amount, mode
│ │▐ UPI · 06 Sep · ✓        │ │
│ └──────────────────────────┘ │
└──────────────────────────────┘
```

### Content
Month-to-date sales, outstanding across her accounts (the dues view — a derived sum, never a
stored column, and the UI treats it as fresh truth), renewals in 60 days (her sold accounts'),
recent payments. Figures carry AgeStamps when rendered from cache.

### States
Empty ("No sales this month"), stale, pending-sync, offline banner. Skeleton only on cold
first load.

### Motion
None.

### Not on this screen
Other reps' numbers (owner sees all; she sees hers + house), job operational data, no
collection-rate vanity charts (a dashboard is not a reward sticker).

## SAL-02. Sales

**Purpose.** Record what was sold — product, quantity, agreed price — as an internal record,
not an invoice.

**Worst moment.** Lobby, no signal, customer asking if it "went through": the sale is on the
phone, queued, and the app can prove it.

### Anatomy
List of her sales cards (number or "Pending sync", company, total, date) → [New sale] →
form: company (hers + house), line items (product picker **snapshots name and price at add
time**), notes. Save = optimistic, enqueued, "Pending sync" chip until the server number
arrives.

### States
Full offline matrix; validation (company + ≥1 line); rejection banner (e.g. duplicate
company created offline → "Use the existing company" rewires the dependent rows — she does
not re-enter the sale).

### Motion
None.

### Not on this screen
No GST breakup, no printable invoice (locked scope), no credit engine, no job links (sales
cards and jobs are separate records), no cost/margin views.

## SAL-03. Payments

**Purpose.** Money the companies owe and money she collected — in that order.

**Worst moment.** The dispute: "we paid that in August." The ledger says otherwise, with
entries.

### Anatomy
Tabs **[Companies owing | Collected]** — the first tab's copy is load-bearing: it lists
**companies with balance > 0** (a view), not "pending payments"; a row is a company, not a
promise someone made. Capture: company → amount → mode (cash/UPI/bank/cheque) → reference →
**proof photo** (queued local URI). A payment recorded for a company she doesn't own is
legal — it records who actually took the money.

### States
Offline capture works fully (queued); proof photo thumbnail renders from the local file;
rejection keeps the record with the server's message; empty owing ("Nothing outstanding —
clean book").

### Motion
None.

### Not on this screen
Job money (completions are the technician's surface), contract billing, any view of another
rep's collected list.

## SAL-04. Companies

**Purpose.** My accounts plus house accounts, each with its ledger and running balance.

**Worst moment.** The dispute again — the ledger is the instrument she opens.

### Anatomy
List (company, balance, owner-rep) → detail: **ledger with running balance** (sales +,
payments −, tabular, en-IN), derived dues at top, actions: [Record payment], [New sale].
House accounts marked "house" — visible to both reps, created by the owner.

### States
Stale (AgeStamp on the balance), offline (ledger reads from mirror), empty ("No accounts
yet — the owner assigns or you create the first customer-company link").

### Motion
None.

### Not on this screen
Contract values of contracts she didn't sell (renewal list only for hers), other reps'
ledgers, credit limits, GST data.

## SAL-05. Contracts & renewals

**Purpose.** The renewals she sold — who to call before the contract lapses.

**Worst moment.** A contract lapsed last week; the renewal conversation is now a penalty
conversation.

### Anatomy
[Contracts | Renewals 60d] — renewal rows: company + site, expiry AgeStamp-style emphasis,
**visits used and remaining** (a spent visit reduces what the renewal is worth — exactly what
she needs before quoting), [New contract] (customer, service, term, visits, billing mode).

### States
Empty ("No renewals in the next 60 days"), stale, error.

### Motion
None.

### Not on this screen
Contract value on contracts she didn't sell; visit generation controls (the nightly job does
it); dispatcher assignment surfaces; renewal "reminder" settings (renewal is a view, not a
notification table).

## SAL-06. Cash handover

**Purpose.** Declare the cash in her hands at day's end — same honesty as a technician,
because a rare path is one nobody notices is broken.

**Worst moment.** = TEC-06's, minus the van: month-end, two days of cash-mode payments, the
owner asking.

### Anatomy
= TEC-06 verbatim — one declaration per employee per day: expected (from her cash-mode
payments), declared amount, note. Same states, same offline behaviour, same rejection
treatment.

### Not on this screen
= TEC-06: no per-entry breakdown, no other employees, no expenses, no UPI (it never passes
through hands).

## SAL-07. Profile

**Purpose.** Am I tracked and alerted correctly, and is my queue clean?

**Worst moment.** She notices her "Job alerts off" amber state three days late — the chip
must make that state impossible to miss.

### Anatomy
= TEC-07: identity, **TrackingHealthChip (four states)**, permission-ladder steps with [Fix]
deep-links, pending count, protected logout (blocked while queued; rejected rows survive
keyed to her).

### Not on this screen
= TEC-07: no others' data, no account editing, no settings beyond ladder + logout.
