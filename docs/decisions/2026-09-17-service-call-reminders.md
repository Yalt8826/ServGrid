# Service-call reminders — a six-month cycle per customer (2026-09-17)

**The decision (Yashas, 2026-09-17).** UPS units and batteries are serviced
every six months, so the office wants a list of customers whose service is
due, ringing them when the six months are up:

> "the ups and batteries need to be serviced every 6 months so i want a system
> where once a job is completed for a customer the dispatcher is reminded of
> that customer 6 months later that its due for his service and the dispatcher
> can assign the job or he can push it back to 3 more months to be reminded
> again"

Three follow-up questions were settled at the same time:

- **"Not now" pushes the reminder three months** and records what was said —
  it does not raise a job by itself. The dispatcher books the visit from the
  row when the customer agrees (`Assign`, which opens the dispatch form with
  the customer chosen).
- **Its own tab** in the bottom bar (`Calls`), not a section of the dashboard.
- **Every call records an outcome, the date to ring again and a note** — so
  the history can answer "did anyone ring this customer, and what did they
  say" when the owner asks.

## What is derived, and what is stored

The divide is the whole design, and it follows migration 015's rule for AMC
reminders ("a stored reminder would be a fact that drifts"):

| Fact | Where it lives | Why |
| --- | --- | --- |
| Last service date | `v_service_calls`, from `job_cards.closed_at` | the database already knows it |
| Due on = last service + 6 months | the same view | arithmetic on a fact, never a stored date a late job would invalidate |
| Nobody is called who has an open job | the view's `is_due` | the same rule `v_contracts.is_visit_due` uses: a site somebody is already going to is not a phone call |
| "Rang them, ring again in December" | `customer_follow_ups` | a human decision; nothing in the data can recover it |

`remind_on = GREATEST(due_on, pushed_to)`, so a push-back moves the reminder
out and **can never pull it in**: a customer who asks to be rung sooner than
their cycle allows is still rung at the cycle's own date, and the earlier
promise is history rather than a false due date. A follow-up only counts when
it was recorded *after* the last completion — the moment a job is completed,
the six months start again from that job and the previous cycle's calls are
history.

## What the dispatcher sees

One question — *who do I ring today* — answered by two lists:

- **Due now**: `is_due`, most overdue first. Each row is the call: the
  customer, the phone number and area, the last service and its job number,
  how late the reminder is, and any note from the last call. *Call* dials,
  *Assign* opens the dispatch form on that customer, *Not now* files the call.
- **Pushed back**: customers whose last call moved the reminder into the
  future, soonest first — so a promise the office made is visible, and the
  day it comes round the customer is back in the first list.

## Deliberately not done

- **No money anywhere on this surface.** A visit's price is the office's
  business; the reminder page is about ringing people. The money-leak suite
  walks both routes like the rest.
- **No cron and no push.** The list is a view and a read: a reminder cannot
  fail to fire, and a dispatcher who does not open the tab is not behind —
  the customer is simply still due. Notifications would be a separate
  decision with its own budget (`dispatch.console`'s phase, `flags/gates.ts`).
- **Not the technician's.** The list is the whole book of customers, so both
  routes are gated `requireAll` — a technician's row-scoped read must never
  satisfy an endpoint that lists every row (the contracts precedent).

See also: `docs/UI/plan-2/05-DISPATCHER.md` §D5 (the AMC tab, whose visit
cycle this mirrors) and migration `023_service_calls`.
