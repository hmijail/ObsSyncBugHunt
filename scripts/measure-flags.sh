#!/usr/bin/env sh
# Measure the Obsidian renderer-crash rate for a given launch-flag set.
#
# The entrypoint retries launching Obsidian until it actually renders and records
# how many attempts that took in /var/log/obsidian-attempts. Booting a node N
# times and collecting those counts gives the per-attempt render-success rate:
#   p (success) = boots / total_attempts ;  mean attempts = 1/p.
# Lower mean / higher p = fewer renderer crashes. At p≈0.5 a handful of boots
# already separates a good flag set from a bad one, so N defaults to 10.
#
# Flags are passed to the node via OBSIDIAN_FLAGS (entrypoint honours it), so no
# image rebuild is needed between variants. A short render budget is used so a
# zombie attempt is given up on quickly during measurement.
#
# Usage: scripts/measure-flags.sh "<label>" "<obsidian flags>" [N]
set -u

label="$1"; flags="$2"; N="${3:-10}"
img=obsidian-node; net=obsidian-net; name=measure
secrets="$(cd "$(dirname "$0")/.." && pwd)/secrets/obsidian"

# Isolation guard: every node boots from the SAME cloned Sync login (same device
# id), so any other node running alongside the measurement confounds it — two
# instances on one account, plus extra CPU on the machine. Refuse to run if
# anything is already up on the test network (our own leftover excepted).
podman rm -f "$name" >/dev/null 2>&1 || true
running=$(podman ps --filter "network=$net" --format '{{.Names}}' 2>/dev/null | tr '\n' ' ')
if [ -n "$(echo "$running" | tr -d ' ')" ]; then
  echo "measure-flags: other node(s) running on $net: $running" >&2
  echo "  stop them first (e.g. 'make containers-down') so they can't confound the measurement." >&2
  exit 1
fi

ok=0; total=0; a1=0; results=""
for i in $(seq 1 "$N"); do
  podman rm -f "$name" >/dev/null 2>&1 || true
  podman run -d --name "$name" --network "$net" \
    -e OBSIDIAN_FLAGS="$flags" -e OBSIDIAN_RENDER_BUDGET=8 \
    -v "$secrets":/secrets:ro "$img" >/dev/null

  att=""
  for _ in $(seq 1 90); do
    att=$(podman exec "$name" cat /var/log/obsidian-attempts 2>/dev/null || true)
    if [ -n "$att" ]; then break; fi
    if [ "$(podman inspect -f '{{.State.Running}}' "$name" 2>/dev/null || echo false)" != true ]; then break; fi
    sleep 1
  done
  if [ -z "$att" ]; then att="FAIL"; fi
  results="$results $att"
  case "$att" in
    *[!0-9]*) : ;;                                    # FAIL / non-numeric
    *) ok=$((ok + 1)); total=$((total + att)); if [ "$att" = 1 ]; then a1=$((a1 + 1)); fi ;;
  esac
  echo "[$label] boot $i: attempts=$att"
done
podman rm -f "$name" >/dev/null 2>&1 || true

echo "[$label] results:$results"
if [ "$total" -gt 0 ]; then
  awk -v ok="$ok" -v total="$total" -v a1="$a1" -v n="$N" -v l="$label" 'BEGIN{
    printf "[%s] boots=%d ok=%d  attempt1=%d/%d  per-attempt p=%.2f  mean attempts=%.2f\n",
      l, n, ok, a1, n, ok/total, total/ok }'
else
  echo "[$label] no successful boots"
fi
