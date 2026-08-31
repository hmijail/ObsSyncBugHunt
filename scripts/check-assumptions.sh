#!/usr/bin/env sh
# Is the apparatus still what this project thinks it is?
#
# WHY THIS EXISTS. The harness rests on a pile of assumptions about things OUTSIDE it — the
# container engine, the Obsidian build, obsidian-cli's output formats. Those change on someone
# else's schedule, quietly, and a run that starts on a violated assumption doesn't crash: it
# produces plausible-looking results about the wrong experiment. This is the deliberate pass to
# run when you come back to the project after a break, or after an Obsidian / Docker / Podman
# update — the moments when exactly this kind of thing has silently moved underneath you.
#
# NOT a fast pre-flight, and deliberately not wired into `make run`/`containers-up`. It is meant
# to be run rarely and to be thorough; most of its wall-clock is check-net's real 10s outages.
#
# WHAT IT DOES *NOT* COVER, on purpose: anything the runtime already checks per-run. Node
# reachability, every node `synced`, nodes agreeing on note count (run.ts's preflight), and the
# local vault not drifting mid-run are all DYNAMIC — they have to be true now, per run, and are
# verified there. Duplicating them here would rot. What lives here is the slow-changing stuff,
# plus one case (step 6) that the runtime only ever discovers reactively, mid-soak.
#
# Usage: scripts/check-assumptions.sh
#        make check-assumptions            [ROUNDS=n] [NODES=n1,n2]
#
# NEEDS THE NODES RUNNING — run it right after `make containers-up`. Three of its checks (the
# obsidian-cli format sweep on each node, and the live version match) can only be answered by a
# running Obsidian, and those are the likeliest things to have broken while you were away: an
# Obsidian upgrade can change CLI output any time. So with the nodes down this refuses to run at
# all, rather than skipping them and still reporting PASS — which would be this script committing
# the exact sin it exists to catch, a green result covering a third less than it appears to. The
# probe is up front, so you are told in two seconds, not after a minute of the slow checks.
#
# Exits 0 if every hard check passed (advisories don't fail the run), 1 otherwise.
set -u

here="$(cd "$(dirname "$0")" && pwd)"
CONTAINER_ENGINE="${CONTAINER_ENGINE:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
NET="${NET:-obsidian-net}"
SUBNET="${SUBNET:-10.89.0.0/24}"
IMAGE="${IMAGE:-obsidian-node}"
# make passes this; the fallback reads the same ./obsidian-version file make itself reads, so
# running this script by hand needs no arguments and cannot disagree with a `make` run.
OBSIDIAN_VERSION="${OBSIDIAN_VERSION:-$(tr -d '[:space:]' < "$here/../obsidian-version" 2>/dev/null)}"
[ -n "$OBSIDIAN_VERSION" ] || { echo "no Obsidian version: ./obsidian-version is missing or empty" >&2; exit 1; }
NODES="${NODES:-n1,n2}"
ROUNDS="${ROUNDS:-3}"
CLI=/opt/obsidian/obsidian-cli

fails=0
step=0
say()  { step=$((step + 1)); printf '\n[%d/6] %s\n' "$step" "$1"; }
ok()   { printf '      ok   %s\n' "$1"; }
bad()  { printf '      FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }
note() { printf '      --   %s\n' "$1"; }

echo "check-assumptions: engine=$CONTAINER_ENGINE image=$IMAGE:$OBSIDIAN_VERSION network=$NET nodes=$NODES"

# 1. The engine itself. Everything below is meaningless if this isn't answering, and "which engine
#    and which version" is precisely the thing that changes under you between sessions.
say "container engine responds"
if ver=$("$CONTAINER_ENGINE" --version 2>&1); then
  ok "$ver"
else
  bad "'$CONTAINER_ENGINE --version' failed: $ver"
  echo >&2
  echo "check-assumptions: cannot continue without a working engine." >&2
  exit 1
fi

# Are the nodes up? Probed here, before any of the slow checks, and a hard STOP if they aren't.
# This pass only means something as a whole: three of its checks can only be answered by a running
# Obsidian, so without nodes it cannot deliver its one verdict ("are results trustworthy?"). Better
# to spend two seconds saying what to do than a minute producing a partial answer.
live=""
for n in $(echo "$NODES" | tr ',' ' '); do
  if "$CONTAINER_ENGINE" exec "$n" true >/dev/null 2>&1; then live="$n"; break; fi
done
if [ -z "$live" ]; then
  echo >&2
  echo "check-assumptions: STOP — nodes ($NODES) are not running, and 3 of these checks need a" >&2
  echo "  live Obsidian to answer at all." >&2
  echo >&2
  echo "  Run:  make containers-up && make check-assumptions" >&2
  exit 1
fi

# 2. The test network. What matters is NOT which subnet it happens to carry — any private range
#    would do — but whether the addresses this harness actually pins are assignable inside it.
#    Every node is started and reconnected with an explicit `--ip`, so if the network's subnet
#    doesn't cover those addresses, every `containers-up` and every `C` fails with an obscure
#    engine error instead of saying so. Hence a containment test, not a string match: the
#    addresses are taken from the harness itself (NODE_IPS, passed by make from its NODE_ADDR;
#    the probe address is read out of check-net.sh) rather than re-derived here, so this cannot
#    quietly pass while the two have drifted apart.
#
#    The nasty case is a network that ALREADY EXISTS with the wrong subnet — left over from an
#    older Makefile that created it without `--subnet`, or made by hand. `make net` is idempotent
#    and skips creating it, so a wrong one survives indefinitely.
say "test container network is as expected"

# Portable dotted-quad <-> integer, arithmetic only: no shifts (whose signedness varies) and no
# bitwise ops (which POSIX sh has, but dash/ash disagree on for 32-bit-boundary values).
ip2int() {
  IFS=. read -r _o1 _o2 _o3 _o4 <<EOF
$1
EOF
  echo $(( (_o1 * 16777216) + (_o2 * 65536) + (_o3 * 256) + _o4 ))
}
cidr_size() {  # number of addresses a /prefix spans, 1 for /32
  _pfx=${1#*/}
  case "$_pfx" in ""|*[!0-9]*) echo 0; return ;; esac
  [ "$_pfx" -le 32 ] || { echo 0; return; }
  _s=1; _i=$_pfx
  while [ "$_i" -lt 32 ]; do _s=$((_s * 2)); _i=$((_i + 1)); done
  echo "$_s"
}
cidr_base() { # the CIDR's network address, as an integer (host bits cleared)
  _sz=$(cidr_size "$1")
  [ "$_sz" -gt 0 ] || { echo -1; return; }
  echo $(( $(ip2int "${1%/*}") / _sz * _sz ))
}
in_cidr() {   # in_cidr <ip> <cidr> -> 0 when <ip> falls inside <cidr>
  _size=$(cidr_size "$2")
  [ "$_size" -gt 0 ] || return 1
  _base=$(cidr_base "$2")
  _ip=$(ip2int "$1")
  [ "$_ip" -ge "$_base" ] && [ "$_ip" -lt $((_base + _size)) ]
}

# The addresses the harness will really assign. NODE_IPS comes from make (built with the same
# NODE_ADDR the `run`/`network connect` lines use); the fallback keeps this script runnable by
# hand. The probe address is check-net.sh's own, so step 5 can't fail for a reason step 2 missed.
if [ -z "${NODE_IPS:-}" ]; then
  NODE_IPS=""
  for n in $(echo "$NODES" | tr ',' ' '); do
    num=${n#n}
    case "$num" in ""|*[!0-9]*) continue ;; esac
    NODE_IPS="$NODE_IPS 10.89.0.$((100 + num))"
  done
fi
probe_ip=$(sed -n 's/^IP=\([0-9.]*\).*/\1/p' "$here/check-net.sh" | head -1)

if ! "$CONTAINER_ENGINE" network inspect "$NET" >/dev/null 2>&1; then
  bad "network '$NET' does not exist — run 'make net'"
else
  # Both engines' inspect JSON also lists each attached CONTAINER's address in CIDR form
  # (10.89.0.101/24), which is not a subnet declaration and must not be treated as one. Keep only
  # CIDRs whose host bits are zero — that is what distinguishes a network address from a host's.
  cidrs=""
  for c in $("$CONTAINER_ENGINE" network inspect "$NET" 2>/dev/null \
             | grep -oE '[0-9]{1,3}(\.[0-9]{1,3}){3}/[0-9]{1,2}' | sort -u); do
    if in_cidr "${c%/*}" "$c" && [ "$(ip2int "${c%/*}")" -eq "$(cidr_base "$c")" ]; then
      cidrs="$cidrs $c"
    fi
  done
  if [ -z "$(echo "$cidrs" | tr -d ' ')" ]; then
    bad "no subnet found in '$CONTAINER_ENGINE network inspect $NET' — inspect format changed?"
    note "expected a CIDR (the project's own default is $SUBNET)"
  else
    note "network subnet(s):$cidrs"
    unassignable=""
    for addr in $NODE_IPS ${probe_ip:-}; do
      inside=1
      for c in $cidrs; do
        if in_cidr "$addr" "$c"; then inside=0; break; fi
      done
      [ "$inside" -eq 0 ] || unassignable="$unassignable $addr"
    done
    if [ -z "$unassignable" ]; then
      ok "every address the harness pins is inside it:$NODE_IPS ${probe_ip:-} (probe)"
    else
      bad "these pinned addresses are NOT inside the network's subnet:$unassignable"
      note "every 'run --ip' and every reconnect for them will fail with an engine-level error"
      note "fix: make containers-down && $CONTAINER_ENGINE network rm $NET && make net"
    fi
  fi
fi

# 3. The image for the pinned version exists and still ships obsidian-cli — not a documented API,
#    so it could quietly stop being in the portable tarball.
#
#    Only its PRESENCE can be checked here. obsidian-cli is an IPC client to a running Obsidian,
#    not a standalone binary, so `obsidian-cli version` in a bare container answers "The CLI is
#    unable to find Obsidian" — there is no headless mode. The version comparison therefore needs
#    a live node, and happens in step 6 with the rest of the live-node checks.
say "node image $IMAGE:$OBSIDIAN_VERSION is present and ships the CLI"
if ! "$CONTAINER_ENGINE" image inspect "$IMAGE:$OBSIDIAN_VERSION" >/dev/null 2>&1; then
  bad "no such image — run 'make build-image' (or 'make list-images' to see what is built)"
else
  ok "image present"
  if out=$("$CONTAINER_ENGINE" run --rm --entrypoint /bin/sh "$IMAGE:$OBSIDIAN_VERSION" -c "test -x $CLI && echo present" 2>&1); then
    ok "$CLI present and executable"
  else
    bad "$CLI missing or not executable in the image: $out"
    note "a release may have stopped shipping the CLI in the portable tarball"
  fi
fi

# 4. Advisory only: how far behind the pin is. After a long break the useful signal is simply
#    "there are newer releases" — never a failure, since testing an older build is legitimate
#    (and bisecting across releases is an explicit workflow here).
say "pinned Obsidian vs upstream (advisory)"
latest=$(curl -fsSL https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json 2>/dev/null \
         | sed -n 's/.*"latestVersion"[[:space:]]*:[[:space:]]*"\([^"]*\)".*/\1/p' | head -1)
if [ -z "$latest" ]; then
  note "couldn't reach the upstream release manifest (offline?) — skipping"
elif [ "$latest" = "$OBSIDIAN_VERSION" ]; then
  ok "pinned $OBSIDIAN_VERSION is the latest release"
else
  note "pinned $OBSIDIAN_VERSION, latest upstream is $latest — 'make obsidian-latest' for how to move"
fi

# 5. The fault primitive. A D/C must still be a brief link blip rather than a network reset, or
#    every history containing D/C tests something other than what it says. Nothing else exercises
#    this: a history with no `D` never touches it, so it needs its own deliberate measurement.
say "a D/C reconnect is still a brief blip (check-net, $ROUNDS rounds x 10s outage)"
if ROUNDS="$ROUNDS" "$here/check-net.sh" "$ROUNDS" 10 1.0; then
  ok "reconnect stays within budget on its pinned IP"
else
  bad "reconnect is too slow, or lost the pinned IP — see the check-net output above"
fi

# 6. obsidian-cli output formats. The runtime DOES guard these (cli-parse.ts refuses to guess),
#    but only reactively: you find out mid-soak, one burned `-UNKNOWN` rep at a time. Since a
#    format change is the likeliest breakage right after an Obsidian upgrade — i.e. right when
#    this script gets run — check it up front. Needs live nodes, so it goes last; with them down
#    it FAILS rather than skipping (see the header: an unanswered check must never read as PASS).
say "obsidian-cli output still parses (nodes: $NODES)"
npm run --silent check-cli -- --nodes "$NODES"
case $? in
  0) ok "every command the harness depends on is still recognized" ;;
  3) bad "check-cli found no running node (did one go away mid-run?) — nothing was verified" ;;
  *) bad "obsidian-cli output drifted — see above; parsers in src/cli-parse.ts need updating" ;;
esac

# The deferred half of step 3: does the Obsidian actually running in a node self-report the version
# its image is tagged with? An image that drifted from its tag would mislabel every run's results.
# Needs a live node for the reason given in step 3, so it rides along here (`live` was resolved up
# front — the script would have stopped already if there were none).
reported=$("$CONTAINER_ENGINE" exec "$live" "$CLI" version 2>&1 | head -1)
case "$reported" in
  "$OBSIDIAN_VERSION"*) ok "$live runs Obsidian $reported — matches the pinned version" ;;
  *) bad "$live is built from $IMAGE:$OBSIDIAN_VERSION but its Obsidian self-reports: $reported"
     note "the image drifted from its tag, or the node predates a version change — 'make containers-up' rebuilds" ;;
esac

echo
if [ "$fails" -eq 0 ]; then
  echo "check-assumptions: PASS — the apparatus still matches what the project assumes about it."
  exit 0
fi
echo "check-assumptions: FAIL ($fails check(s)) — fix these before trusting new runs; results" >&2
echo "  produced against a violated assumption look plausible and mean something else." >&2
exit 1
