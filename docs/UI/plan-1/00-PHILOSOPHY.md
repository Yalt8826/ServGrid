# 00 — Philosophy

## The claim in one sentence

ServiceGrid should feel like a well-made work instrument — every screen answers "what is true
about the work right now" before anything else, and never lies about it.

## Reference objects

Four physical objects that share this product's design problem; each yields a testable rule.

1. **A UPS front panel.** State is legible from across a workshop before anyone reads a word.
   *Taken: the status rail and StatusPill carry state at list-glance distance — the card
   communicates before it informs.*
2. **A Fluke 117 multimeter** — the tool every technician already carries. Sunlight-readable, the
   active mode explicit on the LCD, battery state permanently visible. *Taken: noon-sun
   legibility is the design reviewer; the app's own state (queued, rejected, stale) is always
   on display, never discovered. The TrackingHealthChip is this principle made flesh.*
3. **A carbon-copy job docket.** Numbered, sequential, structured fields, one copy left behind.
   *Taken: the 4px square-cornered status rail reads like a physical work docket; job numbers
   are docket numbers — server-assigned, never fabricated, shown in tabular figures.*
4. **Lockout-tagout tags and hard-hat safety yellow.** The trades' native colour code: yellow
   means attention-and-action, red means stop, green means normal. *Taken: the accent is the
   domain's own vernacular with a physical justification (yellow stays readable in direct sun
   where mid-tones vanish) — and its scarcity is part of the code: two uses, no third.*

## What this is explicitly NOT

- **Dark mode now** — deferred by decision (`PLAN-FRONTEND.md` §11-6); the contrast floors exist
  for sunlight, and softening them for monitors would apply the desk view to a yard decision.
- **Glassmorphism / blur / translucency** — fails noon sun; costs battery on phones running a
  foreground location service.
- **Neumorphism, gradient meshes, decorative illustration** — fail the test below; they say
  nothing about the work and erode the accent's meaning.
- **Bouncy entrance animations, animated logos, card-mount fades** — fail the locked motion
  decision: one orchestrated moment, everything else answers a tap.
- **Spinners where a skeleton belongs** — the parent decision is skeletons, never spinners;
  a spinner on a cached-read screen is a lie about latency.
- **Toasts for rejections** — the technician may be underground; rejections are banners that
  stay until resolved (`PLAN-FRONTEND.md` §5).
- **A second accent** — three new chips killed the accent once already; the chip colour table in
  `PLAN-FRONTEND.md` §8 is a fence, not a suggestion.
- **Icon-only controls that change data** — icon + label always (Multimeter rule).

## The central claim

**Every screen tells the truth about the state of the work — and a screen that tells the truth
never blocks it, never invents, and never swallows.**

Three corollaries the whole system hangs from:
- **Never blocks** — nothing in the UI waits on the network; the outbox is the honest
  description of what happened ("your record exists, it will sync").
- **Never invents** — a job number that doesn't exist is worse than a "Pending sync" chip; a
  map position without an age is a lie; the health chip says "never reported" rather than
  guessing.
- **Never swallows** — a rejection keeps the local record and says what happened in the
  server's words; logout with queued work is blocked, not confirmed away; a missing cash
  declaration surfaces as its own row.

## Principles

1. **State before content.** Rail, pill, chip — a card's state reads before its text does.
2. **Queued is a state, not an error.** Amber "Pending sync" where the number goes; the badge
   counts; rejection is the only red, and it comes with the server's message verbatim.
3. **Sunlight is the design reviewer.** Every colour pair is measured against noon in a
   doorway, not a monitor in an office (`01-FOUNDATIONS.md` §1.3).
4. **Money is written once, by the person on site.** One amount field; discounts disclose a
   reason; parts never touch the amount; whoever may not see money sees no money — in the
   schema, the API, and the render tree (`MoneyGate`).
5. **The phone is a sensor and a battery.** A foreground service runs all working day; motion
   is interaction-echo and one orchestrated moment; idle screens are static.
6. **Targets are for gloves.** 52px in the field, thumb-zone primaries, nothing destructive in
   the bottom 40% of a field screen.
7. **Yellow means two things, or it means nothing.** Primary action and active state — the
   rail's yellow *is* the active state, which is why a rail and a primary button never sit
   adjacent without a spacing break.

## Signature tells (what makes a screenshot identifiable in five years)

1. **The 4px square status rail** on every job's leading edge, phone and desktop alike.
2. **"Pending sync"** — the amber chip standing where a number would go, unashamed.
3. **TrackingHealthChip** — one chip that tells the truth about an invisible system, including
   the state nobody else would surface (job alerts off).
4. **IBM Plex Condensed figures** — dashboard numbers set like instrument readouts.
5. **The one orchestrated moment** — the status stepper filling as a job advances.

## The tensions, resolved

**Tension 1 — "make it smooth, interactive, with amazing animations" vs "one orchestrated
moment, skeletons never spinners".** The distinction: the settled plan restricts *orchestration*,
not *responsiveness*. One multi-element staged moment (stepper + rising sheet) stands; an app
where every tap answers instantly — pressed states, immediate optimistic renders, skeletons
shaped like real content — is *more* responsive than one decorated with entrance fades, and
every frame of it is load-bearing.

**Tension 2 — field staff offline vs office staff online, one codebase.** The distinction:
**offline is a capability flag, not a design language.** The outbox UX (pending badge, banners,
blocked logout) exists only where `roleCapabilities[role].offline` is true; online roles get
error states that say what failed in plain words. One component library, two failure modes,
never conflated — which is exactly the seam `PLAN.md` §1 warns will want to merge once code
exists.

**Tension 3 — the owner's two layouts.** Not responsive design: **two presentations of one
route tree.** The rule that keeps them one product is the card-phone/row-desktop rule — a
review checkpoint, not a preference.

## The test

Any future design argument settles with three questions:

1. **Does it change what the user knows about the work?** If not, decoration — cut it.
2. **Does it work at noon, one thumb, gloved, 12% battery, in a basement?** If not, not done.
3. **If the network died mid-tap, would the user still know what is true?** If not, it
   contradicts the architecture.
