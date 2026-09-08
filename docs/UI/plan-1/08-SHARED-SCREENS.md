# 08 — Shared Screens & Shell

Surfaces every role passes through. Density per role; offline capability stated per screen.
Screen IDs `SHR-NN`; nav shell and rejection/logout UX live here because they bind every role.

## SHR-01. Login

**Purpose.** Who am I, and what does this device get access to?

**Worst moment.** First morning on site, no signal, new APK — the one screen that may
legitimately need the network must fail with a human answer, never a spinner forever.

### Anatomy
```
┌──────────────────────────────┐
│  [mark] ServiceGrid          │  title
│  Username [____________]     │
│  Password [____________]     │
│  [      Sign in         ]    │  primary; busy = the one legal spinner
│  v1.0 (100)                  │  caption — visible for support
└──────────────────────────────┘
```

### Content
Username + password (owner-provisioned accounts; no self-signup). Version string for the
support conversation. No role picker — the role comes from the session.

### States
Disabled until both filled (local criterion); busy spinner **the one network-bound submit in
the app**; credential error inline ("Wrong username or password"); offline error naming
reality ("Sign-in needs the network"); `mustChangePassword` → SHR-02; consent-required
(technician/rep first login) → SHR-04.

### Motion
None.

### Not on this screen
No forgot-password self-service, no SSO, no biometrics yet (shared handsets make device-bound
auth the wrong default — revisit if the owner asks).

## SHR-02. Change password (forced)

**Purpose.** First-login hygiene for provisioned accounts.

**Worst moment.** A tech with a shared handset and four waiting jobs wants in fast.

### Anatomy
Current, new, confirm; live checklist (length, not-username); primary "Save and continue".

### States
Checklist ticks as met; mismatch inline; success → consent (if owed) → role landing.
Network-bound; says so on failure.

### Not on this screen
No security questions, no rules beyond the two stated, no device management here.

## SHR-03. Role landing & route guarding

**Purpose.** A route the role cannot reach redirects to the role's landing route — never an
error wall (`PLAN-FRONTEND.md` §2).

**Worst moment.** A deep link opens a forbidden route in front of the owner's customer.

### Anatomy
Single `<RoleGate>` in `(app)/_layout.tsx` reading the same `permit()` the API uses.

### States
Redirect (silent), hard-fail (role missing → login). No rendered "403" anywhere in the app —
the concept doesn't exist client-side.

### Not on this screen
No per-role route duplication (one tree), no in-screen permission branching beyond `MoneyGate`.

## SHR-04. Consent (one-time, tracked roles)

**Purpose.** Tracking is a condition of field work, disclosed in writing before the ladder
starts — it stops the app being experienced as something done to staff rather than with them.

**Worst moment.** 08:58, a tech who wants to work, suspicious of surveillance, reading fast.

### Anatomy
Scrollable, plain language: **what** (location when the app is working, battery level, time) ·
**when** (work hours Mon–Sat 09:00–19:00 — not nights, not Sundays) · **who sees it** (owner,
dispatch, for jobs and safety) · **how long** (retention per policy, deletable by request) ·
**your visibility** (the persistent notification; the health chip always shows tracking
state) · versioned record posted to the server. [I understand — continue] → the permission
ladder's first step.

### States
Denied foreground permission → honest consequence ("the app can't check you in and out of
jobs"); revisitable from profile.

### Motion
None.

### Not on this screen
No toggle (tracking is the job's condition; the window is the boundary), no legal wall above
the fold, no marketing tone.

## SHR-05. The permission ladder (post-consent)

**Purpose.** Foreground → background → battery exemption → OEM autostart, each step its own
screen and explanation, each result posted to `/v1/devices` (`PLAN-FRONTEND.md` §6).

**Worst moment.** Android 11+ background permission: the OS refuses in-flow prompts, the tech
must deep-link to settings, and this is where trust is won or lost.

### Anatomy
One step per screen: why it's needed (one sentence) → [Open settings] / system intent →
"I've done this" → poll/confirm → next step. Progress shown as steps, not a bar to game.
Notification permission comes **after** the ladder — a refusal there costs alerts, not
tracking, and the health chip's fourth state says so.

### States
Per-step: granted / denied / deep-link returned unchanged (honest: "we couldn't confirm —
open Settings → Apps → ServiceGrid → Permissions"); the OEM autostart step is
manufacturer-detected with screenshot walkthroughs (needs the real handsets —
`PLAN-FRONTEND.md` §11-4).

### Not on this screen
No skip-all (the ladder is the product's honesty about Android), no fake completion states.

## SHR-06. NavShell

**Purpose.** One route tree, two presentations; the one place sync state lives; platform
branching exactly once.

**Worst moment.** Every other worst moment happens inside this frame — the shell must never
add its own: no lost state on tab switch, no hidden pending count, no banner flicker.

### Anatomy
Header: title + SyncBanner slot (offline roles) + PendingBadge. Content. Android: bottom
tabs showing only the groups the role reaches (technician: Dashboard/Jobs/Profile; owner:
five groups). Web ≥1024px: left rail with the same groups as sections. The
`Platform.OS === 'web' && width >= 1024` branch appears exactly once.
Global binding: every button is a `Button` variant; every form field a `TextField`,
`MoneyField`, `Select` or `DatePicker`; every empty condition an `EmptyState`; every job row
carries `StatusRail` + `StatusPill` + `JobNumber`, with `OverdueChip` where overdue and
`StatusStepper` on detail; screens saying "slab", "empty" or "rail" in prose are bound by
the component contract here.

### States
Offline (banner "Offline — showing saved data; everything you do is kept and will sync",
persistent, never dismissible) · pending N (badge) · healthy (zero chrome — silence is the
reward) · online roles: no banner, no badge, ever.

### Motion
None. Tab switches are instant; the shell never animates.

### Not on this screen
No hamburger drawer, no global search, no per-screen sync indicators (one instance, in the
shell).

## SHR-07. Rejection handling (the 409 door)

**Purpose.** When the server refuses a queued write: the local record is kept, the server's
message is shown verbatim, and the technician chooses — while standing in someone's basement.

**Worst moment.** He completed a job offline; the office cancelled it meanwhile; his finished
work must not vanish into a retry loop or a silent drop.

### Anatomy
Banner on the affected row (and a count in the shell): server `message` verbatim — "This job
was cancelled by the office at 14:32." Actions: **[Discard my copy]** (destructiveGhost,
ConfirmDialog naming what is lost) · **[View the office version]** (opens the job's current
truth). The special offline-create duplicate (`DUPLICATE_ENTITY`) offers **[Use the existing
company]** and rewires dependent outbox rows — no re-entry.

### States
Counted in the shell badge; survive logout keyed to the employee; never retried silently.

### Motion
Banner appearance is a state change (quick fade); the warning buzz fires once.

### Not on this screen
No auto-discard, no auto-merge, no raw error codes as copy, no modal stacking over sheets.

## SHR-08. Logout protection

**Purpose.** No path in this app silently discards a technician's work — logout is that rule
at a different door (`PLAN-FRONTEND.md` §5).

**Worst moment.** End of shift, shared handset, tired human handing the phone over.

### Anatomy
Logout pressed with rows `queued`/`inflight` → blocked inline: "3 items not yet synced" +
**[Retry now]**; no confirm-and-lose path exists. Only `rejected` rows remaining → logout
proceeds; those rows are kept, keyed to the employee, and reappear when he logs back in on
that handset. Mirror cleared on user switch; outbox filtered, never wiped.

### Not on this screen
No "are you sure" over lost work, no wipe-with-logout, no per-row logout decisions.

## Appendix — Accessibility (all screens)

- Targets 52px field/console, hit slop 8dp; the Job Logs 44px fallback is the documented
  exception, seated and ungloved.
- Focus ring NTX-6 on every interactive element; TalkBack labels name the action and the
  object ("Start job JC-2627-00041", never "button").
- State never by colour alone: rails pair with pills, chips carry words, offline is a banner
  not a grey dot.
- Text must survive 1.3× font scale without clipping; money wraps, never truncates.
- Reduced motion: movement goes, feedback stays (`02-MOTION.md` §5).
- Contrast: every pair measured in `01-FOUNDATIONS.md` §1 — floors chosen for sunlight, not
  monitors.
