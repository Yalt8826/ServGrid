# Decision — AMC contracts are the dispatcher's, reminded by time since the last job

**Date:** 2026-09-15 · **Decided by:** the owner · **Phase:** 2B (`docs/implementation/PHASE-2B-CONTRACTS.md`)

The original Phase 2B design had sales reps sell AMCs as a fixed number of visits, a nightly generator raise each visit as a job, and dispatchers barred from the contract value. The owner described how the business actually runs AMCs, and it is simpler and different. This record replaces that design.

## The owner's answers

| # | Question | Answer |
|---|---|---|
| 1 | Who records an AMC | **The dispatcher**, against the customer (the site). The owner can too |
| 2 | How AMC work is dispatched | When the dispatcher picks a customer who has an AMC on the dispatch form, **an AMC option is offered, already ticked**; the job is linked to the AMC |
| 3 | Visit count | **Not fixed.** An AMC is not "four visits a year" |
| 4 | Visit reminders | The app **reminds the dispatcher four months after the customer's last completed job — any job** at that customer, AMC-linked or not |
| 5 | Where reminders appear | **A separate AMC tab in the dispatcher's navbar** with the due list |
| 6 | Term | **12 months, then renew** |
| 7 | Renewal warning | **7 days** before the AMC ends |
| 8 | Price | **The dispatcher enters the AMC price and can see it** |
| 9 | Charging on a visit | **The technician decides on site.** The complete sheet starts on **Free under AMC**; he can switch to **Charge** for extra work |
| 10 | Sales reps | **No part in AMCs** |
| 11 | Edit and cancel | **Dispatcher and owner** |
| 12 | Form defaults | 12 months |

## What changes against the plan

- **No visit schedule, no generator, no `contract_visits`.** A job links straight to its contract (`job_cards.contract_id`). The nightly `generate-contract-visits` and `expire-contracts` jobs and the `contracts.generate` flag are dropped.
- **State is derived from dates**, not stored: `upcoming`, `active`, `expired`, or `cancelled` when `cancelled_at` is set. Nothing needs a cron to expire.
- **One AMC per site at a time** stays, as a database exclusion constraint on overlapping date ranges (ignoring cancelled ones). A renewal can be recorded before the old term ends because the two ranges do not overlap.
- **The number is allocated at create** (`AMC-2627-00031`); there is no draft.
- **The revenue rule narrows.** "No dispatcher sees revenue" now means *job* revenue (`job_completions`). The AMC price is a figure the dispatcher himself negotiates and types in. The `no-sql-money-tables` lint rule and the money-leak suite keep guarding `job_completions`; `contract_value` stays hidden from technicians.
- **No prepaid/per-visit billing.** Whether money changes hands is the technician's call per visit, defaulting to free.
- **The cancel sheet's "spends a visit" warning goes.** With no visit count nothing is spent; an AMC job cancelled with a new date raises a successor linked to the same AMC, like any job.
- **Reps lose contracts**: no renewal list, no rep contract screens, `contract` is `none` in the rep's matrix.
- **The dispatcher gets a fourth tab**, *AMC*. `/contracts` leaves Operations for him; the owner keeps it under Operations. `/contracts/renewals` is removed — ending-soon is a section of the AMC screen.

## Found while planning

`POST /v1/jobs` — the dispatch form's create door — was never built: the form's submit has had no endpoint to reach. Phase 2B builds it, because the AMC option lives on that form.

## Not changed

A job linked to an AMC is still an ordinary job: the same picker assigns it, the same sheet closes it, the same events record it. The only branches on "is this an AMC job" are the chip, the dispatch-form option, and the complete sheet's Free/Charge choice.
