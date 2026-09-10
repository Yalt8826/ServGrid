-- Seed 001 — the first owner account (PLAN-DATA-MODEL.md §8).
-- Runs against every environment on first boot: the fourteen staff
-- accounts are owner-created later through employee CRUD, but there is
-- no UI until someone can log in, and "seeding them by hand into
-- production is how a password reaches a shell history".
--
-- The hash is generated OUTSIDE this file. Generate one on athena (the
-- parameters come from apps/api/src/lib/password.ts, the one place
-- every stored hash is written):
--
--   openssl rand -base64 18 | pnpm -F api exec tsx tools/hash-password.ts
--
-- then run this seed with the values as psql variables:
--
--   psql "$DATABASE_URL" -v ON_ERROR_STOP=1 \
--     -v owner_username=owner \
--     -v owner_password_hash='<PHC string from the command above>' \
--     -v owner_full_name='<the owner's name>' \
--     -f seed/001_owner.sql
--
-- Omitting owner_password_hash is a loud psql substitution error, never
-- a row with an empty or known hash. must_change_password stays true so
-- the first login forces a change before anything else works.

\if :{?owner_full_name}
\else
\set owner_full_name 'ServGrid Owner'
\endif

INSERT INTO employees (username, password_hash, full_name, role, must_change_password)
VALUES (:'owner_username', :'owner_password_hash', :'owner_full_name', 'owner', true)
ON CONFLICT (username) DO NOTHING;

-- The operator reads the resulting row off the terminal — the seed is
-- not "done" until someone sees this line.
SELECT username, full_name, role, is_active, must_change_password
FROM employees
WHERE username = :'owner_username';
