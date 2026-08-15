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
# to be run rarely and to be thorough; most of its wall-clock is net-check's real 10s outages.
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
# Exits 0 if every hard check passed (skips and advisories don't fail the run), 1 otherwise.
set -u

ENGINE="${ENGINE:-${CONTAINER_ENGINE:-$(command -v podman >/dev/null 2>&1 && echo podman || echo docker)}}"
NET="${NET:-obsidian-net}"
SUBNET="${SUBNET:-10.89.0.0/24}"
IMAGE="${IMAGE:-obsidian-node}"
OBSIDIAN_VERSION="${OBSIDIAN_VERSION:?OBSIDIAN_VERSION must be set (make passes it)}"
NODES="${NODES:-n1,n2}"
ROUNDS="${ROUNDS:-3}"
CLI=/opt/obsidian/obsidian-cli
here="$(cd "$(dirname "$0")" && pwd)"

fails=0
step=0
say()  { step=$((step + 1)); printf '\n[%d/6] %s\n' "$step" "$1"; }
ok()   { printf '      ok   %s\n' "$1"; }
bad()  { printf '      FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }
note() { printf '      --   %s\n' "$1"; }

echo "check-assumptions: engine=$ENGINE image=$IMAGE:$OBSIDIAN_VERSION network=$NET nodes=$NODES"

# 1. The engine itself. Everything below is meaningless if this isn't answering, and "which engine
#    and which version" is precisely the thing that changes under you between sessions.
say "container engine responds"
if ver=$("$ENGINE" --version 2>&1); then
  ok "$ver"
else
  bad "'$ENGINE --version' failed: $ver"
  echo >&2
  echo "check-assumptions: cannot continue without a working engine." >&2
  exit 1
fi

# 2. The test network's subnet. The per-node pinned IPs (10.89.0.<100+n>) live in it; if the
#    network was created without an explicit subnet by an older Makefile, or by hand, every
#    `--ip 10.89.0.x` fails with an obscure engine error instead of saying this.
say "test network carries $SUBNET"
if ! "$ENGINE" network inspect "$NET" >/dev/null 2>&1; then
  bad "network '$NET' does not exist — run 'make net'"
elif "$ENGINE" network inspect "$NET" 2>/dev/null | grep -q "$SUBNET"; then
  ok "$NET has $SUBNET"
else
  bad "network '$NET' exists but lacks $SUBNET — the pinned node IPs can't be assigned."
  note "fix: make containers-down && $ENGINE network rm $NET && make net"
fi

# 3. The image for the pinned version exists and still ships obsidian-cli — not a documented API,
#    so it could quietly stop being in the portable tarball.
#
#    Only its PRESENCE can be checked here. obsidian-cli is an IPC client to a running Obsidian,
#    not a standalone binary, so `obsidian-cli version` in a bare container answers "The CLI is
#    unable to find Obsidian" — there is no headless mode. The version comparison therefore needs
#    a live node, and happens in step 6 with the rest of the live-node checks.
say "node image $IMAGE:$OBSIDIAN_VERSION is present and ships the CLI"
if ! "$ENGINE" image inspect "$IMAGE:$OBSIDIAN_VERSION" >/dev/null 2>&1; then
  bad "no such image — run 'make build' (or 'make images' to see what is built)"
else
  ok "image present"
  if out=$("$ENGINE" run --rm --entrypoint /bin/sh "$IMAGE:$OBSIDIAN_VERSION" -c "test -x $CLI && echo present" 2>&1); then
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
say "a D/C reconnect is still a brief blip (net-check, $ROUNDS rounds x 10s outage)"
if ROUNDS="$ROUNDS" "$here/net-check.sh" "$ROUNDS" 10 1.0; then
  ok "reconnect stays within budget on its pinned IP"
else
  bad "reconnect is too slow, or lost the pinned IP — see the net-check output above"
fi

# 6. obsidian-cli output formats. The runtime DOES guard these (cli-parse.ts refuses to guess),
#    but only reactively: you find out mid-soak, one burned `-UNKNOWN` rep at a time. Since a
#    format change is the likeliest breakage right after an Obsidian upgrade — i.e. right when
#    this script gets run — check it up front. Needs live nodes, so it goes last and SKIPS
#    (rather than fails) when they're down, keeping steps 1-5 usable before `make containers-up`.
say "obsidian-cli output still parses (nodes: $NODES)"
npm run --silent check-cli -- --nodes "$NODES"
case $? in
  0) ok "every command the harness depends on is still recognized" ;;
  3) note "nodes not running — skipped. Run 'make containers-up' to include this check." ;;
  *) bad "obsidian-cli output drifted — see above; parsers in src/cli-parse.ts need updating" ;;
esac

# The deferred half of step 3: does the Obsidian actually running in a node self-report the version
# its image is tagged with? An image that drifted from its tag would mislabel every run's results.
# Needs a live node for the reason given in step 3, so it rides along here.
live=""
for n in $(echo "$NODES" | tr ',' ' '); do
  if "$ENGINE" exec "$n" true >/dev/null 2>&1; then live="$n"; break; fi
done
if [ -z "$live" ]; then
  note "running Obsidian self-reports $OBSIDIAN_VERSION: skipped (no node running)"
else
  reported=$("$ENGINE" exec "$live" "$CLI" version 2>&1 | head -1)
  case "$reported" in
    "$OBSIDIAN_VERSION"*) ok "$live runs Obsidian $reported — matches the pinned version" ;;
    *) bad "$live is built from $IMAGE:$OBSIDIAN_VERSION but its Obsidian self-reports: $reported"
       note "the image drifted from its tag, or the node predates a version change — 'make containers-up' rebuilds" ;;
  esac
fi

echo
if [ "$fails" -eq 0 ]; then
  echo "check-assumptions: PASS — the apparatus still matches what the project assumes about it."
  exit 0
fi
echo "check-assumptions: FAIL ($fails check(s)) — fix these before trusting new runs; results" >&2
echo "  produced against a violated assumption look plausible and mean something else." >&2
exit 1
