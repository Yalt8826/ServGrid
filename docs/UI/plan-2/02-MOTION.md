# Motion System

Motion has three jobs here — **origin**, **state**, **continuity** (`00-PHILOSOPHY.md` §4.2). Anything doing none of them is deleted before it ships.

Stack: **Reanimated 4.x** worklets on the New Architecture, **react-native-gesture-handler** for anything finger-driven, **expo-haptics** for tactile feedback. Reanimated 4 requires the New Architecture and pairs with the Expo-recommended version — pin it, do not float.

---

## 1. Duration tokens

```ts
duration = {
  instant:    0,    // hardware-like state flips
  tap:       90,    // press-in feedback
  quick:    140,    // chips, toggles, micro-state
  base:     220,    // most transitions, sheet dismiss
  considered: 300,  // sheet present, screen push
  hero:     520,    // the status stepper — one per product
}
```

Nothing between 320 and 520. If a transition wants 400ms it is either doing too much or it is a hero moment, and both need a decision rather than a number.

## 2. Easing

```ts
easing = {
  enter:    Easing.bezier(0.05, 0.7, 0.1, 1),   // arriving — emphasised decelerate
  exit:     Easing.bezier(0.3, 0, 0.8, 0.15),   // leaving — accelerate
  standard: Easing.bezier(0.2, 0, 0, 1),        // moving within the screen
  linear:   Easing.linear,                      // progress indicators only
}
```

Things arriving decelerate hard: they appear to have travelled and settled. Things leaving accelerate away: no lingering.

## 3. Springs

```ts
spring = {
  press: { damping: 26, stiffness: 420, mass: 0.7 },  // ~90ms, no visible overshoot
  sheet: { damping: 30, stiffness: 260, mass: 1   },  // settles ~300ms, hair of overshoot
  snap:  { damping: 22, stiffness: 180, mass: 1   },  // gesture release, velocity-carried
}
```

**Never a spring with damping below 15.** Visible bounce reads as *toy*, and this app is equipment (`00-PHILOSOPHY.md` §1).

### The rule that decides which

> **Springs when a finger is involved. Curves when the system decided.**

A drag that continues into a settle is a spring — the motion is a continuation of the hand. A screen the server pushed you to is a curve — nothing physical caused it, so faking momentum is a lie.

## 4. Choreography rules

1. **Two animated properties per element, maximum** — `transform` and `opacity`. Never both a translate and a scale and a colour and a rotation.
2. **Stagger exists in exactly one place**: the status stepper's segments. Nowhere else in the product.
3. **Lists never animate on mount.** They animate on *change*: an item entering because a sync delivered it gets a 140ms height-and-opacity entrance, because that is information. `PLAN.md` §9's "no entrance animation on every card" is about the load case, and it stands.
4. **Nothing animates off-screen.** Every animated component checks `useIsFocused` and parks.
5. **One `overlay` at a time** (`01-FOUNDATIONS.md` §4).
6. **Interruptible.** Every animation accepts a new gesture mid-flight. Reanimated springs take over from current velocity; a user who changes their mind never waits for a transition to finish.

---

## 5. The six signature moments

Six. Enough to feel crafted, few enough to stay honest. Everything else in the app is press feedback and screen transitions.

### 5.1 The status stepper — the hero

**When:** a job advances (`en_route` → `in_progress` → `completed`).
**What:** a horizontal stepper on the job detail. The completed segment fills left-to-right; the node scales `1 → 1.15 → 1`; the 4px status rail on the card behind cross-fades to the new status colour; the next segment's label fades from `text.disabled` to `text.primary`.

**Timing:** `hero` 520ms total. Segment fill 0–320ms `enter`. Node pop 240–400ms `spring.press`. Rail colour 0–520ms `standard`. Label 320–460ms.

**Haptic:** `Light` on start, `Success` on reaching `completed`.

This is the one orchestrated moment `PLAN.md` §9 allows, and it is spent on the thing a technician does most and cares about most: visible progress through his day.

### 5.2 The completion sheet rise

**When:** *Complete job* tapped.
**What:** the sheet rises **from the button that opened it** — origin, not from an abstract bottom edge. Scrim fades `0 → 0.45`. The stepper stays visible above the sheet, so the technician can see what he is completing.

**Timing:** `considered` 300ms, `spring.sheet`. Scrim 220ms `enter`.
**Dismiss:** drag down, `spring.snap` carrying velocity; a fast flick dismisses below the usual threshold. `base` 220ms `exit` if dismissed by button.

### 5.3 The pending badge drain

**When:** the outbox drains.
**What:** the count decrements with a `quick` 140ms tick per item — the number changes with tabular figures so nothing shifts. At zero, the badge scales to 0 with `spring.press` and a `Success` haptic.

This is the visible proof that queued work left the device. `PLAN.md` §6 asks for the badge; animating the drain is what turns it from a number into reassurance. **A badge that only goes up is a sync failure**, and making the downward motion satisfying is what makes its absence noticeable.

### 5.4 Long-press pick-up

**When:** entering multi-select in Job Logs (`PLAN.md` §8).
**What:** at 400ms the card scales to `0.97` and its border strengthens — it reads as being physically picked up. `Selection` haptic fires at the threshold, before the finger lifts, so the dispatcher knows selection armed without watching. The header cross-fades to a count and bulk action.

**Timing:** scale `spring.press`. Header swap `quick` 140ms.

### 5.5 Assignment picker load bars

**When:** the `TechnicianPicker` opens.
**What:** each technician's row carries a thin horizontal load bar. On open they draw from zero, left to right, staggered 30ms apart, 260ms each, `enter`.

The one place stagger is allowed outside the stepper — and it earns it, because the *comparison* is the decision. Bars drawing in sequence makes relative load legible before any number is read. `PLAN.md` §8: choosing who to send is the actual decision.

### 5.6 The rejection banner

**When:** a queued operation is rejected (`JOB_ALREADY_CLOSED` and friends).
**What:** drops from the top with weight — `considered` 300ms, `spring.sheet`, slight overshoot. `Warning` haptic. Does not auto-dismiss.

The only "attention" motion in the product. It is allowed to be assertive because it is rare and because the alternative — a technician not noticing his completion was refused — is the failure `PLAN.md` §6 works hardest to prevent.

---

## 6. Everyday interactions

Not signature, but they are most of what a user feels.

| Interaction | Motion |
|---|---|
| Button press | Scale `0.97`, `spring.press`, in on touch-down not touch-up |
| Card press | Background → `bg.pressed`, `tap` 90ms; no scale (cards are surfaces, not controls) |
| Tab / segment change | Accent underline slides between tabs, `base` 220ms `standard`. Content cross-fades 140ms |
| Chip toggle | Fill and border change, `quick` 140ms. `Selection` haptic |
| Screen push | Slide 24pt from trailing edge + fade, `considered` 300ms `enter` |
| Screen pop | Reverse, `base` 220ms `exit` |
| Pull to refresh | Custom: the pending badge becomes the indicator. No platform spinner |
| Field focus | Border → `line.focus` 2px, `quick` 140ms. No glow, no shadow |
| Row expand | Height + opacity, `base` 220ms `standard` |
| Toast | Rise 16pt + fade, `base`. Auto-dismiss 4s. Never for errors — errors are banners |

---

## 7. Skeletons

`PLAN.md` §9: skeletons, not spinners.

- **Static blocks in `slate.100`. No shimmer.** Shimmer is a continuous animation running while the user waits, on a battery this app is trying to preserve, and it is the single most dated loading pattern in mobile design.
- **200ms delay before appearing.** A response under 200ms shows nothing — no flash, no flicker. The best skeleton in this app is one nobody sees.
- **Minimum 400ms once shown**, so a skeleton that does appear does not strobe.
- Skeletons match the real layout's geometry exactly. A skeleton that reflows on load is worse than a spinner.
- **Never a skeleton for offline-first content.** Technician and rep screens read the local mirror; there is nothing to wait for. A skeleton there would be a lie about the architecture.

---

## 8. Haptics

`expo-haptics`. Android respects the system haptic setting; do not fight it.

| Event | Haptic |
|---|---|
| Primary action press | `ImpactLight` |
| Segmented control / picker | `Selection` |
| Long-press threshold armed | `Selection` |
| Job status advanced | `ImpactLight` |
| Completion synced | `NotificationSuccess` |
| Outbox fully drained | `NotificationSuccess` |
| Sync rejected | `NotificationWarning` |
| Destructive confirmed | `ImpactMedium` |
| Validation failure on submit | `NotificationError` |

**Never on scroll, never on every keystroke, never on passive arrival of data.** Haptics are for things the user did. A phone buzzing in a pocket because a job list refreshed is the fastest way to get the app uninstalled.

Haptics are the cheapest "instrument-grade" signal available — a detent the hand feels is exactly the multimeter reference in `00-PHILOSOPHY.md` §1 — and they cost effectively nothing in battery.

---

## 9. Performance budget

Non-negotiable. Verified on the **lowest-spec handset in the staff roster**, not a flagship.

### Hard rules

1. **Reanimated worklets on the UI thread.** No animation driven from JS. No `Animated` from React Native core for anything gesture- or scroll-linked.
2. **`transform` and `opacity` only.** Never animate `width`, `height`, `top`, `left`, `margin` or `padding`. The exception is Reanimated `Layout` on list changes, budgeted at one list at a time.
3. **FlashList** for Job Logs, owner tables, ledgers, and any list that can exceed one screen. `estimatedItemSize` set from a measured row. `renderItem` hoisted and memoised — no inline arrow functions.
4. **No `expo-blur` in the Android bundle.** At all. It is expensive, inconsistent across the roster's OEMs, and destroys sunlight contrast.
5. **No shadows on list items.** Borders (`01-FOUNDATIONS.md` §4).
6. **Nothing animates off-screen.**
7. **No continuous animation anywhere.** No shimmer, no pulse, no breathing. The one exception is the live-tracking indicator on the owner's console, which runs only while that screen is focused and only during a five-minute live window.

### Targets

| Metric | Target |
|---|---|
| Tap → visible change | **< 100ms**, always |
| Frame budget | 16.6ms; **zero dropped frames** scrolling 200 job rows on the roster's slowest handset |
| Sheet present → interactive | < 350ms |
| Cold start → login rendered | < 2.5s |
| Skeleton visible on a warm screen | Never |

### Where this gets checked

Add to the **Phase 5 OEM matrix** (`PLAN-EXECUTION.md`) a row per handset: *200-row Job Logs scroll, dropped frames*. It sits beside overnight background survival and battery cost, because it is the same question — what this app costs the device — and the same handsets answer it.

---

## 10. Reduced motion

Honour `AccessibilityInfo.isReduceMotionEnabled()`, and re-check on app foreground.

**Reduced motion removes movement, never feedback.** Colour changes, haptics, state changes and skeletons all remain. Transforms and translations become instant state flips; the stepper fills without the pop; sheets appear without rising.

An app that strips all response under reduced motion has confused decoration with information — which is exactly the distinction this whole system is built on.
