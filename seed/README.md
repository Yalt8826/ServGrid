# Seed data

Rows, not shape — migrations own the schema (PLAN-DATA-MODEL.md §1 §8).
Run against an already-migrated database, in this order, with
`ON_ERROR_STOP=1` so a failure stops the sequence loudly instead of
half-seeding:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v owner_username=owner \
  -v owner_password_hash='<PHC hash>' \
  -v owner_full_name='<name>' \
  -f seed/001_owner.sql

psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed/002_services.sql
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 -f seed/003_products.sql   # dev + staging only
```

| File | Contents | Environments |
|---|---|---|
| `001_owner.sql` | An owner account, `must_change_password`. **Run twice in production** — see below | all — first boot |
| `002_services.sql` | `INSTALL`, `AMC`, `BATT-SWAP`, `SITE-SURVEY`, `REPAIR` | all |
| `003_products.sql` | ~20 representative UPS/battery SKUs | dev, staging — **not production** (real price list enters production through the API) |

Every file is idempotent (`ON CONFLICT … DO NOTHING`) and prints the
rows it ended with — a seed is not done until someone has looked at
what it produced.

## Production needs **two** owner accounts

`001_owner.sql` takes the username as a variable, so run it a second
time with a different one. This is a Phase 0 **exit criterion**
(`docs/implementation/PHASE-0-FOUNDATION.md` T0.8), not a nicety:

```bash
psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
  -v owner_username=owner2 \
  -v owner_password_hash='<a second PHC hash>' \
  -v owner_full_name='<the second person>' \
  -f seed/001_owner.sql
```

**Why.** Accounts are owner-created, there is no email, no reset flow
and one owner. If he forgets his password, nobody can reset it. The
second account is the real answer — an administrative control that
costs nothing — and the break-glass CLI
(`pnpm -F api admin:reset-password`) is the answer when *that* is lost
too. Both must be **exercised**, not merely created: an untested
recovery path is the same class of belief as an untested backup, and
this phase already refuses that one.

**It is handed to a person.** The second credential goes to one other
trusted individual, and the handover is the step that completes it —
a row in `employees` that nobody holds the password to recovers
nothing. Tick the exit box when the handover has actually happened,
and record who holds it (`docs/implementation/T0.16-RUNBOOK.md`).

The owner hash is generated from the same parameters as the API's
`verifyPassword` (both read `apps/api/src/lib/password.ts`):

```bash
openssl rand -base64 18 | pnpm -F api exec tsx tools/hash-password.ts
```

The temporary password travels by phone or in person, never in a shell
history or a ticket; `must_change_password` forces a change on first
login. The demo fixture (`fixtures/demo.sql`, PLAN-DATA-MODEL.md §8)
is a separate artefact for dev/demo/load sanity and is **never** used
on production.
