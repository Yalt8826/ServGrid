# Several services on one visit, and the site pin a technician may register (2026-09-18)

**The decisions (Yashas, 2026-09-18), from one message about the technician's
completion form:**

> "if the customer does not have a location stored not the address or area but
> the location stored then it can ask the technician if he is present at the
> customer location so we can register that location as the customer location
> which makes it easier next time we go there"
>
> "make it so that the technician can choose multiple service from the
> completion form and not just one and the price is summed up"

Plus a third ask that was an audit rather than a change: *"can you check if the
location tracking of the technician is working properly"*.

## 1 · The site pin: register what is missing, never overwrite

**Before this, the capture was silent and it overwrote.** The completion had
carried `latitude`/`longitude` since 2026-09-17, the phone captured a fix
automatically on submit, and the server wrote it to the customer unconditionally
("the freshest on-site truth wins").

That was wrong on two counts, and his sentence says why: *"we can register that
location"* is a register act, and it is for *"the customer [who] does not have a
location stored"*.

| | Rule |
| --- | --- |
| When the customer has **no** pin | The sheet asks "Are you at their location right now?". **Yes** captures one fix on the spot and the server stores it on the customer. |
| When the customer **has** a pin | The question is **not rendered at all** — not asked and answered "no", simply absent. The completion still stores the visit's own fix; the customer's pin is untouched. |

A stored pin is the office's data. A technician's phone on a later visit may be
in the street outside, and it does not get to move the record; correcting a pin
is a customer-form act (dispatcher/owner, `PATCH /v1/customers/:id`).

The client gates on the same rule and the server's `WHERE latitude IS NULL AND
longitude IS NULL` is the backstop — so a second device racing the same customer
cannot double-write, and no future caller can overwrite by accident.

**Also removed:** the silent auto-capture. Nothing about a GPS fix is invisible
now; the fix happens when he answers the question, which is the only moment the
answer is true.

## 2 · Several services, summed

`job_completions.service_id` was a single column (migration 022). A visit that is
repair *plus* a battery swap had no honest row — one of the two went unrecorded,
or the technician folded both into the amount and the office could not count
either.

Now `job_completion_services` (migration 024) holds one row per service, and the
`service_id` column is dropped. The existing single-service rows came forward as
line 1.

- **The sum is the sheet's, the breakdown is the server's.** The technician's
  phone adds the chosen services' `default_charge`s into the amount field — which
  stays editable, exactly as one charge always was — and the server stores each
  line with **the charge the catalogue had at completion**. The catalogue's price
  moves; the record of what the visit was quoted must not.
- **`work_summary` keeps naming the work** ("Battery replacement, Installation"),
  because that field is prose read by a human and it was never the count. The
  lines are the count.
- **A service with no price contributes nothing** to the sum rather than blocking
  it; the price of the visit stays his to type.
- **The same service twice is one line** — the client refuses the second pick and
  the table has `UNIQUE (job_card_id, service_id)`.

The owner's job detail read changes with it: `serviceName: string | null` becomes
`services: { name, charge }[]`, so an owner sees *what* was done and what each
part of it was priced at.

## 3 · The tracking audit: it works, and the console was lying

Pings are flowing — 20 rows for `tech1` across three days, inside the 09:00–19:00
IST Mon–Sat window, with offline buffering visibly working (a morning's pings
arriving as one batch when the phone next woke). Nothing was wrong with the
tracking.

**What was wrong was `v_employee_tracking_health`.** It picked the newest-*created*
device row, and any login creates one — so a test script, or an API integration
suite, signing in as a technician added a `location_permission='none'` device and
the roster then read `permission_missing` for a technician whose pings were
demonstrably arriving. Migration 025 makes a device that *has* background
permission outrank a newer headless login. `tech1` now reads `active`; before, he
read `permission_missing` with a six-minute-old ping on the table.

## Where it lives

| Piece | File |
| --- | --- |
| The lines table | `apps/api/src/db/migrations/024_completion_services.up.sql` |
| The health-view fix | `apps/api/src/db/migrations/025_tracking_health_device.up.sql` |
| The wire shapes | `packages/shared/src/schemas.ts` — `jobCompleteSchema.serviceIds`, `JobCompletionDetailSchema.services` |
| Register-only-when-absent | `apps/api/src/modules/customers/repo.ts` — `setSitePinIfAbsent` |
| Validate + insert the lines, the pin | `apps/api/src/modules/jobs/service.ts` — `completeJob` |
| The sheet's services and the location question | `apps/mobile/src/screens/technician/CompleteSheet.tsx` |
| The pure rules (`sumServiceCharges`, the blocker) | `apps/mobile/src/screens/technician/completeSheet.ts` |
