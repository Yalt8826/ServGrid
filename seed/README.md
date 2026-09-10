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
| `001_owner.sql` | One owner account, `must_change_password` | all — first boot |
| `002_services.sql` | `INSTALL`, `AMC`, `BATT-SWAP`, `SITE-SURVEY`, `REPAIR` | all |
| `003_products.sql` | ~20 representative UPS/battery SKUs | dev, staging — **not production** (real price list enters production through the API) |

Every file is idempotent (`ON CONFLICT … DO NOTHING`) and prints the
rows it ended with — a seed is not done until someone has looked at
what it produced.

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
