# Design Philosophy — Instrument-Grade

The design brief for ServGrid, stated once: **it should feel like well-made equipment, not like software.**

That is not a style. It is a claim about what "smooth", "intuitive" and "cool" actually mean for eight technicians in vans, three dispatchers at a desk with phones, two reps in customers' offices, and one owner who wants to know where his money went.

---

## 1. The reference points

Honest ones, because "clean and modern" is not a direction:

**A Fluke multimeter.** Unambiguous readout. Legible in a dark plant room and in direct sun. One control does one thing. You do not consult a manual to read the number.

**A UPS front panel.** `PLAN.md` §9 already took the status colours from here. Extend the idea: state is legible from across a workshop, before anyone reads a word.

**A carbon-copy job docket.** The physical artefact the staff already use. Square corners, a number in the top corner, a rail down the edge, sections that do not move. This is the mental model — the app should feel like the docket got faster, not like the docket was replaced by an app.

**Dieter Rams' calculators.** Not for the aesthetic, for the discipline: every element earns its place, nothing decorates, and the result is still the most attractive object on the desk forty years later.

## 2. What this is explicitly not

Written down so nobody drifts into it in month four:

- **No glassmorphism, no frosted blur.** It costs GPU on exactly the devices that cannot spare it, and it destroys contrast in sunlight. It is also the single most dated visual trend of the last decade.
- **No neumorphism, no soft shadows everywhere.** Low-contrast by construction; unreadable in the yard.
- **No gradient meshes, no decorative blobs, no illustration-heavy empty states.** A technician does not need a cartoon telling him he has no jobs.
- **No bouncy, playful motion.** Overshoot reads as *toy*. This is equipment.
- **No hairline type, no 300-weight body text, no low-contrast grey-on-grey.** `PLAN.md` §9 chose contrast for sunlight; every temptation to soften it will come from someone looking at a monitor indoors.
- **No dark mode yet** (`PLAN.md` §9), and when it comes, it does not soften the light palette's contrast decisions.

These are not preferences. Each one fails a specific condition this app is used in.

---

## 3. The central claim

> **Smoothness is not animation. Smoothness is the absence of waiting.**

The most premium thing this app can do is respond in under 100 milliseconds, every time, including on 2G in a basement with fourteen percent battery. Nothing else in the interface will matter as much as that.

The architecture already bought it: `PLAN.md` §6's optimistic write — the user acts, the local mirror updates, the row enqueues, the UI already shows the new state. **The UI's entire job is to make that instantaneity visible and believable.**

Which reframes what animation is for. It is not decoration laid on top of a slow system to distract from the wait. It is the receipt: evidence that the system heard you, and a description of where things went.

---

## 4. Seven principles

### 4.1 Instant is the aesthetic

Every tap produces visible change in under 100ms. Not a spinner — *change*. The row is already there, the status is already advanced, the badge already incremented.

Where something genuinely cannot be instant, it gets a skeleton **after a 200ms delay**, so a fast response never flashes one. The best skeleton in this app is the one nobody ever sees.

### 4.2 Motion explains, or it does not run

Motion has exactly three legitimate jobs here:

| Job | Question it answers |
|---|---|
| **Origin** | Where did this come from? |
| **State** | What just changed? |
| **Continuity** | Is my finger still driving this? |

Anything that does none of these is deleted. This is how the app can be *highly animated* while honouring `PLAN.md` §9's "no entrance animation on every card" — the number of animated moments is high, and every single one is load-bearing. A card that slides in because it just synced is information. A card that slides in because the screen loaded is noise.

### 4.3 Physical believability

Objects have origin and persistence. A sheet rises from the control that opened it. A job card expands into its detail rather than being replaced by it. Nothing cross-fades into existence, and nothing teleports.

The rule that makes this cheap to apply: **springs when a finger is involved, curves when the system decided.** A drag that continues into a settle is a spring. A screen the server pushed you to is a curve.

### 4.4 Scarcity is the luxury

Safety yellow on exactly two things (`PLAN.md` §9). One hero motion per screen. One confirmation dialog on the complete sheet. One number leading each dashboard.

The restraint *is* the effect. An interface where everything is emphasised has emphasised nothing, and the yellow that means "act here" stops meaning it the third time it appears as decoration. `PLAN-FRONTEND.md` §7 already makes this a lint rule; treat the same discipline as applying to motion, dialogs, and badges.

### 4.5 Battery is a design material

Unique to this app and non-negotiable. The technician's handset is *also* the tracking device (`PLAN.md` §7), and OEM battery-killing is the project's dominant risk.

**Decorative GPU load is a functional bug here.** It shortens the trail. No blur, no continuous shimmer, no always-running animation, no shadow-heavy lists on Android, nothing animating while off-screen. Every effect is a withdrawal from the same battery that has to survive until seven in the evening.

This is the rare case where the performant choice and the beautiful choice are the same: borders and a status rail read more like a docket than drop shadows ever did.

### 4.6 Designed for the worst moment, not the demo

Every screen spec in this set names its **worst moment** — the actual condition it has to survive. Gloves. Direct sun. One hand, because the other is holding a torch. 2G. A customer standing there. Fourteen percent battery.

Design for that and the desk case is free. Design for the desk and the yard case never arrives.

### 4.7 One component set, three densities

The same primitives render at three densities, chosen by context, not by rewriting screens:

| Mode | Who | Character |
|---|---|---|
| `field` | Technician, sales rep — phone | Large, few, thumb-reachable. 52px targets. |
| `console` | Dispatcher — phone | Dense and scannable. Seated, no gloves, 200+ rows. |
| `desk` | Owner — web | Tabular. Sortable columns, sticky headers. |

This is the mechanism behind `PLAN.md` §9's rule that *the same job is a card on a phone and a table row on desktop*. It is one decision applied consistently, not a per-screen judgement call — and it is why the dispatcher can have a phone-native dense list without inventing a second design language.

---

## 5. How components stay fresh

Freshness is not novelty. Things that look fresh in five years share a property: they were **structural rather than stylistic**.

**Structure ages well.** Precise typography, exact spacing, real contrast, honest hierarchy. None of it dates, because none of it was ever fashionable.

**Effects age badly.** Every visual trend of the last fifteen years — skeuomorphic leather, flat, long shadows, glass, neumorphism, gradient blobs — is instantly datable. We adopt none of them, which means there is nothing to un-adopt later.

So the app's distinctiveness comes from three places instead:

**Signature details.** Four or five tells that make any screenshot unmistakably this app:

1. The **4px square-cornered status rail** on the leading edge of every job object, at every density.
2. **Tabular numerals everywhere a number appears** — job numbers, amounts, times, counts. Columns align, changing figures do not jitter.
3. The **docket header**: job number in mono, right-aligned, always in the same place.
4. **Active state as a 2px accent underline**, never a filled pill. Pills are everywhere; a precise underline is not.
5. **The status stepper** — the one animated element in the product.

**State richness.** Most interfaces look dead because only the default state was designed. Every component in `03-COMPONENTS.md` is specified in eight states — default, pressed, focused, disabled, loading, empty, error, and *stale/offline*, which most design systems do not have and this app needs on every screen.

**Deliberate non-adoption.** The list in §2. Keeping it written down is what stops a reasonable-seeming pull request from eroding it one component at a time — the same failure mode `PLAN-FRONTEND.md` §7 describes for the accent colour.

---

## 6. The tension with `PLAN.md` §9, resolved

`PLAN.md` §9 says: *one orchestrated moment, skeletons rather than spinners, everything else answers a tap, no entrance animation on every card.*

The brief for this document asked for something smooth, interactive and heavily animated. Those are reconcilable, and the reconciliation is principle 4.2.

**`PLAN.md` restricts orchestration, not responsiveness.** One *orchestrated* moment — a multi-element, staged, hero animation — is the stepper. That stands. But an app where every tap answers instantly with a spring, where sheets carry momentum from the finger that threw them, where a rejected sync drops a banner with weight, and where a long-press physically picks a card up, is *more* animated than one with decorative fades everywhere — and every frame of it is doing work.

`02-MOTION.md` names the six signature moments and budgets them. Six is enough to feel crafted and few enough to stay honest.

---

## 7. The test

A design decision in this app is right when you can answer all three:

1. **What does it tell the user?** If nothing, delete it.
2. **Does it survive the worst moment?** Sun, gloves, 2G, low battery.
3. **Would it still look right in 2031?** If it depends on a current trend, it will not.

---

**Next:** `01-FOUNDATIONS.md` (tokens) · `02-MOTION.md` (the motion system) · `03-COMPONENTS.md` · then the four role specs.
