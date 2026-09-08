# Shared Screens and Cross-Cutting States

Screens every role sees, plus the states every screen must define. Phase 0 unless noted.

---

## X1. Login

**Worst moment.** First morning, a technician who has never used the app, a temporary password written on paper, standing in the yard.

### Anatomy

```
┌────────────────────────────────────────┐
│                                        │
│              ServGrid                  │  wordmark, slate, no logo animation
│                                        │
│   Username                             │
│   [                                  ] │
│   Password                             │
│   [                              👁   ] │
│                                        │
│   [           Sign in            ]     │  primary, full width, 52
│                                        │
│   Forgot your password? Ask the owner. │  caption — honest, not a dead link
└────────────────────────────────────────┘
```

### Decisions

- **Username, not email.** Accounts are owner-created; there is no email in the schema.
- **A visible password toggle**, on by default for the first login. Typing a temporary password blind on a 6" screen in the sun is a real failure, and the security argument for masking does not survive contact with a yard.
- **"Forgot your password? Ask the owner."** — the truthful instruction. A dead "reset" link that goes nowhere is worse than no link.
- Rate-limited 5/min. On lockout: *"Too many attempts. Try again in 3 minutes."* — with the actual number.

### States

- **Error:** banner above the fields, *"Username or password is wrong."* Never which one.
- **Loading:** button to `loading`, fields locked. No full-screen overlay.
- **Offline:** *"No connection — sign-in needs one."* This is the one place offline genuinely blocks.

### Motion

None on arrival. **No animated logo, no fade-in sequence.** The app opens and is usable. Cold start to rendered login: under 2.5s.

---

## X2. Forced password change

Shown when `mustChangePassword`. Not skippable, not dismissible, no back.

New password, confirm, and the rules stated **before** typing rather than as errors after: *"At least 8 characters."* On success: `NotificationSuccess`, straight to the role's landing route — no interstitial.

---

## X3. Consent — technician and sales rep, first login

**Purpose.** Record informed consent to location tracking, and set the tone of the whole thing.

**This screen decides whether the app is experienced as something done *with* staff or *to* them** (`PLAN.md` §7, §11), and employee reaction to tracking is a named project risk. It is the highest-stakes copy in the product.

### Anatomy

```
┌────────────────────────────────────────┐
│ Location tracking                      │
│                                        │
│ ServGrid records your location while   │
│ you are working, so the office can     │
│ see which jobs are covered.            │
│                                        │
│ ⏱  Monday to Saturday, 09:00 – 19:00   │
│ 📍  About once every 15 minutes         │
│ 🔔  A notification stays visible while  │
│    tracking is on                      │
│ 🚫  Never outside those hours          │
│ 🗓  Kept for 180 days, then deleted    │
│                                        │
│ Your manager can see where you are     │
│ during work hours. Nobody can see      │
│ where you are outside them.            │
│                                        │
│ [        I understand         ]        │
└────────────────────────────────────────┘
```

### Copy rules

- **State the limits before the capability.** The hours come before the tracking.
- **The last sentence is the one that matters.** Say plainly what is *not* collected. That is what people actually want to know, and volunteering it is what makes the rest credible.
- No legalese, no scroll-to-accept, no pre-ticked boxes.
- Versioned — a reworded screen requires re-acceptance.

### Never

No "Decline" button that logs the user out with no explanation. A fake choice is worse than an honest requirement.

**What actually happens if he does not accept:** the screen is not dismissible and there is no second button, but **it gates the location task, not the app** (`PLAN-BACKEND.md` §4). A technician who backs out still sees his jobs and can still work; background tracking simply never starts, and his health chip reads `permission_missing` — which the owner sees, which makes it a conversation between two people rather than a lockout administered by software.

That is the deliberate answer to a question the earlier draft left open. A hard block at login makes the very first thing a new employee meets an ultimatum, which is the opposite of what this screen is for; silently proceeding with tracking off would be worse still, because it would hide the refusal from everyone. Visible degradation, surfaced to both parties, is the only version of this that is honest in both directions.

The footer therefore says the true thing rather than a threat: *“Tracking is part of the job. If you have questions, talk to the owner before accepting.”*

---

## X4. Permission ladder — technician and sales rep

Four steps, each its own screen, each with its own explanation. The ladder is resumable and shows position (`Step 2 of 4`).

| Step | Screen |
|---|---|
| 1. Location while using | In-flow prompt |
| 2. Location all the time | **Cannot be requested in-flow on Android 11+** — explanation, then `Linking.openSettings()`. Polls on foreground return |
| 3. Battery optimisation | `ACTION_REQUEST_IGNORE_BATTERY_OPTIMIZATIONS` intent |
| 4. OEM autostart | Manufacturer-detected deep link + **screenshot walkthrough per vendor** |

### Step 2 is where people fall off

Android will not let the app ask. It must send the user into Settings and hope they come back. The screen therefore shows **exactly what to tap**, in order, with the Android wording quoted verbatim:

> Tap **Permissions** → **Location** → **Allow all the time**

Then a single button, *Open settings*. On return, the app polls and advances automatically — the user should never have to tell the app they did it.

### Step 4 cannot be written from documentation

Xiaomi, Realme, Vivo, Oppo and OnePlus each hide autostart somewhere different, and the paths change between OS versions. **Real screenshots per vendor, captured from the actual handsets** — this is why Phase 1 entry requires borrowing one of each long enough to photograph them.

Ends with an *"I've done this"* confirmation posting `autostart_confirmed`, because there is no API to verify it.

### Notification permission — after the ladder, not inside it

Android 13+ runtime prompt, needed for assignment alerts rather than tracking. Placed **after** step 4 so a refusal cannot strand someone mid-ladder. A refusal is not fatal: tracking is unaffected, and the fourth `TrackingHealthChip` state reports it.

---

## X5. The universal states

Every screen defines all five. Most bugs in field software are an undefined one of these.

### Empty

One line of `body` stating the situation, one `secondary` button offering the next action. **No illustration, no mascot, no exclamation mark.**

Empty is not always failure — *"Nothing needs attention"* on the owner's dashboard is good news and should read as good news.

### Loading

Skeletons at exact geometry, 200ms delay, 400ms minimum. **Never on offline-first screens** — the technician and rep read the local mirror; a skeleton there would be a lie about the architecture.

### Error

`Banner`, `feedback.danger`, message written for the person holding the phone, with the action that fixes it. Never a code, never a stack trace, never "Something went wrong".

The API's `message` field is written for the technician and is shown **verbatim** — the backend owns this copy on purpose (`PLAN-BACKEND.md` §3.1).

### Offline

**Two different treatments, and conflating them is the mistake:**

| Role | Treatment |
|---|---|
| Technician, sales rep | **No chrome.** The mirror is the source of truth; a permanent "offline" badge trains people to ignore it. Only a *failed drain* raises a banner |
| Dispatcher, owner | **Full-width danger banner.** Content dims, filters disable, actions disable. Stale data here produces confident wrong decisions |

This is the visible face of `PLAN.md` §1's rule that offline need is independent of platform.

### Stale

The offline-first state (`03-COMPONENTS.md`). Dashed 2px `slate.400` left inset plus `Pending sync`. Not an error, not a spinner, not greyed — **the data is real**, the server just has not seen it yet.

---

## X6. Navigation shell

**Android:** bottom tabs from that role's group map (`PLAN-FRONTEND.md` §3) — **technician 4** (Dashboard · Jobs · Cash · Profile), **dispatcher 3** (Dashboard · Operations · Profile), **sales rep 4** (Dashboard · Sales · Cash · Profile), **owner 5**.

The map is per role, not the owner's map with rows hidden. Filtering one owner-shaped map is what leaves the technician's handover and the rep's contract list unreachable — both are permitted, both exist as routes, and neither has a tab that leads to them.

Active tab: **2px accent underline** above the label, sliding between tabs over 220ms. Not a filled pill (`03-COMPONENTS.md` — a precise underline is a signature; pills are everywhere).

**Web, owner:** the same groups as a 240px left rail.

The `PendingBadge` sits in the header for offline roles, on every screen.

### Route guarding

A single `<RoleGate>` using the same `permit()` the API uses. A route the role cannot reach **redirects to that role's landing route** rather than rendering an error — a technician deep-linked to `/companies` lands on his jobs, not on a wall.

---

## X7. Accessibility

Not a separate workstream; most of it falls out of the field constraints.

- **Contrast** already exceeds WCAG AA everywhere because sunlight demanded 7:1 (`01-FOUNDATIONS.md` §1.5).
- **Targets** already 52pt because of gloves.
- **Reduced motion** honoured — movement removed, feedback kept (`02-MOTION.md` §10).
- **Dynamic type** to 200%. Layouts reflow; no fixed-height text containers. The complete sheet is tested at 200% because it is the one that will break.

  **The density row heights in `01-FOUNDATIONS.md` §3.3 are minimums, not fixed heights.** 88 / 56 / 40 is where a row starts; at large type it grows, and `FlashList`'s `estimatedItemSize` is an estimate for exactly this reason. A `height: 56` on a row is the commonest way an app passes a dynamic-type audit on the settings screen and clips text on every list — so it is `minHeight` everywhere, without exception.
- **Screen reader** labels on every control, and the status rail carries an `accessibilityLabel` — colour alone never communicates status, which is also why every status has a word beside it.
- **Focus order** on web follows visual order; the rail is a landmark.

---

## X8. What ships in Phase 0

The design system exists before any feature does, or every feature invents its own.

- Fonts loaded behind the splash gate
- Full token set in `packages/shared/theme`
- `Button`, `TextField`, `MoneyField`, `Sheet`, `Banner`, `Skeleton`, `Chip`, `EmptyState`, `ConfirmDialog`
- The eight states, each with a rendered example
- Motion tokens and the three springs
- Haptic mapping
- `NavShell` with the single platform branch and density provider
- The three lint rules: no literal `#F2C200` outside `theme.ts`; no `job_completions` or `service_contracts` in dispatcher repository code; no `location_pings` or `location_requests` there either
- The nav-map / permission-matrix cross-check test — every route in a role's tab map is permitted, and every permitted route has a tab (`PLAN-FRONTEND.md` §3)

**A rendered gallery of every component in every state** is the Phase 0 deliverable that makes the rest of this document enforceable. Without it, `stale` and `error` get invented per screen and the app looks like four different products by Phase 4.
