# Sales Rep — Screen Specifications

Density `field`. **Offline-first** — reuses the Phase 1 outbox unchanged. Two users, Phase 3.

Four tabs: Dashboard · Sales · **Cash** · Profile. The Sales group carries sales, payments, companies, contracts and renewals — contracts are commercial for a rep, not operational, which is why the group map is per role rather than the owner's map with rows hidden (`PLAN-FRONTEND.md` §3).

**The role's condition:** in a customer's office or reception, phone in hand, often mid-conversation about money. Signal is usually fine but not guaranteed. Unlike the technician, he is not rushed and not gloved — but he is **being watched by the person whose balance is on the screen**, which is its own constraint.

**The design consequence:** every screen a rep opens in front of a customer must be legible upside down and at arm's length, and must never show something embarrassing — a stale figure, a spinner, another rep's account.

---

## S1. Dashboard

**Purpose.** Answer "how am I doing this month, and who owes me money?"

**Worst moment.** Sitting down with a company's accounts person who says "we paid that last week."

### Anatomy

```
┌────────────────────────────────────────┐
│ Anitha                       ⟳ 2       │
├────────────────────────────────────────┤
│  ₹4,20,000        ₹1,85,000            │
│  sold this month  outstanding          │  display 32 Condensed
├────────────────────────────────────────┤
│ [ + New sale ]                         │
├────────────────────────────────────────┤
│ OWES THE MOST                          │
│ Sterling Industries      ₹85,000   →   │
│ Nandi Motors             ₹42,500   →   │
│ Prakash Textiles         ₹31,000   →   │
├────────────────────────────────────────┤
│ RENEWING SOON                          │
│ Kormangala site · AMC-…0031 · 22 days  │
├────────────────────────────────────────┤
│ RECENT PAYMENTS                        │
└────────────────────────────────────────┘
```

### Content

- **Two figures**, both money, both `mono` tabular, `en-IN`. Sold this month and total outstanding across his accounts.
- **Owes the most** — top companies by balance, descending. This is the working list; a rep's day is largely this list in order.
- **Renewing soon** — contracts he sold, expiring within 60 days, from `v_contracts_expiring`. Days remaining, not a date, because urgency is the point.
- **Recent payments** — his last few collections, for reassurance that they landed.

### States

- **Empty:** "No sales yet this month." No illustration.
- **Stale:** the *figures* carry the dashed inset when the mirror has unsynced writes behind them. This matters more here than anywhere: a balance shown to a customer while a payment sits in the outbox is the single most embarrassing thing this app can do. The inset plus `Pending sync` is the honest answer.

### Motion

Figures cross-fade on change, 140ms. No count-up — a money figure animating in front of a customer looks like a slot machine.

---

## S2. Sales

**Purpose.** Create a sale; find a past one.

### Anatomy — list

Rows: sale number (mono) · company · date · total (mono, right-aligned) · status pill (`Draft` / `Confirmed` / `Void`).

Drafts sort first and carry a `Draft` chip — an unconfirmed sale burns no number and moves no balance, so it needs to be visibly unfinished.

### Anatomy — create

```
Company     [ search his accounts + house ▾ ]
Date        [ Today ▾ ]

LINE ITEMS
┌──────────────────────────────────────┐
│ UPS 850VA Luminous                   │
│ 2 × ₹8,400            = ₹16,800   ✕  │
└──────────────────────────────────────┘
[ + Add item ]
                        Total  ₹16,800
Notes       [                          ]

[ Save draft ]        [ Confirm sale ]
```

### Content decisions

- **The product picker snapshots name, SKU and price at add time.** The row shows the snapshot, not a live lookup — a repricing next quarter must not rewrite this sale (`PLAN-DATA-MODEL.md` §3.5).
- **The unit price is editable** on the line, because a negotiated price is normal. The snapshot records what was actually agreed.
- **Serial numbers** are an optional per-line field, collapsed.
- **Total is computed and displayed**, unlike the technician's parts list — here it *is* a bill, and `v_sales_card_totals` defines it.
- **Confirm allocates the number.** Until then the card shows `Draft`, never a fake number.

### The two-button ending

*Save draft* (secondary) and *Confirm sale* (primary). Confirming is the action that moves a company's balance, so it gets the accent and a confirmation step — **and only the owner can void afterwards**, which is the correct amount of friction for an irreversible move (`PLAN-BACKEND.md` §11).

### Motion

Adding a line: 220ms height + opacity, and the total cross-fades. Removing: swipe left on the row reveals delete, `spring.snap`. Confirm: `ImpactMedium` haptic, then the sheet closes and the number arrives from sync — the row's `Pending sync` chip becomes `SL-2627-00018` with a 140ms cross-fade.

---

## S3. Payments

**Purpose.** Two tabs — **Pending** and **Collected**.

### The distinction the UI must carry

**Pending is a view of dues, not a list of payment rows.** It lists **companies that owe money**, read from `v_company_balances WHERE balance > 0`. Collected lists actual `payments`.

Labelling the first tab "Pending payments" invites the reading that a row is a payment, which is exactly the stored-counter thinking the data model rejects (`PLAN-DATA-MODEL.md` §3.5). So the UI says it plainly:

- Tab label: **Owed**, not "Pending".
- Empty state: *"No company owes you anything."*
- Each row reads `Sterling Industries · owes ₹85,000`, with a *Record payment* action — the verb makes clear that the payment does not exist yet.

### Anatomy — record payment

```
Company     [ Sterling Industries        ]  prefilled if from a row
Amount      ₹ [                          ]
Against     [ On account ▾ ]  or a specific sale
Mode        [ Cash ][ UPI ][ Cheque ][ Bank ][ Card ]
Reference   [                          ]     (shown for non-cash)
Proof photo [ 📷 Capture ]
[ Record payment ]
```

- **Mode as segments, on two rows.** Five segments across 360dp gives each about 64dp, and “Bank transfer” does not fit in it at `label` size without truncating to something ambiguous. So: **`Cash` `UPI` `Cheque`** on the first row, **`Bank` `Card`** on the second, each 52 tall. Two rows of comfortable targets beat one row of cramped ones, and this screen is filled in front of the person paying — a mis-tap here records the wrong mode on real money and puts a phantom entry in someone's cash reconciliation.
- **Cash is first and visually identical to the others** — no emphasis, because emphasising cash would nudge behaviour in the one area the reconciliation exists to police. First because it is the one with a consequence, not because it is preferred.
- **Reference appears for non-cash modes** only, and is required for cheque and bank.
- **Proof photo** queues as a local URI and uploads after its parent (`dependsOn`).
- **Choosing Cash raises one line of copy**: *"Cash goes on your handover today."* Not a warning — a reminder that connects two screens the rep would otherwise experience as unrelated.

### Motion

Recording a payment: the company's balance on the previous screen updates optimistically before the sheet closes. This is the clearest demonstration of the derived-balance model in the whole product, and it should feel instant — the figure cross-fades to its new value in 140ms as the sheet dismisses.

---

## S4. Companies

**Purpose.** His accounts, their balances, and the ledger behind each.

### Anatomy — list

Rows: company · balance (mono, right) · last activity. Sorted by balance descending. House accounts (`owner_rep_id IS NULL`) carry a small `Shared` chip.

**He sees his accounts plus house accounts.** Not the other rep's. This is `owner_rep_id = him OR NULL`, and the UI never hints that other accounts exist — no greyed rows, no "12 more".

### Anatomy — detail and ledger

Header: name, contact, phone (tappable), GSTIN, balance as the largest figure on screen.

Ledger: interleaved sales and payments, newest first, with a **running balance column**.

```
6 Sep   Payment  UPI      − ₹40,000    ₹85,000
2 Sep   Sale     SL-…0018 + ₹16,800   ₹1,25,000
28 Aug  Sale     SL-…0017 + ₹52,000   ₹1,08,200
```

Sales positive, payments negative, running balance on the right — all `mono` tabular, so the column aligns and a customer reading it upside down can follow it.

**A negative balance renders in `feedback.success` with the word `Credit`**, not as a minus sign in red. An overpayment is good news and the schema explicitly permits it.

### Actions

*Record payment* (primary) · *New sale* (secondary) · edit details. **No reassign-owner control** — only the owner can move an account between reps, and putting a disabled button here would only invite the question.

---

## S5. Contracts and renewals

**Purpose.** Sell and renew AMCs.

### Anatomy — renewals list

The commercially important screen. Contracts he sold, expiring within 60 days:

```
Kormangala 3rd Blk · AMC-2627-0031
Expires 28 Sep · 22 days
Visits used 3 of 4                ₹18,000
[ Draft renewal ]
```

**Visits used is shown**, because it is what the renewal is worth arguing about. A customer who took three of four visits is a different conversation from one who took all four — and a *spent* visit (skipped, not rescheduled) reduces the value the rep should quote.

### Anatomy — create

Customer site · service · start and end date · visits included · interval days · billing (`Upfront` / `Per visit` segments) · contract value · notes.

**One site, one active AMC.** Drafting for a site that already has one returns 409, and the UI says which contract exists with a link to it — a rep drafting a renewal for a covered site is a normal thing to do, and he needs to be told, not blocked with an error code.

**Activate is the moment.** Draft → active allocates the number and generates the whole visit schedule, which then appears in the detail as a list of dates. Showing the materialised schedule immediately is what makes the contract feel real, and it is what the rep points at when the customer asks when they will be visited.

---

## S6. Cash handover

Identical to the technician's screen (`04-TECHNICIAN.md` §T6) with a different heading. One `MoneyField`, optional note, his own history.

**No expected figure. No expenses field.**

Rep cash is rare — mostly bank transfer, UPI and cheque — and that rarity is exactly why the screen exists and why it must not be hidden behind a menu. **A path nobody exercises is a path nobody notices is broken** (`PLAN-DATA-MODEL.md` §3.7). It sits in the tab bar at the same level as the technician's.

---

## S7. Profile

Name, role, `TrackingHealthChip` (**reps are tracked too**), permission ladder, pending count, *Change password*, *Log out*.

Logout is the same gate as the technician's: blocked while anything is queued.

### Not on this screen

No commission. No targets. No comparison with the other rep. The same reasoning as the technician's profile — two people who work alongside each other do not need the app ranking them.
