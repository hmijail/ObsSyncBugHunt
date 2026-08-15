#!/usr/bin/env sh
# Verify the assumption the `network` isolator is built on: a D/C pair is a brief LINK BLIP, not
# a network reset.
#
# WHY THIS EXISTS. `D` (disconnect) / `C` (connect) are meant to simulate a device losing wifi for
# a few seconds and getting it back — the node's TCP connections to Sync stall and resume. They
# are NOT meant to simulate a full network reset, where the node reappears with a new address, the
# old connections die on timeout, and Obsidian runs its error-recovery/rejoin path instead. Those
# are different experiments, and a history like N2DN1AaWN2AaCW only means what we think it means
# if the reconnect is the first kind.
#
# What makes it the first kind is that the node's IP is re-pinned on reconnect, so the 4-tuples of
# its established connections stay valid and they simply resume. That is an assumption about
# CONTAINER-ENGINE INTERNALS — how fast an engine rebuilds a veth, reprograms NAT, and lets
# traffic flow again — and engines change. Podman and Docker already differ here (Docker cannot
# re-pin a MAC at all; see docs/DESIGN.md), so this is exactly the kind of thing that can quietly
# regress under an engine upgrade and silently change what every `D`/`C` in the suite means.
#
# So: measure it, don't assume it. Run this after installing/switching/upgrading an engine.
#
# HOW. A disposable container on the test network runs a tight probe loop (the SAME
# `bash /dev/tcp` reachability probe isolate.ts uses in production, so this validates the real
# primitive rather than a lookalike), logging `<uptime> <rc>` lines. We then disconnect it, wait,
# reconnect it, and read back when reachability actually returned. Every timestamp comes from the
# CONTAINER's own /proc/uptime — one clock, 10ms resolution, no host/container clock correlation
# needed across an engine command whose own duration is part of what's being measured.
#
# Reported per round:
#   after-connect   time from `network connect` RETURNING to the first successful probe.
#                   This is what's budgeted (default 1.0s) — "the connection comes up soon
#                   enough after reconnecting".
#   total           the same, but measured from just BEFORE the connect command was issued, so it
#                   includes the command's own execution time. Informational.
# Plus a hard check that the reconnected container really came back on its pinned IP — the whole
# mechanism depends on that, and an engine that silently reassigned it would invalidate the run.
#
# Usage: scripts/net-check.sh [rounds] [outage_seconds] [budget_seconds]
#        make net-check                       (rounds=3, outage=10s, budget=1.0s)
#        make net-check ROUNDS=10 BUDGET=0.5
#
# Exits 0 if every round is within budget and the IP was preserved; 1 otherwise.
set -u

ENGINE="${ENGINE:-${CONTAINER_ENGINE:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}}"
NET="${NET:-obsidian-net}"
ROUNDS="${1:-3}"
OUTAGE="${2:-10}"
BUDGET="${3:-1.0}"
NAME=netcheck
# Same base image the node image is built FROM (see containers/Dockerfile), so the probe runs in
# the same userland the real nodes do. No Obsidian, no captured login — this check is purely about
# the engine's networking and must be runnable before any of that exists.
IMG=debian:bookworm-slim
# Deliberately the pinned identity of a node that does NOT exist in a normal run (n9 -> .109), so
# this can never collide with a live n1/n2 on the same network.
IP=10.89.0.109
MAC=6e:62:6e:65:74:6d

echo "net-check: engine=$ENGINE network=$NET rounds=$ROUNDS outage=${OUTAGE}s budget=${BUDGET}s"

# The test network must already exist with the right subnet — `make net` owns that logic, and
# `make net-check` depends on it. Fail loudly rather than quietly creating a differently-shaped one.
if ! $ENGINE network inspect "$NET" >/dev/null 2>&1; then
  echo "net-check: network '$NET' does not exist — run 'make net' first" >&2
  exit 1
fi

cleanup() { $ENGINE rm -f "$NAME" >/dev/null 2>&1 || true; }
trap cleanup EXIT INT TERM
cleanup

# Probe loop: append "<uptime> <rc>" as fast as it can manage. A failing probe returns
# immediately (no route => ENETUNREACH, not a timeout), so the loop stays tight while offline and
# the first success after reconnect is caught within ~50ms.
$ENGINE run -d --name "$NAME" --network "$NET" --ip "$IP" --mac-address "$MAC" "$IMG" \
  bash -c 'while :; do
             t=$(cut -d" " -f1 /proc/uptime)
             timeout 1 bash -c "echo > /dev/tcp/8.8.8.8/53" >/dev/null 2>&1
             echo "$t $?" >> /probe.log
             sleep 0.05
           done' >/dev/null || { echo "net-check: could not start the probe container" >&2; exit 1; }

uptime_now() { $ENGINE exec "$NAME" cut -d' ' -f1 /proc/uptime; }

# Wait for the probe loop to actually be succeeding before trusting any measurement.
i=0
while [ "$i" -lt 60 ]; do
  ok=$($ENGINE exec "$NAME" sh -c 'grep -c " 0$" /probe.log 2>/dev/null || echo 0')
  [ "${ok:-0}" -gt 2 ] && break
  i=$((i + 1)); sleep 1
done
if [ "${ok:-0}" -le 2 ]; then
  echo "net-check: the probe container never reached 8.8.8.8:53 even while connected —" >&2
  echo "  this machine has no outbound connectivity, so the check can't say anything." >&2
  exit 1
fi
echo "net-check: probe container up and reaching the internet"

# Can this engine re-pin the MAC? Reported, not required — losing it is tolerable (see
# docs/DESIGN.md); losing the IP is not, and that's asserted per round below.
if $ENGINE network connect --help 2>&1 | grep -q -- '--mac-address'; then
  MACARG="--mac-address $MAC"; echo "net-check: engine can re-pin MAC on reconnect"
else
  MACARG=""; echo "net-check: engine canNOT re-pin MAC on reconnect (IP only) — expected on Docker"
fi

fails=0
r=1
while [ "$r" -le "$ROUNDS" ]; do
  $ENGINE network disconnect "$NET" "$NAME" >/dev/null 2>&1
  sleep "$OUTAGE"

  u_pre=$(uptime_now)
  # shellcheck disable=SC2086  # $MACARG is deliberately unquoted: two words or none.
  $ENGINE network connect --ip "$IP" $MACARG "$NET" "$NAME" >/dev/null 2>&1 \
    || { echo "round $r: FAIL — 'network connect' itself failed"; fails=$((fails + 1)); r=$((r + 1)); continue; }
  u_post=$(uptime_now)

  # Give reachability plenty of room to return, so a genuinely slow reconnect is MEASURED as slow
  # rather than being cut off and reported as "never" — an over-budget number is the finding here.
  sleep 8

  # `hostname -I` rather than `ip addr`: debian:bookworm-slim ships no iproute2, and this needs no
  # extra package (installing one would need the very network being tested).
  ip_now=$($ENGINE exec "$NAME" sh -c 'hostname -I 2>/dev/null | tr -d " \n"')
  first_ok=$($ENGINE exec "$NAME" awk -v u="$u_pre" '$1 > u && $2 == 0 { print $1; exit }' /probe.log)

  if [ -z "$first_ok" ]; then
    echo "round $r: FAIL — never became reachable again (ip=$ip_now)"
    fails=$((fails + 1))
  else
    verdict=$(awk -v f="$first_ok" -v pre="$u_pre" -v post="$u_post" -v b="$BUDGET" -v ip="$ip_now" -v want="$IP" 'BEGIN {
      after = f - post; if (after < 0) after = 0
      total = f - pre
      bad = (after > b) || (ip != want)
      printf "%s after-connect=%.2fs total=%.2fs ip=%s%s", (bad ? "FAIL" : "ok  "), after, total, ip,
             (ip != want ? sprintf(" (EXPECTED %s — pinning did not hold)", want) : "")
      exit bad ? 1 : 0
    }') || fails=$((fails + 1))
    echo "round $r: $verdict"
  fi
  r=$((r + 1))
done

echo
if [ "$fails" -eq 0 ]; then
  echo "net-check: PASS — a $OUTAGE""s outage reconnects within ${BUDGET}s on its pinned IP."
  echo "  D/C is a link blip: established connections stall and resume, they don't reset."
  exit 0
fi
echo "net-check: FAIL ($fails/$ROUNDS rounds) — reconnection is slower than ${BUDGET}s or lost the pinned IP." >&2
echo "  A D/C on this engine may no longer be a brief blip but a full network reset, which changes" >&2
echo "  what every history containing D/C actually tests. Investigate before trusting new runs;" >&2
echo "  see docs/DESIGN.md ('network identity: pinning the same IP/MAC across reconnects')." >&2
exit 1
