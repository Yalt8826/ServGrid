# apps/mobile

Expo (SDK 54, pinned) shell for the ServGrid app — Android for all four
roles, desktop web for the owner. Architecture lives in
`docs/PLAN-FRONTEND.md`; the visual system in `docs/UI/plan-2/`.

## Run

```sh
pnpm -F mobile start          # dev server; press a | w for device | web
pnpm -F mobile typecheck      # strict TS
pnpm -F mobile test           # vitest — token-store contract + API client
```

## Layout

```
app/                      Expo Router — ONE tree (PLAN-FRONTEND.md §2);
                          roles differ in reachability, not in files
src/lib/tokenStore.ts     the one TokenStore interface + payload validation
src/lib/tokenStore.impl.native.ts   expo-secure-store — never bundled for web
src/lib/tokenStore.impl.web.ts      localStorage — never bundled for native
src/lib/apiClient.ts      fetch wrapper: Idempotency-Key, X-Source,
                          X-Device-Id, refresh-on-401, retry-once
src/state/                session store, non-blocking bootstrap, query client
e2e/cold-start-offline.yaml   Maestro flow (runs for real in Phase 1)
```

## The two rules this shell exists to enforce

1. **Shared code never imports `expo-secure-store`.** The platform split
   is Metro's `.native.ts` / `.web.ts` resolution. A direct import in a
   shared file produces a web build where login silently fails on every
   reload.
2. **Only a completed refresh rejection logs out.** A refresh that fails
   because there is no connection (or a 429/5xx) is a retry; the stored
   session survives. Proven by `src/lib/apiClient.test.ts`.
