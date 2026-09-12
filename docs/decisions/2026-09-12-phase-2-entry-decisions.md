# Phase 2 entry decisions — memos for the owner

Date: 2026-09-12 · Status: **DECIDED — both recommendations accepted by the owner, 2026-09-12**

Phase 2 (Dispatcher) has two hard entry gates (Job Logs human trials; FCM proven end
to end) and, per `docs/implementation/PHASE-2-DISPATCHER.md` ("Also decided before
starting") and `docs/PLAN-EXECUTION.md` Part I §4, **two decisions that must be taken
before the phase starts**. They are recorded here as `PLAN-BACKEND.md` §15 open items
5 and 6; when you decide, the chosen option is marked in this file and the plan's open
items get their "Closed:" note.

---

## Memo A — What the notification says when work is TAKEN AWAY (PLAN-BACKEND §15 item 5)

**Decision needed.** On a reassign — including every job in a bulk reassign — the
server fires a data-only push to **both** handsets (§12.1: the push carries no job
content; each app syncs and raises a *local* notification from the synced row). The
gaining technician's copy is obvious ("New job assigned"). The losing technician's
copy is this decision: what does his phone say when a job is moved off him?

**What the wording has to accomplish (and not):**
- Its one real job is to prevent the failure mode "drives to a site for a job he no
  longer has". So it must answer: *do I still go?* — clearly, with no action required.
- It must not read as blame or surveillance. `PLAN.md` §11 names employee reaction to
  tracking as a live risk, and reassigns are routine (load balancing, sick days,
  emergency reshuffles) — the copy will be seen often.
- The Phase 2 exit criterion "bulk reassign used at least once on real data **without
  a support call**" is a wording test as much as a flow test: a copy that alarms
  generates a call to the office.

**Options**

| | Copy | Verdict |
|---|---|---|
| **A1 (recommended)** | Title: **Job reassigned** · Body: **`<job_number>` is no longer yours. You don't need to do anything.** | States the fact, answers "do I still go?" (no), requires nothing, cannot be read as accusation. The reassigned job is never `in_progress` (T2.3 refuses that), so nothing is being taken out of his hands mid-work. |
| A2 | No notification for the losing technician — the job just disappears at the next sync | Spares embarrassment, but reintroduces the drive-to-a-dead-site failure and makes the sync the only signal. The plan's push exists precisely because sync is not immediate. |
| A3 | "Hand back `<job_number>` — it was reassigned" | Reads as a demand; worse, it implies an action that does not exist — the server has already reassigned it. |

**Sub-decision (bulk).** A bulk reassign can move N jobs off one technician. N
notifications is exactly the "notification fatigue → technician silences the app"
risk the plan names. Recommended: **collapse to one** — the client counts the rows
the delta removed and posts a single summary: *"3 of your jobs were reassigned. You
don't need to do anything."* Single reassigns keep the A1 copy.

**Decision:** ☑ **A1** ☐ A2 ☐ A3 · Bulk collapse: ☑ **yes** — Decided by the owner, 2026-09-12 (accepted the recommendation as written).

---

## Memo B — Pushes for jobs assigned OUTSIDE the 09:00–19:00 work window (PLAN-BACKEND §15 item 6)

**Decision needed.** Location pings already stop outside the work window. Notifications
currently would not: a job assigned at 21:00 would push at 21:00. Plan's proposal:
**suppress until the window opens, except `priority = 'urgent'`.**

**What the decision interacts with:**
- The consent screen (T1.16) promises, about *tracking*: "**Never outside those
  hours**." Letting pushes run around the clock extends the leash past the promise the
  technician already signed — the fastest way to make the app feel like 24/7
  surveillance and trigger the named staff-relations risk.
- Night delivery is unreliable *anyway*: data-only FCM to an app the OS has idle-killed
  is dropped (that is precisely what T0.15 runbook step 6b exists to probe). A policy
  built on reliable 21:00 delivery would be built on sand.
- The genuine harm of suppression: an evening assignment for tomorrow morning would be
  learned late. But jobs are scheduled inside the window too, the technician is not
  expected on site before it opens, and `urgent` bypasses.

**Options**

| | Rule | Verdict |
|---|---|---|
| **B1 (recommended)** | **Hold, don't drop:** assignments outside the window are *released at window-open* (09:00, or immediately if promoted to `urgent`). `urgent` pushes immediately, always. In-window assignments push immediately. | Keeps the consent screen's promise, works with FCM's night-delivery reality, and loses nothing: the morning's work is announced at 09:00 sharp, urgent never waits. Server-side hold only — the client learns nothing new. |
| B2 | No suppression — push whenever assigned | Simplest, and matches "the office may assign anytime". Costs: breaks the spirit of the hours promise; trains people to silence the app (notification-fatigue risk), which then suppresses *urgent* pushes too — the worst outcome. |
| B3 | Hard suppression — night assignments surface only at next app open | Zero server machinery, but a technician who opens the app at 08:50 misses a 09:00 assignment that B1 would have announced. Weaker than B1 for no saved complexity worth having. |

Implementation note for whichever is chosen: the hold is **server-side** in T2.5's
send path (one check against `WORK_WINDOW_START/END` + `priority`); released pushes
fire at window-open in a batch. The technician's own window is IST-fixed per
`.env`; no per-employee calendars exist in Phase 2.

**Decision:** ☑ **B1** ☐ B2 ☐ B3 — Decided by the owner, 2026-09-12 (accepted the recommendation as written, including the hold-and-release refinement and the `urgent` bypass).

---

*Both decisions were taken on 2026-09-12 on the owner's instruction, accepting the
recommended options as written. This file is the record; `PLAN-BACKEND.md` §15
items 5–6 carry the corresponding "Closed:" annotations. T2.5 implements the
hold-and-release send path and T2.6 composes the A1 copy with the bulk collapse —
neither exists yet, and both are Phase 2 work.*
