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

# Pre-create the log files so the streaming `tail -F` has them immediately.
mkdir -p /var/log
: > /var/log/xvfb.log
: > /var/log/obsidian.log

export DISPLAY=:99
Xvfb :99 -screen 0 1280x1024x24 -nolisten tcp >/var/log/xvfb.log 2>&1 &
sleep 2

# Electron expects a session bus.
eval "$(dbus-launch --sh-syntax)"
export DBUS_SESSION_BUS_ADDRESS DBUS_SESSION_BUS_PID

echo "[entrypoint] launching Obsidian"
/usr/local/bin/obsidian --no-sandbox --disable-gpu --disable-dev-shm-usage \
  >>/var/log/obsidian.log 2>&1 &
obsidian_pid=$!

if [[ "${CAPTURE:-0}" == "1" ]]; then
  echo "[entrypoint] CAPTURE mode — VNC on :5900 (no password). In the VNC session:"
  echo "  1. Open folder as vault -> $VAULT_DIR"
  echo "  2. enable the CLI: Settings > General > Advanced > Command line interface"
  echo "  3. log into Obsidian Sync; connect/create the TEST remote vault"
  echo "  4. set conflict handling = 'Create conflict file'"
  echo "  5. wait for initial sync to finish, then on the host: make capture"
  x11vnc -display :99 -forever -nopw -shared -rfbport 5900 >/var/log/x11vnc.log 2>&1 &
fi

# Stream Obsidian's log to the container's stdout.
tail -F /var/log/obsidian.log &

# Tie the container's lifetime to Obsidian: if it exits (e.g. a failed launch),
# so does the container — failures then show up in `podman ps` / `make logs`, and
# any waiter fails fast instead of hanging on a log that never grows.
if wait "$obsidian_pid"; then status=0; else status=$?; fi
echo "[entrypoint] Obsidian exited (status $status) — stopping container" >&2
exit "$status"
