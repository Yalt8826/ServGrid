# Technician — Screen Specifications

Density `field`. Online (decision 2026-09-15): every screen reads `GET /v1/technician/work` through an in-memory cache, so **a revisit shows its content at once and refetches quietly**; only a cold first load waits. Eight users, Phase 1.

Four tabs: Dashboard · Jobs · **Cash** · Profile. Cash gets a tab rather than a row inside Profile because it is touched once a day, at the end of a shift, by someone who wants to leave — and a skipped handover is the `missing_submission` row the owner's whole queue exists to catch (`PLAN.md` §8).

**The role's condition:** standing, one hand, often gloved, often in poor light or direct sun, sometimes with no signal and a customer watching. He wants to finish and leave. Every screen below names the worst moment it must survive.

---

## T1. Dashboard

**Purpose.** Answer "what am I doing now, and is anything wrong?" in under three seconds, first thing in the morning, in a van.

**Worst moment.** 09:05, sunlight through a windscreen, engine running, phone in one hand.

### Anatomy

```
┌────────────────────────────────────────┐
│ Good morning, Ravi                     │  header
├────────────────────────────────────────┤
│  6      2         1                    │  ← display 32 Condensed
│  today  done      overdue              │     three figures, one row
├────────────────────────────────────────┤
│ ● Tracking active · last ping 6 min    │  TrackingHealthChip
├────────────────────────────────────────┤
│ NEXT                                   │
│ ┌─┬────────────────────────────────┐   │
│ │▌│ Kormangala 3rd Blk    JC-…0042 │   │  ← the one big card
│ │▌│ Battery swap · UPS 850VA       │   │
│ │▌│ 14:30   [In warranty]          │   │
│ └─┴────────────────────────────────┘   │
│ [ Navigate ]        [ Start job ]      │  ← secondary + primary
├────────────────────────────────────────┤
│ LATER TODAY                            │
│ ┌─┬─────────────────┐ (compact rows)   │
└────────────────────────────────────────┘
```

### Content

- **Three figures only**: today's open, done today, overdue. `display` 32 Condensed, tabular. Not six. Not a chart.
- **Tracking health chip**, always visible. Red or amber is tappable into the permission ladder.
- **NEXT** — the single next job as a full `JobCard` with two actions inline: *Navigate* (secondary) and *Start job* / *Arrive* (primary, the screen's one accent).
- **LATER TODAY** — remaining jobs as compact rows, tappable.
- Pull to refresh refetches the work read (`02-MOTION.md` §6).

### States

- **Empty (no jobs):** "No jobs assigned today." + secondary *Refresh*. No illustration.
- **Offline:** the full-screen *No connection* gate (`08-SHARED-SCREENS.md`), over the screen rather than instead of it.
- **Sending:** the card whose status change is in flight carries the dashed inset and *Sending…*; the screen does not.
- **Loading:** skeletons on a cold first load only; a revisit shows the cached read and refetches quietly.

### Motion

Figures count up from zero on first focus only, 380ms `enter`, tabular so no reflow. On subsequent focus they are already correct — no re-animation. The NEXT card does not animate in.

### Not on this screen

No revenue. No charts. No "team activity". No motivational copy. No weather. **No earnings figure** — `PLAN-BACKEND.md` open item 2 proposes the technician does not read back amounts, and the dashboard is where that temptation lands first.

---

## T2. Jobs

**Purpose.** Find a job. Three tabs: **Today · Upcoming · Completed**.

**Worst moment.** Looking for a job the office mentioned on the phone, while the customer waits.

### Anatomy

Header with tabs (accent underline slides, `base` 220ms). Full-bleed `JobCard` list, `space.3` between. FlashList.

Sort: Today by `scheduled_for` ascending, **overdue first**. Completed by `completed_at` descending.

### Content

Each card: rail · customer + area · job number (mono, right) · service + unit · scheduled time · chips (`Overdue`, `In warranty`, `AMC`) · status pill.

A search field appears in the header only when the tab holds more than 12 jobs — a technician with six jobs does not need search, and an always-present empty field is clutter he has to scroll past.

### States

- **Empty, Today:** "Nothing scheduled today." + *Check upcoming*.
- **Empty, Completed:** "Nothing completed yet today."
- **Sending:** dashed inset and *Sending…* while a status change is in flight. The job number is always the server's.
- **Refused:** the server's sentence shows on the screen that submitted — the sheet or the job detail — not on the card. The card keeps its **real status rail**; a job the office cancelled simply arrives cancelled on the next read.

### Motion

Tabs: underline slides, content cross-fades 140ms. **No stagger, no entrance animation.** A card arriving on a refetch animates in at 140ms — the only entrance on this screen, and it means "this is new".

### Not on this screen

No filter bar (that is the dispatcher's screen). No bulk actions. No map. No amounts.

---

## T3. Job detail

**Purpose.** Everything needed to do the job, and the controls to advance it.

**Worst moment.** Basement, weak signal, torch in the other hand, deciding whether this unit is under warranty.

### Anatomy

```
┌────────────────────────────────────────┐
│ ←                          JC-2627-0042│  mono, always same place
├────────────────────────────────────────┤
│ ─●───────○────────○────────○           │  StatusStepper — the hero
│  Assigned  En route  In prog  Complete │
├────────────────────────────────────────┤
│ Sunrise Apartments, Kormangala 3rd Blk │  h1
│ 14:30 today · Battery swap             │
│ [In warranty · to 14 Mar 2027]         │
│ [AMC · until 14 Sep 2027]               │
├────────────────────────────────────────┤
│ THE UNIT                               │
│ UPS 850VA · Luminous · SN LM8842219    │
├────────────────────────────────────────┤
│ CONTACT                                │
│ Mr Prakash            [Call] [Navigate]│
├────────────────────────────────────────┤
│ DESCRIPTION / NOTES / STACK / TIMELINE │
├────────────────────────────────────────┤
│ [ Cancel ]          [ Complete job ]   │  fixed 72 thumb bar
└────────────────────────────────────────┘
```

### Content

- **Stepper** at the top — position in the day's work is the first thing.
- **Unit** (`job_cards.customer_product_id`) with serial. Warranty chip carries the expiry date.
- **AMC chip** when the job is under the customer's AMC — *AMC · until 14 Sep 2027*. Never a price.
- **Call** dials; **Navigate** deep-links to `google.navigation:q=lat,lng`. There is no map in the technician app.
- **Timeline** from `job_events`, collapsed, `occurred_at` times.

### States

- **Sending:** dashed inset on the header and *Sending…* on the action while a status change is in flight; the stepper advances when the server accepts.
- **Refused:** the server's `message` verbatim, pinned under the header, with one action — *Refresh* — that loads the office's version (`PLAN-FRONTEND.md` §5).
- **Closed:** thumb bar collapses to a single `Completed 16:42` line. No revenue.

### Motion

The stepper is the hero (`02-MOTION.md` §5.1). *Complete job* raises the sheet **from the button**, stepper still visible above it.

### Not on this screen

No amount, ever, after completion. No customer history. No other technicians' jobs. No edit — a technician does not edit the job, he advances it.

---

## T4. Complete sheet

**The highest-stakes screen in the product** (`PLAN-FRONTEND.md` §9). One-handed, poor light, gloves, someone waiting.

**Worst moment.** All of them at once, with 8% battery.

### Anatomy — one screen, no wizard, no page two

```
┌────────────────────────────────────────┐
│ ══                Complete JC-…0042  ✕ │
├────────────────────────────────────────┤
│ Work done                              │
│ ┌────────────────────────────────────┐ │  multiline, 3 rows
│ └────────────────────────────────────┘ │
├────────────────────────────────────────┤
│ Amount collected                       │
│ ₹ ┌──────────────────────────────────┐ │  MoneyField, mono, large
│   └──────────────────────────────────┘ │
│ + Add discount                         │  secondary disclosure
├────────────────────────────────────────┤
│ Paid by                                │
│ [  Cash  ] [  UPI  ] [  Card  ]        │  3 segments, 52 tall
│                                        │  (of 5 enum values — see below)
├────────────────────────────────────────┤
│ ▸ Parts & equipment             (0)    │  collapsed
│ ▸ Photos                        (2)    │
├────────────────────────────────────────┤
│ ☐ Customer confirmed the work          │
├────────────────────────────────────────┤
│ [        Complete job        ]         │  never disabled for network
└────────────────────────────────────────┘
```

### The conditional behaviours

- **AMC job:** two segments above the money — **Free under AMC** (selected) and **Charge**. On Free the amount field and the Paid-by segments are **absent** — not zero, not disabled — and nothing is collected. Charge brings the ordinary money fields back for extra work the customer pays for.
- **In-warranty unit with a charge entered:** one confirmation on submit — *"This unit is under warranty until 14 Mar 2027. Charge anyway?"* A prompt, not a block. **The only dialog on this sheet**, which is what keeps it meaningful.
- **Discount:** the disclosure opens amount **and** reason together, and the database refuses the row without a reason.
- **Three segments, five enum values, and `none` is not one of the three.** `collection_mode` carries `cash | upi | card | bank_transfer | none`. `bank_transfer` does not happen at a doorstep — that is a company paying an invoice, which is the rep's `payments` flow.

  **`none` is load-bearing and the sheet has to be able to produce it.** `completion_mode_coherent` exists precisely so a zero-charge completion records that no money changed hands, and a warranty job forced to say *paid by cash* puts ₹0 of phantom cash into that technician's reconciliation and makes his handover look wrong.

  So it is a **consequence, not a segment**: when the amount after discount is zero — or empty — the Paid-by segments are replaced in place by a single non-interactive line reading **"No payment taken"**, and `none` is submitted. The moment a non-zero figure is typed the segments return. A technician closing a warranty job is never asked how he was paid for work that was free, which is both the correct data and one fewer decision on the sheet that can least afford one.
- **Parts:** collapsed, below the amount, **never a subtotal**.

### Parts and equipment are one list, not two

An earlier draft had two disclosures — *Parts used* and *Equipment fitted* — and the distinction is invisible from where the technician is standing. He has just fitted a battery. Is that a part he used or equipment he fitted? It is both, and two sections means either entering it twice or guessing which one the office wants. Two sections also means the site's equipment record depends on a technician noticing a second collapsed row on the highest-stakes screen in the product, which is how a site's stack quietly stops matching reality.

So there is **one list and one extra question per line**:

```
Parts & equipment                          (2)
┌─────────────────────────────────────────────┐
│ Exide 150Ah battery              qty 1   ✕  │
│ Serial  [ EX2291184          ]              │
│ ☑ Add to this site's equipment              │
├─────────────────────────────────────────────┤
│ Terminal block (free text)       qty 2   ✕  │
│ ☐ Add to this site's equipment              │
└─────────────────────────────────────────────┘
[ + Add ]
```

The checkbox **defaults from the product's category**: on for `ups`, `battery` and `inverter`, off for `accessory` and `spare`, and off for a free-text line with no product behind it. A technician fitting a battery gets the right answer without touching it; a technician fitting a filter gets the right answer without touching it. The default is a suggestion he can override, not a rule — a spare fitted as a permanent replacement is a real case.

**The server contract does not change.** One UI list still produces the two payload arrays `PLAN-BACKEND.md` §6.2 already specifies: every line becomes a `job_completion_parts` row, and every ticked line *also* becomes a `stackChanges[]` entry stamped with `source_job_id`. They remain separate server-side because they are separate facts — what was consumed on this job, and what is standing at that site — and only the second survives the job. Collapsing them in the database would lose that; collapsing them in the UI is what stops one of them being forgotten.

**Still no subtotal, and the checkbox does not change the amount.** Neither list has ever fed the money, and putting a tick beside a part must not suggest that it now does.

### Motion

Rises from the button, `spring.sheet` 300ms, stepper visible above. Disclosures expand 220ms height+opacity. Segment select: `Selection` haptic, underline slides. Submit: button → `loading`; when the server accepts, `NotificationSuccess` and the sheet dismisses at 220ms — **not on tap**, because the honest signal is delivery, not intent. On failure the sheet stays open with everything typed and the server's sentence (or *not reached*) above the button.

### Never

- Never disable submit for a network reason.
- Never a required photo — a technician in a dark basement with a cracked camera still needs to close the job.
- Never a second page.
- Never show the expected-cash figure.

---

## T5. Cancel sheet

**Purpose.** Record a trip that did not produce work, and decide whether it can still happen.

**Worst moment.** Locked gate, customer not answering, and he has four more jobs today.

### Anatomy

Reason code — a list of large tappable rows, **not a dropdown** (`customer_unavailable`, `no_access`, `parts_unavailable`, …) · note (required for `other`) · **Reschedule to** date picker, skippable.

### AMC jobs

No warning and no special case: an AMC carries no visit count, so cancelling spends nothing, and a new date raises a successor still linked to the AMC.

`rescheduleTo` is bounded: not in the past.

### Motion

Same rise as the complete sheet. Reason selection: `Selection` haptic, row fills `slate.900`. Choosing a date reveals a one-line confirmation — *"Visit moves to 22 Mar."*

---

## T6. Cash handover

**Purpose.** Declare the cash being handed over. One number.

**Worst moment.** 19:10, tired, at the office counter, wanting to go home.

### Anatomy

Date (today, changeable back 7 days) · **one large `MoneyField`** · optional note · *Submit declaration*.

Below: his own history — date, declared, status pill (`Submitted` / `Confirmed` / `Disputed`).

### The two absences, both deliberate

- **No expected figure.** He declares; the system's expectation is the check. Showing him the answer turns a reconciliation into a form-fill (`PLAN-BACKEND.md` §10).
- **No expenses field.** Technicians do not spend from collections, so the screen stays at one number and a note.

### States

**Already submitted, not yet acted on** (`status = 'submitted'`): the field is replaced by the declared amount, the status pill, and an *Amend* action. He can correct his own figure until the owner confirms or disputes it.

That correction path is not a convenience. Without it a technician who types ₹4,500 for ₹45,000 has no route at all — the row is unique per employee-day so he cannot resubmit, and *reopen* only returns a **confirmed** row to `submitted`, which his is already. The mistake would sit in the owner's queue as a ₹40,500 variance until someone confirmed a figure they could see was wrong, and a queue where variances are sometimes typos is a queue that gets skimmed.

**Confirmed or disputed:** the amount is read-only and *Amend* is gone. The copy says why — *“The office has confirmed this day. Ask the owner to reopen it.”* — which is the same rule as amending a completion (`PLAN-BACKEND.md` §6.2b), at a different door: **correctable until signed off, then it takes a deliberate second action by someone else.**

---

## T7. Profile

**Purpose.** Prove tracking works, and fix it when it does not.

**Worst moment.** The owner has just asked why his location stopped updating at 11:00.

### Anatomy

Name, role, username · **`TrackingHealthChip`, prominent** · the permission ladder as four rows with individual state:

```
✓ Location while using          Granted
✓ Location all the time         Granted
✓ Battery optimisation          Exempt
⚠ Xiaomi autostart              Not confirmed   [ Fix ]
```

Then: app version · device model · *Change password* · *Log out*.

### Logout

Immediate. Nothing is queued on the phone, so there is nothing to lose (decision 2026-09-15). The ladder's battery and autostart answers live on the server (`GET /v1/devices/me`) and come back after a reinstall.

### Motion

Ladder rows resolve with a 140ms colour change and a checkmark scale-in when a permission is granted on return from settings — the one place a small celebratory beat is earned, because the user just completed something genuinely tedious.

### Not on this screen

No earnings. No performance stats. No leaderboard. **No ranking of technicians against each other** — `PLAN.md` §11 names employee reaction to tracking as a live risk, and gamified surveillance is the fastest way to realise it.
