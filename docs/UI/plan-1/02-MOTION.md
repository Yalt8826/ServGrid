# 02 — Motion

Motion answers three questions only: **Origin** (where did this come from?), **State** (what just
changed?), **Continuity** (is my finger still driving this?). Anything else is decoration, and
decoration on a phone running a foreground location service is a battery cost, not a taste
question.

## 1. The locked decision, made operational

`PLAN-FRONTEND.md` §7 locks: **one orchestrated moment — the job status stepper filling as a
job advances, with the completion sheet rising over it. Skeletons, never spinners. No entrance
animation on cards or lists. Reanimated; reduced motion respected.**

This document is that decision's implementation contract:

```text
engine:      react-native-reanimated (UI thread); web: CSS transitions
properties:  transform + opacity ONLY (layout properties never animate)
durations:   tap 90ms | quick 140ms | base 220ms | considered 300ms | moment ~520ms
easing:      enter cubic-bezier(0.2, 0, 0, 1) | exit cubic-bezier(0.4, 0, 1, 1)
             standard cubic-bezier(0.4, 0, 0.2, 1) | linear for progress only
spring:      finger-driven settles only (sheet thrown by a hand); system decisions use curves —
             faking momentum the user didn't impart is a lie
```

## 2. The orchestrated moment (the one there is)

**MO-1 · Status stepper + rising completion sheet.** Fires when a technician submits a
completion: the sheet rises over the job detail (300ms, `enter`), the status stepper fills
assigned → completed across ~520ms as the optimistic write lands, the StatusPill and rail flip,
then the sheet dismisses to the updated list. Interruptible at every stage; reduced motion =
instant state change + haptic, no translate.

**Interaction echo (everything else):** pressed states (opacity/scale ≤90ms), sheet drag
continuity with real velocity, FocusRing appearance, skeleton appearance/swap. These answer a
tap or a system state; they are not moments and need no justification table.

## 3. Skeletons, never spinners — the contract

The skeleton is a promise about what will appear; it must never be a lie:

- Exact geometry of the real content (JobCard skeletons have the rail, title bar, chip slots).
- Static blocks, no shimmer (shimmer is continuous GPU load and treats waiting as content).
- Delayed ~200ms before appearing; minimum ~400ms once shown — fast responses never flash one.
- **Never on offline-first cached reads** — the mirror renders in 0ms; a skeleton there would
  claim latency that doesn't exist. Skeletons belong to: dashboard aggregates, lists fetching
  fresh pages, the owner's charts, locate-request polling.
- Never on the outbox, never on a write (writes are optimistic and instant).

## 4. Haptics — for things the user did

| Event | Haptic |
|---|---|
| Completion submitted | success nudge |
| Check-in / status change confirmed | light tick |
| Rejection banner appears | warning buzz (the user did the sync; this is its answer) |
| Handover declared | success nudge |

Never on scroll, never per keystroke, never on passive background arrival (pings, push wakes,
assignment notifications raising local notifications — those arrive silently; the information
is the content, not the buzz).

## 5. Performance budget (falsifiable)

| Metric | Budget | Where checked |
|---|---|---|
| Tap → visible change | < 100ms | review + dev `perfMonitor` spot checks |
| Interaction → UI-thread response | all animated work on Reanimated UI thread; zero JS-thread animation | lint + review every animated call |
| Job list scroll, 200+ jobs, Phase 5 handset matrix | 0 dropped frames over 10s | Phase 5 field testing (`PLAN-FRONTEND.md` §10) |
| MO-1 full sequence | ≤ 520ms wall clock | Phase 1 exit test |
| Cold start → first readable screen | < 2s on the slowest Phase 5 handset | Phase 5 |
| Banned | entrance fades, card-mount animation, shimmer, spinner-instead-of-skeleton, layout-property animation, blur | review gate |

Reduced motion removes movement, never feedback: MO-1 becomes instant state + haptic; sheets
appear without translate; pressed states, colours, and haptics all stay.
