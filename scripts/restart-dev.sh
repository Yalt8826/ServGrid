#!/usr/bin/env bash
# restart-dev.sh — kill and restart the ServGrid dev stack, then leave the
# phone ready to test.
#
# What it does, in order:
#   1. compose db + minio — started only if not already up (never bounced
#      while running; Postgres mid-day is nobody's friend)
#   2. anything listening on :8787 (API) and :8081 (Metro) is killed —
#      politely first, then with -9 — whoever started it, however
#   3. the API and Metro start in the background, logging to /tmp
#   4. health gates: the script reports success only when the API answers
#      and Metro's bundler is accepting
#   5. a connected phone gets its adb reverse tunnels re-set and the app
#      relaunched (the debug build loads its JS from Metro, so a restarted
#      Metro needs an app restart to reconnect)
#
# Usage:
#   scripts/restart-dev.sh            # restart servers + phone tunnels
#   scripts/restart-dev.sh --clean    # also clear Metro's transform cache
#                                     # (cold bundle: the first load takes
#                                     # ~15-40s instead of ~2s)
#   scripts/restart-dev.sh --no-app   # leave the phone alone
#
# Logs, for when something will not come up:
#   /tmp/servgrid-api.log
#   /tmp/servgrid-metro.log
#
# The compose stack (db :5433, minio :9000) is left running by this
# script once up — take it down with `pnpm compose:down` deliberately.
set -uo pipefail

CLEAN=0
RELAUNCH_APP=1
for arg in "$@"; do
  case "$arg" in
    --clean) CLEAN=1 ;;
    --no-app) RELAUNCH_APP=0 ;;
    *) echo "unknown flag: $arg (known: --clean, --no-app)" >&2; exit 2 ;;
  esac
done

export PATH="$HOME/Android/Sdk/platform-tools:$PATH"
cd "$(dirname "$0")/.."

say() { printf '%s\n' "$*"; }

pids_on_port() {
  ss -tlnp 2>/dev/null | grep ":$1" | sed -nE 's/.*pid=([0-9]+).*/\1/p' | sort -u
}

# ── 1. compose: db + minio, only if not already running ────────────────────
if ! docker compose ps db 2>/dev/null | grep -q "running\|healthy"; then
  say "compose: starting db + minio …"
  docker compose up -d db minio --wait >/dev/null || {
    say "compose FAILED — see docker compose ps"; exit 1;
  }
else
  say "compose: db + minio already up"
fi

# ── 2. kill whatever holds the ports ───────────────────────────────────────
for port in 8787 8081; do
  for pid in $(pids_on_port "$port"); do
    say "killing :$port (pid $pid)"
    kill "$pid" 2>/dev/null
  done
done
pkill -f "expo start" 2>/dev/null
pkill -f "tsx src/dev.ts" 2>/dev/null
sleep 2
# anything that ignored SIGTERM
for port in 8787 8081; do
  for pid in $(pids_on_port "$port"); do
    say "force-killing :$port (pid $pid)"
    kill -9 "$pid" 2>/dev/null
  done
done
sleep 1

# ── 3. start the API and Metro ─────────────────────────────────────────────
: > /tmp/servgrid-api.log
: > /tmp/servgrid-metro.log
nohup pnpm -F api dev > /tmp/servgrid-api.log 2>&1 &
API_PID=$!
if [ "$CLEAN" -eq 1 ]; then
  nohup pnpm -F mobile start -c --port 8081 > /tmp/servgrid-metro.log 2>&1 &
else
  nohup pnpm -F mobile start --port 8081 > /tmp/servgrid-metro.log 2>&1 &
fi
METRO_PID=$!
say "api pid $API_PID · metro pid $METRO_PID"

# ── 4. health gates ────────────────────────────────────────────────────────
api_ok=0
for _ in $(seq 1 30); do
  if curl -sf -o /dev/null http://127.0.0.1:8787/healthz; then api_ok=1; break; fi
  sleep 1
done
metro_ok=0
for _ in $(seq 1 60); do
  if curl -sf http://127.0.0.1:8081/status | grep -q "packager-status:running"; then metro_ok=1; break; fi
  sleep 1
done

[ "$api_ok" -eq 1 ] && say "api: up on :8787 (healthz ok)" || {
  say "api: DID NOT COME UP — tail of /tmp/servgrid-api.log:"; tail -5 /tmp/servgrid-api.log; }
[ "$metro_ok" -eq 1 ] && say "metro: up on :8081" || {
  say "metro: DID NOT COME UP — tail of /tmp/servgrid-metro.log:"; tail -5 /tmp/servgrid-metro.log; }

# ── 5. the phone ───────────────────────────────────────────────────────────
if adb devices 2>/dev/null | awk 'NR>1 {print $2}' | grep -q "device"; then
  SERIAL="${ANDROID_SERIAL:-$(adb devices | awk 'NR>1 && $2=="device" {print $1; exit}')}"
  adb -s "$SERIAL" reverse tcp:8787 tcp:8787 >/dev/null
  adb -s "$SERIAL" reverse tcp:8081 tcp:8081 >/dev/null
  # 9000 too: attachment bytes (payment proof photos, job photos) are served
  # from MinIO, and the presigned URL is built from the API's own
  # S3_ENDPOINT — http://localhost:9000 — so on the handset that name is the
  # PHONE unless this tunnel exists. Without it every photo in the app is a
  # blank box while every figure beside it is fine (2026-09-18).
  adb -s "$SERIAL" reverse tcp:9000 tcp:9000 >/dev/null
  say "phone $SERIAL: adb reverse set (8787, 8081, 9000)"
  if [ "$RELAUNCH_APP" -eq 1 ]; then
    adb -s "$SERIAL" shell am force-stop com.servgrid.app
    sleep 1
    adb -s "$SERIAL" shell monkey -p com.servgrid.app -c android.intent.category.LAUNCHER 1 >/dev/null 2>&1
    say "phone: app relaunched (first load after --clean takes ~15-40s)"
  fi
else
  say "phone: none attached — adb reverse skipped (plug in and re-run, or set the tunnels by hand:"
  say "  adb reverse tcp:8787 tcp:8787 && adb reverse tcp:8081 tcp:8081 && adb reverse tcp:9000 tcp:9000)"
fi

if [ "$api_ok" -eq 1 ] && [ "$metro_ok" -eq 1 ]; then
  say "ready."
else
  say "ready WITH WARNINGS — check the logs above."
  exit 1
fi
