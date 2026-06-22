#!/usr/bin/env bash
# Seed the Sync login from a bind-mounted /secrets (if present), then start a
# virtual display + session D-Bus and launch Obsidian (which reopens the test
# vault). Set CAPTURE=1 to also expose VNC for the one-time login.
#
# The image ships no credentials. Run nodes mount /secrets read-only; the login
# container mounts it read-write so `make capture` can write into it.
set -euo pipefail

VAULT_DIR=/root/vaults/TestVault
CONFIG_DIR=/root/.config/obsidian

# Seed from the captured login if one is mounted. Copy (not symlink) so each
# node gets its own writable state from a shared, read-only source.
if [[ -d /secrets/config ]]; then
  echo "[entrypoint] seeding config from /secrets/config"
  mkdir -p "$CONFIG_DIR"
  cp -a /secrets/config/. "$CONFIG_DIR"/
fi
if [[ -d /secrets/vault ]]; then
  echo "[entrypoint] seeding vault .obsidian from /secrets/vault"
  mkdir -p "$VAULT_DIR/.obsidian"
  cp -a /secrets/vault/. "$VAULT_DIR/.obsidian"/
fi

# If no login was seeded, open the test vault directly at launch. Opening a vault
# from the picker triggers a renderer reload that goes white-then-black in this
# headless setup; starting straight in the vault avoids that transition.
if [[ ! -f "$CONFIG_DIR/obsidian.json" ]]; then
  mkdir -p "$CONFIG_DIR"
  printf '{"vaults":{"a1b2c3d4e5f60718":{"path":"%s","ts":1700000000000,"open":true}}}' \
    "$VAULT_DIR" > "$CONFIG_DIR/obsidian.json"
fi

# Pre-create the log files so the streaming `tail -F` has them immediately.
mkdir -p /var/log
: > /var/log/xvfb.log
: > /var/log/obsidian.log

export DISPLAY=:99
# A reused container (`podman restart`) keeps the prior boot's /tmp, and a stale
# lock makes Xvfb abort with "Server is already active for display 99". Clear it
# so startup is idempotent regardless of leftover state.
rm -f /tmp/.X99-lock
rm -rf /tmp/.X11-unix/X99
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/var/log/xvfb.log 2>&1 &

# Wait until the X server actually accepts connections. A fixed sleep races
# Electron's startup and causes intermittent SIGTRAP crashes on launch.
for _ in $(seq 1 50); do
  if xdpyinfo -display :99 >/dev/null 2>&1; then break; fi
  sleep 0.2
done

# Electron expects a session bus.
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

# Minimal window manager so the Obsidian window is mapped and visible over VNC
# (without one, the display is just the bare gray X root).
openbox &

# Wait until the WM is actually managing before launching the app, rather than a
# blind sleep: an EWMH-compliant WM (openbox is) sets _NET_SUPPORTING_WM_CHECK on
# the root window once it's up.
for _ in $(seq 1 50); do
  if xprop -root _NET_SUPPORTING_WM_CHECK 2>/dev/null | grep -q 'window id'; then break; fi
  sleep 0.2
done

# Always expose VNC (password: obsidian) so any node can be inspected/debugged.
echo "[entrypoint] VNC available on :5900 (password: obsidian)"
x11vnc -display :99 -forever -shared -rfbauth /etc/x11vnc.pass -rfbport 5900 \
  >/var/log/x11vnc.log 2>&1 &

# Launch Obsidian, retrying until it actually RENDERS. Electron on this headless
# software-render path (Xvfb + --disable-gpu) intermittently SIGTRAPs on startup;
# worse, a relaunch can come up as a black "zombie" — main process alive but the
# renderer never paints and the CLI never answers. So a real render is required,
# defined as BOTH rendered pixels (PNG of tens of KB; a blank screen is a few
# hundred bytes) AND a mapped window. The window requirement rejects a stale
# framebuffer: after we kill a prior attempt its pixels can linger on the root
# with no window (nothing repaints without a compositor). Each attempt starts
# from clean state so a crashed attempt can't poison the next.
render_shot=/var/log/obsidian-shot.png
t0=$(date +%s)          # anchor: elapsed seconds reported relative to the first try
attempts=8
# A healthy render lands in ~2-3s (measured via the 1s logs below); a dead-renderer
# zombie never paints. So a short budget cleanly distinguishes them and recovers a
# zombie fast — no need to wait long. The elapsed-time logs will flag it if a
# legitimate render ever exceeds this.
per_attempt_budget="${OBSIDIAN_RENDER_BUDGET:-15}"

# Launch flags are overridable (OBSIDIAN_FLAGS) so different Electron/headless
# render flags can be A/B-tested against the renderer-crash rate without rebuilding.
obsidian_flags="${OBSIDIAN_FLAGS:---no-sandbox --disable-gpu --disable-dev-shm-usage}"
echo "[entrypoint] obsidian flags: $obsidian_flags"

obsidian_pid=""
for attempt in $(seq 1 "$attempts"); do
  echo "[entrypoint] launching Obsidian (attempt $attempt)"
  pkill -9 -f 'obsidian --' 2>/dev/null || true            # kill leftover GUI tree (not obsidian-cli)
  rm -f /root/.config/obsidian/Singleton* 2>/dev/null || true
  # shellcheck disable=SC2086 -- intentional word-splitting of the flag list
  /usr/local/bin/obsidian $obsidian_flags >>/var/log/obsidian.log 2>&1 &
  obsidian_pid=$!

  # Poll for a genuine render at 1s cadence. Check-and-print FIRST (so the first
  # check lands at ~+0s and the launch->render timeline is captured), then sleep.
  rendered=0
  check=0
  a_deadline=$(( $(date +%s) + per_attempt_budget ))
  while :; do
    if ! kill -0 "$obsidian_pid" 2>/dev/null; then
      echo "[entrypoint] attempt $attempt: process died during startup (+$(( $(date +%s) - t0 ))s)" >&2
      break
    fi
    check=$((check + 1))
    import -window root "$render_shot" 2>/dev/null || true
    # `|| true`: grep -c exits 1 on a 0 count, and stat fails if the shot is
    # missing — under `set -e` a failing $() in an assignment would kill us.
    bytes=$(stat -c %s "$render_shot" 2>/dev/null || echo 0); case "$bytes" in ''|*[!0-9]*) bytes=0 ;; esac
    windows=$(xlsclients -display :99 2>/dev/null | grep -c . || true); case "$windows" in ''|*[!0-9]*) windows=0 ;; esac
    echo "[entrypoint] attempt $attempt render #$check +$(( $(date +%s) - t0 ))s: shot_bytes=$bytes windows=$windows"
    if [ "$bytes" -ge 2000 ] && [ "$windows" -ge 1 ]; then rendered=1; break; fi
    if [ "$(date +%s)" -ge "$a_deadline" ]; then break; fi
    sleep 1
  done
  if [ "$rendered" = 1 ]; then
    # Headline: how many attempts it actually took. Also recorded to a file so the
    # harness reads the count reliably instead of racing the log stream.
    echo "[entrypoint] Obsidian up after $attempt attempt(s) (+$(( $(date +%s) - t0 ))s)"
    echo "$attempt" > /var/log/obsidian-attempts
    break
  fi
  echo "[entrypoint] Obsidian did not render (attempt $attempt)" >&2
  if [ "$attempt" = "$attempts" ]; then
    echo "[entrypoint] Obsidian failed to render after $attempts attempts" >&2
    echo "FAIL" > /var/log/obsidian-attempts
    exit 1
  fi
done

# Stream Obsidian's log to the container's stdout.
tail -F /var/log/obsidian.log &

# Tie the container's lifetime to Obsidian: if it exits (e.g. a failed launch),
# so does the container — failures then show up in `podman ps` / `make logs`, and
# any waiter fails fast instead of hanging on a log that never grows.
if wait "$obsidian_pid"; then status=0; else status=$?; fi
echo "[entrypoint] Obsidian exited (status $status) — stopping container" >&2
exit "$status"
