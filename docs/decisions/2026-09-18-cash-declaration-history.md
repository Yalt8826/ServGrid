# Cash declarations — the employee gets his history back, and the office's answer with it (2026-09-18)

**The decision (Yashas, 2026-09-18).**

> "the sales rep can have a history of cash declarations"

Four follow-up questions were settled at the same time:

- **Placement: two tabs on the Cash screen** — `Declare` / `History`. The
  declaration form stays the default tab, so the daily act is exactly as quick
  as it was.
- **A row carries the office's answer**, not just the declaration.
- **Grouped by month, with the month's total** — the figure he reconciles
  against.
- **The roles differ by window**: *"the sales rep gets the full history
  whereas the technician gets only the last 7 days history."*

## This reverses a decision of two days earlier, deliberately

On 2026-09-16 the same person had the declarations list **removed** —
technician 04 §T6, recorded in the screen's own header as *"The declarations
LIST is gone (2026-09-16, Yashas: he declares — he does not browse his past)"*,
with a test freezing its absence.

The reversal is not a contradiction, and the shape it came back in is why: the
list returned as **its own view**, not as a block appended under the form. The
reason the list was removed still holds — the form is a once-a-day act and
should not make him scroll past his past to get to it. That is also why the
`HandoverScreen` test that froze the absence is not deleted but *rewritten*: it
now asserts that the declare view carries no list, **and** that the tab to the
history is on it.

## What crosses the wire, and what never will

`CashHandoverSchema` — what the declaring employee reads — carried **no
owner-side column** until now. The queue was the owner's. That left a disputed
day reading as the bare word *Disputed*: told he had been questioned, and never
what about, on the one screen whose whole job is to tell him what became of his
money. `confirmedAmount` and `ownerNote` are the owner's communication **to**
him, so they cross.

| Figure | Crosses? | Why |
| --- | --- | --- |
| `declaredAmount` | yes | his own commitment |
| `confirmedAmount` | yes (new) | what the owner accepted — an answer to a figure he already gave |
| `ownerNote` | yes (new) | the reason, which the DB CHECK already forces on a dispute |
| `expected_cash` | **never** | the system's expectation is the check; showing it turns a reconciliation into a form-fill (T1.11) |
| a variance against `expected_cash` | **never** | it is one subtraction away from the withheld figure |

That last row is the load-bearing one, because the obvious implementation leaks.
The owner's queue has a `variance` field, and it is `declared − expected_cash`.
Putting **that** number on the employee's row would hand him the expectation by
arithmetic. So no variance is computed on this path at all: the only difference
these two figures support is `declared − confirmed`, and the UI says it in
words (`Office confirmed ₹4,200 — ₹300 less than declared.`) rather than
exposing a subtractable field.

`apps/api/test/integration/rep-cash.test.ts` holds this: the answer must be
present **and** the body must contain neither `expected_cash` nor the string
`variance`.

## The two windows are one rule

The technician's window is not a new number. It is `BUSINESS_DATE_MAX_AGE_DAYS`
— the same 7 that bounds what he may **declare** — read from
`businessDateBounds`, the one place that rule lives. Consequence, by
construction: the technician's history can never show him a day he could not
also have declared for. The rep's window is unbounded, because reconciling with
the office over months is the rep's job and a record that stops at a week is not
a record.

Enforced on the server off the token's role (`historyWindowDaysFor` in the cash
service), never off the request — nothing a client sends can widen it, and the
existing `/me` property holds: no request names an employee, so another
employee's rows are not reachable from this endpoint at all. The client applies
the same floor so the tab's caption and its contents cannot disagree.

## Where it lives

| Piece | File |
| --- | --- |
| The wire shape | `packages/shared/src/schemas.ts` — `CashHandoverSchema` |
| Columns, the window floor | `apps/api/src/modules/cash/repo.ts` |
| The role → window rule | `apps/api/src/modules/cash/service.ts` — `historyWindowDaysFor` |
| Months, totals, the window filter | `apps/mobile/src/screens/cash/cashHistory.ts` |
| Dates, the status vocabulary, `officeAnswerOf` | `apps/mobile/src/screens/cash/handoverModel.ts` |
| The list | `apps/mobile/src/screens/cash/CashHistoryScreen.tsx` |
| The declare panel | `apps/mobile/src/screens/cash/HandoverPanel.tsx` |
| Frame + tabs + the read | `apps/mobile/src/screens/cash/CashScreen.tsx` |

The shared cash surface moved from `src/screens/technician/HandoverScreen.tsx`
into `src/screens/cash/`: it was already serving two roles and now has more than
one screen under it, so the pure rules left the screen file rather than being
imported from one screen by another.
