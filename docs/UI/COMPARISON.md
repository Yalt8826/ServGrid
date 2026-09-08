# UI Plans — Comparative Report

A review of the two competing UI design plans in `docs/UI/plan-1/` and `docs/UI/plan-2/`:
their themes, design languages, philosophies, where they agree, where they genuinely
disagree, and where each is right or wrong on the facts.

**Method.** Both sets were read in full (3,894 lines). Every contrast ratio either plan
asserts was recomputed with the WCAG 2.x relative-luminance formula against the settled
palette. Every claim about the domain — cash flow, collection modes, schema fields,
permissions — was checked against `PLAN.md`, `PLAN-FRONTEND.md`, `PLAN-BACKEND.md`,
`PLAN-DATA-MODEL.md` and `PLAN-GAPS.md`. Findings marked **[verified]** were checked;
findings marked **[judgement]** are design opinions where both plans are defensible.

---

## 1. What the two documents are

| | plan-1 | plan-2 |
|---|---|---|
| Total | 1,825 lines | 2,069 lines |
| Screen specs | 42 (`TEC-01…07`, `DIS-01…06`, `SAL-01…07`, `OWN-01…14`, `SHR-01…08`) | 37 (`T1…7`, `D1…6`, `S1…7`, `O1…9`, `X1…8`) |
| Heaviest file | `07-OWNER.md` (374 lines) | `01-FOUNDATIONS.md` (235 lines) |
| Centre of gravity | **Screens** — owner coverage is 2× plan-2's | **Foundations and motion** — 443 lines vs plan-1's 217 |
| Self-description | "completes the settled language into a buildable system" | "instrument-grade — it should feel like well-made equipment, not like software" |

They are siblings, not independent proposals. Both take the same four reference objects
(multimeter, UPS panel, carbon-copy docket, safety yellow), both reach the same central
claim about waiting, both use the phrase "reduced motion removes movement, never feedback",
and both open with a non-adoption list. The disagreements below are the interesting part
precisely because the shared surface is so large.

---

## 2. What they agree on

Both, independently, commit to all of this — which means it is settled and no longer worth
re-litigating:

- **Smoothness is the absence of waiting**, not the presence of animation. Optimistic
  writes are the product's real luxury; the UI's job is to make instantaneity visible.
- **The worst moment is the design brief.** Every screen in both sets names the physical
  condition it has to survive. Neither designs for the demo.
- **Battery is a design material.** No blur, no shimmer, no continuous animation, no
  shadows on Android list items — because the handset is also the tracking device.
- **Skeletons never on offline-first screens.** A skeleton over a local mirror read is a
  lie about the architecture. Both say this in nearly the same words.
- **Never a fabricated job number.** "Pending sync" stands where the number goes.
- **Rejections are banners with the server's message verbatim**, never toasts, never
  auto-dismissing, with *Discard my copy* / *View the office version*.
- **Logout is a gate**, not a confirm-and-lose dialog, while rows are queued.
- **Parts never show a subtotal** and sit below the amount field, never above.
- **Prepaid contract visits remove the amount field entirely** — absent, not zero, not
  disabled.
- **Icon-only is banned for anything that changes data.**
- **No illustrated empty states**, no mascots, no motivational copy.
- **No leaderboards or rankings** between technicians — both cite tracking as a live
  staff-relations risk and refuse to gamify it.
- **The same job is a card on a phone and a table row on desktop**, as a review checkpoint.

---

## 3. Philosophy — the real divergence

Both open by reconciling the same tension: `PLAN.md` §9 permits *one orchestrated moment*,
while the brief asked for something smooth and heavily animated. Both resolve it with the
identical sentence — **`PLAN.md` restricts orchestration, not responsiveness** — and then
spend that permission very differently.

**plan-1 treats the settled plan as a fence.** Its philosophy is organised around a single
claim — *every screen tells the truth about the state of the work* — with three corollaries:
never blocks, never invents, never swallows. The document's energy goes into making that
claim falsifiable: measured contrast floors, a state matrix, a bijection check between
components and screens, and a "Not on this screen" fence at the bottom of all 42 specs.
The word that recurs is **honest**. Its five signature tells are all state-carrying: the
rail, "Pending sync", the health chip, Condensed figures, the stepper.

**plan-2 treats the settled plan as a floor.** Its philosophy is organised around *it should
feel like well-made equipment*, with Dieter Rams added as a fourth reference for discipline
rather than aesthetics. It argues explicitly that the app can be *highly animated* provided
every frame is load-bearing, and then budgets **six** signature moments where plan-1 budgets
one. It adds a freshness argument plan-1 lacks — *structure ages well, effects age badly* —
and its five tells are more formal than plan-1's: the rail, tabular numerals, the docket
header position, the **2px accent underline as active state**, square corners.

The gap in one line: **plan-1 asks "is this true?"; plan-2 asks "does this feel like an
instrument?"** Both are good questions. Plan-1's produces a more auditable document;
plan-2's produces a more distinctive product.

That difference shows up in the tells. Plan-2's *active state is a 2px accent underline,
never a filled pill* is the single most identity-forming decision in either document —
it is specific, cheap, applies from the phone tab bar to the desktop rail, and nothing
else in the two plans would make a screenshot recognisable as fast. Plan-1 leaves active
state as "yellow accent" and never fixes its form. **[judgement]**

---

## 4. Design language and foundations

Same palette, same type family, same 4pt scale, same radii — inherited. The differences
are in what each plan added on top.

| | plan-1 | plan-2 |
|---|---|---|
| Greys | Two, as inherited | **Seven-step slate ramp** (`900`→`050`) derived from the base |
| Semantic layer | Alias table (`text.primary`, `status.*`, `line.default`) | Alias table plus `bg.pressed`, `bg.raised`, `line.focus`, `feedback.*` |
| Contrast approach | **Audit** — 21 measured pairs, pass/fail, failures escalated as open questions | **Floor** — asserts 7:1 for body, quotes five approximate figures, audits nothing |
| Type ramp | 7 tokens | 9 tokens (adds `displayLg` 44 for owner desktop, `bodyStrong`) |
| Density | 3 modes, named, targets only | 3 modes with a **full table**: row height, tap target, body size, gutter, rhythm |
| Elevation | Prose: borders not shadows, one sheet shadow | **Table**: `flat`/`raised`/`overlay` × Android/web, with the reason |
| Icons | `@expo/vector-icons` MaterialCommunityIcons, **filled**, 24/20/16 | **Lucide** (`lucide-react-native`), **2px stroke**, 20/24/28/16 |
| Number formats | Relative time in AgeStamps generally | **Relative time stops at 1h**, then absolute — health chip the one exception |
| Field constraints | Distributed through the prose | **A table**: condition → rule, seven rows |

**On icons, they contradict each other outright.** Plan-1 argues *filled reads better at
24px on low-DPI LCDs than outlines*; plan-2 mandates a *consistent 2px stroke* and bans
filled variants. Both are proposals resolving the same unspecified parent decision (`DQ-1`
in plan-1, unlisted in plan-2). Someone has to pick one; the sunlight argument favours
plan-1's filled set, the identity argument favours plan-2's consistent stroke. **[judgement]**

**On accessibility they diverge on cost.** Plan-1 commits to surviving **1.3× font scale**;
plan-2 commits to **200% dynamic type** with reflowing layouts and names the complete sheet
as the test case. That is not a wording difference — 200% is materially more engineering,
and it needs a decision rather than whichever document is opened first.

---

## 5. Motion — the sharpest disagreement

| | plan-1 | plan-2 |
|---|---|---|
| Budget | **1 orchestrated moment** + "interaction echo" | **6 signature moments** |
| Durations | 5 tokens (90/140/220/300/520) | 6 tokens, plus the rule *nothing between 320 and 520* |
| Springs | Named as a policy ("finger-driven settles only") | **Three configs with damping/stiffness/mass**, and a floor: never damping < 15 |
| Easing | 4 curves | 4 curves, different beziers, with the rationale |
| Everyday interactions | Not enumerated | **A 10-row table** — button, card, tab, chip, push, pop, refresh, focus, expand, toast |
| Haptics | 4 events | 9 events, mapped to `expo-haptics` constants |
| Perf budget | 6 metrics | 7 hard rules + 5 targets + where each is checked |
| Continuous animation | Banned outright | Banned with **one** exception: the owner's live-window pulse, focused-screen-only |

Plan-2's extra five moments are: the completion sheet rising **from the button that opened
it**, the pending badge **draining** with a tick per item, the long-press **pick-up** with
the haptic firing before the finger lifts, the assignment picker's **staggered load bars**,
and the rejection banner **dropping with weight**. Each carries an argument for why it is
information rather than decoration, and the arguments are good — the badge drain in
particular converts a number into the reassurance that queued work actually left the device.

But this is where plan-2 is most exposed. `PLAN.md` §9's language is "*one* orchestrated
moment… everything else answers a tap". A staggered sequence of load bars answers no tap.
Plan-2 knows this and pre-argues the case in two separate documents, which is honest, but
the budget is still where drift starts — and plan-2's own count-up on the technician
dashboard is the proof: **380ms, which falls inside the 320–520ms band its own motion
document forbids.** **[verified]**

Plan-1's motion doc is safer and thinner. It will not drift, but it is not enough to build
from: no spring constants, no per-interaction table, no library pins beyond "Reanimated".
An engineer implementing plan-1 invents the everyday feel; an engineer implementing plan-2
is told it.

---

## 6. Screen coverage

Both cover all four roles at comparable depth for technician, dispatcher and sales rep.
The owner is where they part.

- **plan-1 gives the owner 14 numbered screens**, including `OWN-04` Dispatch, `OWN-05`
  Customers, `OWN-12` Products and `OWN-13` Services as separate specs.
- **plan-2 gives the owner 9 areas**, folding Sales/Payments/Companies into one (`O5`) and
  Products/Services into another (`O8`).

**plan-2 has two coverage holes:** its desktop rail lists *Operations — Jobs · Dispatch ·
Customers · Contracts*, but there is **no owner Customers spec and no owner Dispatch spec**
anywhere in `07-OWNER.md`. Plan-1 covers both. **[verified]**

Conversely **plan-1 has a component-level hole**: it never specifies where the outbox
rejection taxonomy meets sales — and more concretely, it omits the `customer_signed`
capture entirely (see §8).

Two screens are worth comparing directly because they are the product's hardest:

**The complete sheet.** Plan-1 lays out work summary → collection mode → amount →
discount → parts → stack → photos. Plan-2 lays out work done → amount → discount →
paid-by → parts/photos/equipment → **customer-confirmed checkbox** → submit. Plan-2's
order puts money before mode and includes the checkbox `PLAN-GAPS.md` G13 asks for.
Plan-2 also specifies that the success haptic fires **when the outbox confirms, not on
tap** — "the honest signal is delivery, not intent", which is the single best line in
either document about optimistic UI.

**Job Logs.** Both treat it as the prototype gate. Plan-2's is markedly better developed:
result count above the list ("24 jobs · 3 overdue"), search as a separate mode rather than
a field competing with the filter bar, filters **disabled** when offline because a filter
over stale data produces a confident wrong answer, and honest partial-failure copy on bulk
reassign ("5 reassigned, 1 failed — JC-…0044 was completed while you were choosing").
Plan-2 also refuses to animate the filter transition on the grounds that it costs 300ms of
a five-second budget — the most disciplined motion decision in either plan, and it appears
in the document with six times the motion budget.

---

## 7. Verified audit — the contrast numbers

Every ratio was recomputed. **plan-1's figures are exact — all 21 of them.** Plan-2's five
figures are approximations, and every error runs in the flattering direction.

| Pair | Actual | plan-1 says | plan-2 says |
|---|---|---|---|
| slate on surface | **16.16:1** | 16.16 ✅ | ≈14.8 |
| muted on surface | **5.39:1** | 5.39 ✅ | ≈5.6 |
| slate on accent | **9.79:1** | 9.79 ✅ | ≈10.4 |
| white on accent | **1.68:1** | 1.68 ✅ | ≈1.9 |
| `slate.300` disabled on surface | **2.39:1** | not specified | **≈2.9** — off by half a point |

That last row matters. Plan-2 sets a 3:1 floor for disabled text, reports 2.9:1, and waves
it through as "only for genuinely inert text". The real figure is **2.39:1** — not a near
miss but a clear failure, on a token plan-2 also uses for placeholders and the stale-state
dashed inset. **[verified]**

**The more valuable finding is plan-1's, and plan-2 misses it entirely.** Plan-1 measured
the status rails against WCAG 1.4.11's 3:1 non-text floor and found two failures in the
*settled* palette:

| Element | Ratio | Verdict |
|---|---|---|
| Yellow rail on surface / dense | **1.65 / 1.53:1** | ❌ far below 3:1 |
| Amber rail on surface / dense | **2.72 / 2.51:1** | ❌ below 3:1 |
| Green rail | 4.28:1 | ✅ |
| Red rail | 6.42:1 | ✅ |

The 4px status rail is the primary signature of both plans, on every job object at every
density — and for two of its five states it does not meet the non-text contrast floor.
Plan-1 escalates this as open question `DQ-2` and proposes the right resolution: **the rail
is never the sole carrier of state**, always paired with a StatusPill, rather than
repainting a settled palette. It does the same for filled pills (`FIL-1…6`), finding that
white ink passes only on red — white on green is 4.36:1, white on amber 2.77:1 — and
routing green pills to a soft fill with dark ink.

Plan-2 asserts a 7:1 sunlight floor and then never applies it to a single status colour,
pill fill or rail. **The plan with the stricter stated standard is the one that did not
check.** **[verified]**

---

## 8. Verified audit — fidelity to settled decisions

Here the pattern inverts. Plan-1 is the more rigorous document on the visual layer and
the less rigorous one on the domain layer.

### Where plan-1 contradicts settled decisions

**8.1 — The expected-cash figure on the handover screen. [verified]**

Plan-1's `TEC-06` renders *"You collected ₹4,450 — what the office expects"* above the
declaration field, and defends it at length ("shown for honesty, not for matching").
`SAL-06` inherits the same screen verbatim.

`PLAN-BACKEND.md` §10 settles this the other way: *"The employee does not see the expected
figure before declaring. He declares what he is handing over; the system's expectation is
the check, and showing him the answer first turns a reconciliation into a form-fill."* The
endpoint is specified accordingly — `GET /v1/cash/handovers/me` **omits `expected_cash`**.

Plan-1 designs a screen around a figure the API is specified never to send. Plan-2's `T6`
gets this right, states the two absences deliberately, and cites the source.

**8.2 — The expenses column in the owner's cash queue. [verified]**

Plan-1's `OWN-09` builds its worst-moment narrative and a dedicated table column around
expenses ("expenses ₹2,000 (battery terminal) — its own column, never netted into
variance"). It is following `PLAN-FRONTEND.md` §9, which does say that.

But `PLAN-FRONTEND.md` §9 is stale on this point. `PLAN-DATA-MODEL.md` §3.7 records that
`expenses_amount` and `expenses_note` were **removed** — *"There are no expense columns,
and that is a decision, not an oversight… The owner has confirmed technicians do not spend
from collections"* — and `PLAN-GAPS.md` G21 marks the proposal **superseded**, closing it
with *"every variance the owner sees is now a real discrepancy, and the field that would
have let a shortfall be explained away does not exist."* `PLAN-FRONTEND.md` §9 itself says
two paragraphs earlier that the handover screen has no expenses field.

Plan-2's `O2` gets this right and states the consequence sharply: *"Every variance is real.
There is no expenses column… Nothing on this screen lets a shortfall be explained away."*

Both of plan-1's cash errors have the same cause: it trusted `PLAN-FRONTEND.md` §9 without
cross-checking it against the data model and the gaps register that supersede it.

**8.3 — `customer_signed` has no capture UI. [verified]**

`PLAN-GAPS.md` G13 resolves this explicitly: a **checkbox** reading "Customer confirmed the
work", not a signature pad. Plan-2's complete sheet has it. Plan-1's says *"No signature"*
under Not-on-this-screen and provides no control at all — technically correct about the pad,
but it leaves a `job_completions` column with no way to populate it and quietly re-opens a
closed gap.

**8.4 — `Phase 10`.** Plan-1's `03-COMPONENTS.md` §4 defers the component↔screen bijection
check to "Phase 10". The project has phases 0, 1, 2, 2B, 3, 4, 5. Minor, but it is the
enforcement mechanism for the whole component set, so it lands nowhere.

### Where plan-2 contradicts settled decisions

**8.5 — Collection modes. [verified]**

Plan-2's complete sheet offers **Cash / UPI / Card**. The enum in `PLAN-DATA-MODEL.md` is
`cash, upi, card, bank_transfer, none`, and `none` is load-bearing: the check constraint
`completion_mode_coherent` exists precisely so a zero-charge completion can record that no
money changed hands. Plan-2's three segments force a technician closing a free or
warranty job to record it as paid by cash. Plan-1's **CASH / UPI / NONE** keeps the
load-bearing value; both drop `bank_transfer`.

**8.6 — 44pt tap targets across all dispatcher screens. [verified]**

`PLAN.md` §9 sets 52px globally. `PLAN-FRONTEND.md` §9 permits 44px as a **fallback for
Job Logs specifically**, if the five-second prototype fails, because a dispatcher is
seated and ungloved. Plan-2 generalises that exception into `console` density: 44pt targets
on every dispatcher screen, as the baseline. Plan-1 holds 52px for console and keeps 44px
as the documented single-screen fallback.

Plan-2's reasoning is good — *"this is the one place where `field` density would be wrong:
bigger is slower here"* — and may well be the better product call. But it is an amendment
to a settled decision, and it is made silently. It also has a side effect plan-2 does not
notice: if the console baseline is already a 56pt row with 44pt targets, then the
"fallback" of a 44pt row is barely distinguishable from the baseline, which drains the
prototype gate of most of its meaning.

**8.7 — A wrong cross-reference.** `00-PHILOSOPHY.md` §6 points at `06-MOTION.md`; the file
is `02-MOTION.md`. Cosmetic.

### Where plan-2 is right and it matters

Beyond the cash decisions above, plan-2 is consistently the more domain-literate document:

- **Draft vs Confirmed sales.** Confirm allocates the number and moves the balance; only
  the owner can void. Plan-1's `SAL-02` has no draft state at all.
- **A negative company balance renders as `Credit` in green**, not a red minus — an
  overpayment is good news and the schema permits it.
- **`attempt_count > 1` surfaced deliberately** on dispatcher contracts: a visit on its
  third attempt is a site worth ringing before sending anyone.
- **`en_route` is skippable** (`PLAN-BACKEND.md` §6.1), so the stepper renders it
  dimmed-but-present rather than changing shape — a technician who skipped a step should
  see that he skipped it.
- **"Owed", not "Pending"**, as the payments tab label, with the reasoning that "pending
  payments" invites the stored-counter reading the data model rejects.
- **Consent copy that is actually grounded** — "Kept for 180 days" matches
  `prune-location-pings`, "about once every 15 minutes" matches the cadence note. Plan-1
  lists the topics and says "retention per policy".
- **Cash is not visually emphasised** among payment modes, "because emphasising cash would
  nudge behaviour in the one area the reconciliation exists to police."

---

## 9. plan-1 — goods and bads

**Goods**

1. **The contrast audit is the highest-value artefact in either plan.** It found a real
   defect in the settled palette, quantified it, and proposed a rule rather than a repaint.
   All 21 figures verify exactly.
2. **"Not on this screen" on all 42 specs.** A scope fence that is directly usable in code
   review, and the cheapest defence in either document against feature creep.
3. **Traceability.** The README opens with 14 numbered hard constraints, each cited to its
   source, and marks its own additions **[resolves]**. Nothing is smuggled in.
4. **The rejection taxonomy is complete.** `SHR-07` covers the `DUPLICATE_ENTITY`
   offline-create case and the outbox-row rewiring; `SHR-08` makes logout protection a
   first-class screen. Plan-2 mentions neither.
5. **Owner coverage is twice as deep** — Dispatch, Customers, Products and Services all get
   their own specs.
6. **The state matrix is the more honest one**: it separates `stale` / `pending-sync` /
   `rejected` / `overdue` as distinct domain states and states plainly that online roles
   have none of them.
7. **A component↔screen bijection check** — orphans are unspecified scope, ghosts are
   undefined components. Plan-2 has no equivalent.

**Bads**

1. **Two hard contradictions of settled cash decisions** (§8.1, §8.2), both from trusting a
   stale section of `PLAN-FRONTEND.md` over the data model that supersedes it. The expected-
   cash one designs against an API contract that explicitly withholds the field.
2. **`customer_signed` has no capture UI** (§8.3), re-opening a closed gap.
3. **The motion document is not buildable.** No spring constants, no everyday-interaction
   table, no library pins. An engineer will invent the feel of every button press.
4. **No grey ramp.** Disabled text, placeholders, skeleton fills and pressed states have no
   defined colour — the exact gap plan-2 identified and filled.
5. **Sales and payments are thin** — no draft state, no void, no credit treatment, no
   snapshot-vs-live discussion beyond one clause.
6. **No Phase 0 enforcement artefact**, and the bijection check that would have been one
   is scheduled into a phase that does not exist.
7. **Sparser mockups.** Several screens are prose-only where plan-2 gives an ASCII layout.

---

## 10. plan-2 — goods and bads

**Goods**

1. **The motion system is genuinely implementable.** Duration tokens with a forbidden band,
   three spring configs with real constants, four beziers with rationale, a ten-row
   everyday-interaction table, a nine-event haptic map, and seven hard perf rules naming
   FlashList, worklets and the `transform`/`opacity` restriction.
2. **Foundations are more complete**: a seven-step slate ramp, a density table with row
   heights and body sizes, an elevation table split by platform with the reason, and a
   field-constraint table mapping each physical condition to a rule.
3. **Domain literacy** (§8, "where plan-2 is right") — draft/confirm, credit, attempt_count,
   skippable `en_route`, "Owed" not "Pending", grounded consent copy, cash not emphasised.
4. **The Phase 0 component gallery**, with every component rendered in all eight states,
   named as the deliverable that makes the rest enforceable: *"Without it, `stale` and
   `error` get invented per screen and the app looks like four different products by
   Phase 4."* This is the best process idea in either document.
5. **Falsifiable exit criteria** — *Locate now* succeeds within 60s on ≥80% of attempts;
   Job Logs median under 5s measured on real dispatchers' own handsets.
6. **The 2px accent underline as active state** — the single most identity-forming decision
   in either plan, and it costs nothing.
7. **Better honesty about attention.** The no-offline-chrome argument for field roles
   (*"a permanent offline badge trains people to ignore it"*), and the login screen's
   *"Forgot your password? Ask the owner"* instead of a dead reset link.
8. **The best single line on optimistic UI**: the success haptic fires when the outbox
   confirms, not on tap, because *"the honest signal is delivery, not intent."*

**Bads**

1. **Contrast is asserted, not audited.** Five approximate figures, all optimistic, one of
   them (`slate.300` at a real 2.39:1, not 2.9:1) waved past its own stated floor — and
   not one status colour, pill fill or rail checked against the 7:1 standard it claims.
2. **The six-moment budget strains `PLAN.md` §9's letter**, and its own 380ms count-up
   violates its own 320–520ms ban. The reconciliation argument is well made; the budget is
   still where drift will start.
3. **44pt console targets silently amend a settled 52px decision** (§8.6), and in doing so
   erode the Job Logs prototype gate.
4. **Collection modes omit `none`** (§8.5) — a schema-relevant miss on the highest-stakes
   screen.
5. **Two owner screens are missing** — Customers and Dispatch appear in the rail with no
   spec (§6).
6. **No "Not on this screen" discipline.** Plan-2 has `Never` lists on components and some
   screens, but nothing like plan-1's per-screen fence.
7. **No rejection taxonomy beyond the banner** — no duplicate-company rewiring, no logout
   gate as its own spec.
8. **A wrong cross-reference** (§8.7).

---

## 11. Decisions someone has to make

These are genuine forks, not editorial cleanups. Each needs an answer before Phase 0
closes.

| # | Question | plan-1 | plan-2 | Note |
|---|---|---|---|---|
| D1 | Does the technician see expected cash before declaring? | Yes | **No** | Settled already — `PLAN-BACKEND.md` §10 says no, and the API omits the field |
| D2 | Does the owner's cash queue have an expenses column? | Yes | **No** | Settled already — columns removed, `PLAN-GAPS.md` G21 superseded. `PLAN-FRONTEND.md` §9 is stale and should be amended |
| D3 | Offline chrome for field roles | Persistent non-dismissible banner | **No chrome; only a failed drain speaks** | A real design argument. Plan-2's alarm-fatigue reasoning is strong, but the pending badge is the field diagnostic and must stay either way |
| D4 | Dispatcher tap targets | 52px, 44 only as the Job Logs fallback | **44 across `console`** | Plan-2's call may be right; it needs to be an explicit amendment, not silent |
| D5 | Icon set and style | MaterialCommunityIcons, filled | **Lucide, 2px stroke** | Sunlight favours filled; identity favours consistent stroke |
| D6 | Motion budget | 1 moment | **6 moments** | Recommend adopting plan-2's system with plan-1's discipline — see §12 |
| D7 | Dynamic type ceiling | 1.3× | **200%** | Materially different engineering cost |
| D8 | Status rail contrast (`DQ-2`) | Escalated with a proposal | Not noticed | Must be answered whichever plan wins — the rail is the product's signature |

---

## 12. Recommendation

Neither document should win outright. They fail in opposite directions, and the merge is
unusually clean because their strengths barely overlap.

**Take plan-2's foundations and motion wholesale** — `01-FOUNDATIONS.md` and
`02-MOTION.md` are simply the more buildable documents, and the slate ramp, density table,
elevation table, spring constants and everyday-interaction table are all things plan-1
would otherwise have to invent during Phase 0. Add the Phase 0 component gallery as the
deliverable that enforces them.

**Overwrite plan-2's colour section with plan-1's measured audit**, including the `DQ-2`
rail rule, the `FIL-1…6` pill-ink findings, and a corrected `slate.300` figure. Keep
plan-2's 7:1 sunlight framing as the stated standard, but make it an audit rather than an
assertion.

**Take plan-1's screen discipline** — the ID scheme, the "Not on this screen" fence on
every spec, the rejection taxonomy (`SHR-07`), the logout gate (`SHR-08`), and the owner's
missing Customers and Dispatch specs.

**Take plan-2's domain corrections** — no expected figure on handover, no expenses column,
the `customer_signed` checkbox, draft/confirm sales, credit balances, `attempt_count`,
skippable `en_route`, and the "Owed" tab label. Then fix plan-2's own miss and restore
`none` to the collection modes.

**On motion, adopt plan-2's six moments with plan-1's enforcement.** Five of the six earn
their place; the sixth — the dashboard count-up — is the one to cut, which conveniently
also removes the 380ms violation. Keep plan-2's rule that nothing sits between 320 and
520ms, and keep plan-1's review gate listing banned effects, because a six-moment budget
without an explicit ban list is a budget that becomes eight moments by Phase 3.

**Two corrections belong upstream, not in the UI plan.** `PLAN-FRONTEND.md` §9's owner cash
queue row still lists an `expenses` column that `PLAN-DATA-MODEL.md` §3.7 removed and
`PLAN-GAPS.md` G21 closed. That single stale cell produced the larger of plan-1's two
factual errors, and it will keep producing them until it is amended.


---

## Postscript — findings applied to plan-2

The audit above was read back into `plan-2/` alongside the second gap pass (`PLAN-GAPS.md` Part IV). Four findings from this document were adopted:

| § | Finding | Resolution in plan-2 |
|---|---|---|
| 6 | No owner **Dispatch** or **Customers** spec, though the rail lists both | Added as `07-OWNER.md` §O4b — the dispatcher's screens with the company field restored and the stack editable as the correction path |
| 7 | Contrast figures were approximations, all flattering | Every figure recomputed and stated as measured. `slate.300` is **2.39:1**, not ≈2.9 |
| 7 | `slate.300` used for placeholders and the stale inset below its own 3:1 floor | New `slate.400` `#7C8B9A` (3.43:1 / 3.17:1) takes both; `slate.300` keeps disabled text alone |
| 7 | Status rails never checked against the 3:1 non-text floor — yellow **1.65:1**, amber **2.72:1** | `01-FOUNDATIONS.md` §1.6 states both failures and resolves them plan-1's way: **the rail is never the sole carrier of state**, always paired with the word. Filled `StatusPill` variants dropped outright — no single ink clears all five fills |
| 8.5 | Collection modes dropped `none`, which is load-bearing — a warranty job forced to record *paid by cash* | The Paid-by segments are **replaced by "No payment taken"** when the amount after discount is zero, and `none` is submitted. A consequence, not a fourth segment |
| 8.6 | `console` density generalised 44pt from a Job Logs fallback to a role baseline, silently — and drained the prototype gate | Stated as an amendment to `PLAN.md` §9 with its reasoning. **The row itself is the 56pt target**; 44 is the floor for secondary controls with 8pt hit slop. Baseline 56 → fallback 44 → web descope stays three distinct steps |
| 8.7 | `00-PHILOSOPHY.md` §6 pointed at `06-MOTION.md` | Corrected to `02-MOTION.md` |

The verdict of §7 stands as written and is worth keeping visible: **the plan with the stricter stated standard was the one that had not checked.** A contrast table consulted instead of a calculator is worse than no table, which is why the figures now say *measured* and the two failures are named rather than smoothed.
