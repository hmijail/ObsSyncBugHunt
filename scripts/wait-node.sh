#!/usr/bin/env sh
# Block until a node is genuinely ready, so callers (make run) never race a
# half-started container. Readiness is checked in layers, GUI-liveness BEFORE
# Sync, so the failure modes stay distinguishable.
#
# ORDERING INVARIANT: no Sync-related call happens until all three liveness
# signals pass. The blank-screen startup failure is a render problem, not Sync;
# we prove the app is alive using only non-Sync signals (screenshot, windows,
# vault `files`) before Sync is ever touched.
#
#   1. GUI process exists                 (else exit 1: infra failure)
#   2. Liveness — ALL THREE must pass:    (else exit 2: stuck/blank screen)
#        shot_bytes >= SHOT_MIN  &&  windows >= 1  &&  notes != ERR
#   3. Sync CLI responds                  (else exit 3: rendered but Sync hung —
#                                          a candidate bug, NOT a startup flake)
#
# Probes are serial and timeout-guarded (concurrent CLI calls to one app wedge
# it; a timed-out probe means "unresponsive", never "busy"). Every health report
# is echoed (captured in trial logs) and also appended in-container to
# /var/log/obsidian-health.log for later analysis.
#
# Usage: wait-node.sh <container> [timeout_seconds]
set -eu

node="$1"
timeout_s="${2:-150}"
cli=/opt/obsidian/obsidian-cli
hc=/usr/local/bin/obsidian-healthcheck
shot_min=2000          # rendered light-theme UI is tens of KB; blank is ~hundreds
t0=$(date +%s)         # anchor: loop logs report seconds elapsed since the first try
deadline=$(( t0 + timeout_s ))

log() { echo "[$node] $*"; }
elapsed() { echo "+$(( $(date +%s) - t0 ))s"; }

alive() { [ "$shot_bytes" -ge "$shot_min" ] && [ "$windows" -ge 1 ] && [ "$notes" != ERR ]; }

# 1. GUI process must exist.
until podman exec "$node" pgrep -f /opt/obsidian/obsidian >/dev/null 2>&1; do
  [ "$(date +%s)" -lt "$deadline" ] || { log "Obsidian process never appeared" >&2; exit 1; }
  sleep 1
done

# 2. Liveness — strict, all three signals. No Sync call before this passes.
shot_bytes=0; windows=0; notes=ERR
n=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  n=$((n + 1))
  report=$(podman exec "$node" timeout 45 "$hc" 2>/dev/null | tail -1)
  shot_bytes=0; windows=0; notes=ERR
  case "$report" in shot_bytes=*) eval "$report" 2>/dev/null || true ;; esac
  log "health #$n $(elapsed): shot_bytes=$shot_bytes windows=$windows notes=$notes"
  alive && break
  sleep 1
done
if ! alive; then
  log "Obsidian never became alive — likely stuck on a blank screen (last: shot_bytes=$shot_bytes windows=$windows notes=$notes)" >&2
  log "  screenshot: podman cp $node:/var/log/obsidian-shot.png ." >&2
  exit 2
fi
log "alive"

# 3. Only now probe Sync. Reaching here means the app is alive, so a persistent
#    no-answer is a healthy-app-with-stuck-Sync — surfaced loudly, not as a flake.
#    Judge by the OUTPUT: a real "status:" line (synced/paused/syncing) means the
#    Sync subsystem answered. Exit 0 alone is not enough — obsidian-cli can return
#    0 without a meaningful status. (The node boots paused; literal "synced" is
#    the runner's quiescence requirement, not the gate's.)
n=0
while [ "$(date +%s)" -lt "$deadline" ]; do
  n=$((n + 1))
  out=$(podman exec "$node" timeout 20 "$cli" sync:status 2>/dev/null || true)
  # Judge by output, portably (this script runs on macOS → BSD grep/awk, no GNU
  # sed alternation): a real "status: <synced|paused|syncing>" line means the
  # Sync subsystem answered.
  if printf '%s\n' "$out" | grep -qiE '^status:[[:space:]]*(synced|paused|syncing)'; then
    state=$(printf '%s\n' "$out" | grep -iE '^status:' | head -1 | awk '{print $2}')
    log "sync #$n $(elapsed): status=$state — CLI ready"
    exit 0
  fi
  log "sync #$n $(elapsed): no valid status yet"
  sleep 1
done
log "WARNING: Obsidian is alive but the Sync CLI did not respond in ${timeout_s}s" >&2
log "  — possible Sync hang on a healthy app (candidate bug); inspect via VNC" >&2
exit 3
