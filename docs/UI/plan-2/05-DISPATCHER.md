# Dispatcher — Screen Specifications

Density `console`. **Online-only**, like every role since 2026-09-15. The failure mode is an explicit error state, never a queue and never a spinner that resolves into nothing.

Three users, Phase 2. Seated, at a desk, on office wifi, working from a **phone**.

**The role's condition:** bare hands, both hands available, good light, but working at volume — 200+ jobs and a phone ringing. Speed of *scanning* is the whole job. This is the one place where `field` density would be wrong: bigger is slower here.

**`PLAN.md` §11 names Job Logs on a phone as the one screen where the phone-first decision costs something real.** Everything below is written to make that screen work; if it does not pass the five-second test, the descope is the desktop web build (`PLAN-EXECUTION.md` Phase 2).

---

## D1. Dashboard

**Purpose.** Answer "what is wrong right now, and who is free?" before the phone rings again.

**Worst moment.** 09:15 Monday. Two technicians have called in, and a customer is on hold.

### Anatomy

```
┌────────────────────────────────────────┐
│ Dispatch                     Mon 6 Sep │
├────────────────────────────────────────┤
│   3          7          12       2     │
│   OVERDUE    unassigned  today   done  │  ← overdue first, danger colour
├────────────────────────────────────────┤
│ [ + Dispatch a job ]                   │  ← the one primary action
├────────────────────────────────────────┤
│ TECHNICIAN LOAD                        │
│ Ravi      3 ▓▓▓░░░░░░░           active│
│ Anitha    6 ▓▓▓▓▓▓░░░░           active│
│ Suresh    0 ░░░░░░░░░░      ⚠ no ping  │
├────────────────────────────────────────┤
│ NEEDS ATTENTION                        │
│ ┌─┬──────────────────────────────────┐ │
│ │▌│ 3 days overdue · JC-…0031        │ │
└────────────────────────────────────────┘
```

### Content

- **Overdue leads**, in `feedback.danger`, and it is the largest figure on the screen. It is the only number here that represents a promise already broken — unassigned work is a queue, overdue work is a customer who was told a day.
- **Technician load** as a live list with inline bars — the same component as the assignment picker, so the dispatcher reads one visual language for "who is busy" everywhere.
- A technician whose tracking is stale carries a warning inline. The dispatcher is the person who will actually notice.
- **Needs attention**: overdue jobs, then unassigned, then **jobs still `assigned` past their scheduled time** — someone was due there and has not set off.

**Not** "jobs rejected from a technician's outbox", which an earlier draft listed. There is no outbox any more: a refused technician submit is answered on his own screen, at the moment he submits. The dispatcher-visible half of that problem is the job the office cancelled while the technician was on his way, which is simply a cancelled job.

### States

- **Empty (nothing overdue):** the figure is `0` in `text.secondary`, not hidden. Absence of a problem is information.
- **Offline:** the full-screen *No connection* gate (`08-SHARED-SCREENS.md`) covers the dashboard, so **no dispatch decision is made from figures that stopped being live**.
- **Error:** the failed section shows the error and a *Retry*; other sections keep working.

### Motion

Load bars draw on focus, staggered 30ms. Figures do not count up — a dispatcher returning to this screen twenty times a day does not want a performance each time. They change value with a 140ms cross-fade.

### Not on this screen

No revenue. No completion amounts. No cash figures. `MoneyGate` wraps nothing here because nothing on this screen is money — and the CI assertion in `PLAN-EXECUTION.md` Phase 2 verifies no dispatcher payload carries a completion field at all.

---

## D2. Job Logs — the screen that costs something

**Purpose.** Find any job, by any attribute, fast.

**Worst moment.** A customer on the phone asks about "the Kormangala job last Tuesday" and there are 200+ jobs.

**The test it must pass:** *a dispatcher answers "who has the Kormangala jobs today" in under five seconds, on a phone, against 200+ jobs* — measured with real dispatchers on their own handsets, median under 5s (`PLAN-EXECUTION.md` Phase 2 entry gate).

### Anatomy

```
┌────────────────────────────────────────┐
│ ← Job Logs                    ⌕  ⋮     │
├────────────────────────────────────────┤
│ [Today ▾][Anyone ▾][Any status ▾] ✕    │  ← FilterBar, sticky, always
├────────────────────────────────────────┤
│ 24 jobs · 3 overdue                    │  ← result count, always
├────────────────────────────────────────┤
│ ▌JC-…0042  Kormangala 3rd Blk          │
│ ▌Ravi · 14:30            ● In progress │  ← 56pt row, two lines
├────────────────────────────────────────┤
│ ▌JC-…0043  Indiranagar 100ft Rd        │
│ ▌Anitha · 15:00          ● Assigned    │
└────────────────────────────────────────┘
```

### The design decisions that make five seconds possible

**The filter bar is persistent and always visible** — sticky under the header, never collapsing on scroll. Three dropdown chips: date, technician, status. Each opens a sheet of large rows, not a native picker. **Filter state lives in the URL**, so a filtered view survives a reload and can be shared.

**Two-line rows at 56pt, not cards.** This is the density decision. A `field`-density card list shows four jobs per screen; this shows eight, with the scannable left edge intact.

**The row itself is the tap target, at 56pt** — above the global 52 (`PLAN.md` §9), so the main interaction on this screen is not a compromise. The 44pt floor in `console` applies to the filter chips and header actions, each with 8pt hit slop; the dispatcher is seated and bare-handed, which is what makes that safe here and nowhere else (`01-FOUNDATIONS.md` §3).

**The left rail carries status colour**, so the answer to "what state is everything in" is available peripherally, without reading.

**Result count above the list**, always. "24 jobs · 3 overdue" tells the dispatcher whether the filter worked before they scroll.

**Search is a separate mode**, not a field competing with the filter bar. The ⌕ opens a full-screen search over job number, customer, phone and area, with results in the same row component.

**FlashList**, `estimatedItemSize` from a measured row, memoised `renderItem`. Zero dropped frames scrolling 200 rows on the roster's slowest handset is a Phase 5 matrix row.

### Multi-select and bulk reassign

Long-press enters selection mode (`PLAN.md` §8) — **not checkboxes**, which at this density would be a 24pt target next to a 44pt row.

At the 400ms threshold: `Selection` haptic **before the finger lifts**, card scales to 0.97, border strengthens (`02-MOTION.md` §5.4). Header cross-fades to `3 selected` with *Reassign* and *Cancel*. Subsequent taps toggle.

*Reassign* opens the `TechnicianPicker`. Partial results are shown honestly: *"5 reassigned, 1 failed — JC-…0044 was completed while you were choosing."*

### The fallback, if five seconds is not met

A compact two-line row at **44pt** with the filter bar pinned, accepting a smaller tap target on this one screen because a dispatcher is seated and not wearing gloves. If that still fails, the phase descopes to the desktop web build with owner sign-off.

### States

- **Empty (filtered):** "No jobs match these filters." + *Clear filters*. The filter bar stays visible — the user needs to see what they set.
- **Empty (unfiltered):** "No jobs yet."
- **Offline:** the full-screen *No connection* gate. A filter applied to data that stopped being live produces a confident wrong answer, so none is shown.
- **Loading:** skeleton rows after 200ms, exact row geometry.

### Motion

**Filter change re-sorts without animation.** No stagger, no re-entrance. When 24 rows resolve to 6, the list simply is six rows — animating the transition costs 300ms of the five-second budget and tells the dispatcher nothing they did not just ask for.

The only motion: the filter chip's fill change (140ms) and the row press state (90ms).

---

## D3. Dispatch Job

**Purpose.** Raise a job and assign it, while the customer is still on the phone.

**Worst moment.** Mid-call, customer reciting an address, needing a technician named before they hang up.

### Anatomy — single scroll, no wizard

```
Customer      [ search or create          ⌕ ]
              ↳ inline results, tap to select
              ↳ "+ New customer" if no match

The unit      [ UPS 850VA · SN LM8842219  ▾ ]  ← from that site's stack
Service       [ Battery swap              ▾ ]
Priority      [ Low ][ Normal ][ High ][ Urgent ]
Schedule      [ Today ▾ ] [ 14:30 ▾ ]
Contact       name · phone  (prefilled from customer)
Notes         [                              ]

Assign to     ┌────────────────────────────┐
              │ Ravi     3 ▓▓▓░░░░░  active│
              │ Anitha   6 ▓▓▓▓▓▓░░  active│
              │ Leave unassigned           │
              └────────────────────────────┘
[ Create and assign ]
```

### Content decisions

- **Customer search-or-create is one field**, not a choice between two flows. Typing searches; no match offers create inline.
- **The unit picker reads that site's stack**, so a customer with five UPS units produces a job that names one. Skippable — a dispatcher taking a call may not know.
- **Priority as four segments**, not a dropdown. `Urgent` is the only value that overrides notification work-window suppression, and it is worth the dispatcher seeing that choice explicitly.
- **The assignment picker is inline at the bottom**, sorted by load ascending, with *Leave unassigned* as an explicit last option — never the silent default.
- **No `company_id` field.** Dispatchers have no company permission; the API strips it (`PLAN-BACKEND.md` §5).

### Motion

Customer results appear 140ms, no stagger. Selecting a customer collapses the search to a single line and reveals the unit picker — 220ms height, the one progressive-disclosure moment. Load bars draw when the picker scrolls into view.

Submit: button `loading`, then a toast — *"JC-2627-0044 assigned to Ravi"* — with the number, because the dispatcher may need to read it back down the phone.

---

## D4. Customer

**Purpose.** Find a customer, see their site and history, correct their details.

### Anatomy

Search over name and phone · results as two-line rows. Detail: name, phones (tappable to call), address, area · **the product stack, read-only** · job history as `JobRow`s · notes.

### The two absences

- **No company field.** Not on the form, stripped server-side.
- **The stack is read-only here.** Technicians own the stack because they are the ones who know what got fitted (`PLAN.md` §4). A dispatcher editing it from a phone call is how a serial number becomes wrong.

---

## D5. Contracts — read-only

**Purpose.** Know that a job is a contract visit, and what number visit it is, when the customer rings about it.

### Anatomy

List of active contracts by site: contract number (mono) · customer · `visit 3 of 4` · next due date · `attempt_count` when above 1.

Detail: the visit schedule as a vertical list with status per visit, and the job cards under each.

### The hard constraint

**No `contract_value`. Anywhere.** Reads come from `v_contract_visits_dispatcher`, which has no value column, and the Phase 2B CI assertion verifies no dispatcher payload carries one (`PLAN-DATA-MODEL.md` §4).

The dispatcher can move a visit's due date (`PATCH /v1/contracts/visits/:id`) — the office-side reschedule, for when the customer phones ahead. The technician's on-site version lives on his cancel sheet.

**`attempt_count` above 1 is surfaced deliberately.** A visit on its third attempt is a site worth ringing before sending anyone again, and that is invisible unless the view counts it.

---

## D6. Profile

Self only. Name, username, *Change password*, *Log out*, app version.

**No tracking chip.** Dispatchers are not tracked.

Logout is immediate — there is nothing queued to lose.
