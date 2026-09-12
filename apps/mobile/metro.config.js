// Metro configuration (Expo default + one asset extension).
//
// `expo-sqlite`'s **web** implementation is wa-sqlite, which loads a
// `.wasm` binary from inside the package. Metro treats unknown extensions
// as source and tries to parse them, so without `wasm` in `assetExts` the
// web bundle fails outright:
//
//   Unable to resolve module ./wa-sqlite/wa-sqlite.wasm
//   from expo-sqlite/web/worker.ts
//
// That broke `pnpm -F mobile bundle:check` — and with it the owner's web
// build — the moment T1.13 landed the mirror, even though no web role
// ever opens a database.
//
// Why the web bundle sees SQLite at all, given PLAN-FRONTEND.md §4 says
// dispatchers and owners never initialise it: `db/mirror.ts` guards the
// load behind `roleHasMirror(role)` and reaches it through a **dynamic**
// `await import('./sqliteMirror')`. That guard is correct and does its job
// at runtime — an owner session never executes the import. But a dynamic
// import is still an edge in Metro's module graph: it becomes a lazily
// loaded chunk, not an absent one, so the file must still *resolve* at
// build time. Runtime reachability and build-time resolvability are
// different questions, and only the first one is role-gated.
//
// The alternative was a `.native.ts` split on `sqliteMirror`, matching
// `sync/triggers.ts`. It was not taken: vitest resolves by Node rules and
// would pick the web stub over `.native.ts`, so the mirror suite would
// then be testing the stub. One asset extension is the smaller, honest
// change; the lazy chunk means the wasm is never fetched by a web client
// that never opens a mirror.
const { getDefaultConfig } = require('expo/metro-config');

const config = getDefaultConfig(__dirname);
config.resolver.assetExts.push('wasm');

module.exports = config;
