# ServGrid monorepo

Field service app for a 14-person UPS and battery business: `apps/mobile`
(Expo Router), `apps/api` (Fastify + Postgres), `packages/shared` (domain
types, zod schemas, permission matrix). The plan lives in `docs/` —
start at `docs/PLAN.md`, and `docs/implementation/` carries the
phase-by-phase build.

## Toolchain

- Node 22 LTS (`packageManager` pins pnpm; `.nvmrc` pins Node)
- pnpm workspaces with `node-linker=hoisted` (Metro resolver requirement)
- TypeScript strict, `noUncheckedIndexedAccess` on

```sh
pnpm install
pnpm typecheck   # tsc across all workspace packages
pnpm lint        # the three custom rules, each proven by a fixture
                 # that must fail (runs eslint over the whole repo)
pnpm test        # unit suites in every package
```

## CI contract

`.github/workflows/ci.yml` gates every PR: typecheck, lint (including
the three custom rules, each proven by a fixture that must fail), unit
tests, integration tests against a testcontainers Postgres, and
migration `up → down → up` on a clean database. Merges to `main` build
and push the API image and deploy staging. **EAS builds stay manual.**

## The three custom lint rules

1. **No literal `#F2C200` outside `theme.ts`** — accent erosion.
2. **No `job_completions` / `service_contracts` in `repo.dispatcher.ts`** — revenue leak.
3. **No `location_pings` / `location_requests` in `repo.dispatcher.ts`** — location split.

Fixtures under `packages/shared/src/__fixtures__/lint-violations/` exist
to fail; `tools/lint-proof.mjs` asserts each fixture produces exactly
its one error and that no clean file trips a custom rule.
