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
# to be run rarely and to be thorough; most of its wall-clock is real waiting — check-net's 10s
# outages, step 10's full partition/heal round trip, and step 11's three real reps of the harness.
#
# WHAT IT DOES *NOT* COVER, on purpose: anything the runtime already checks per-run. Node
# reachability, every node `synced`, nodes agreeing on note count (run.ts's preflight), and the
# local vault not drifting mid-run are all DYNAMIC — they have to be true now, per run, and are
# verified there. Duplicating them here would rot. What lives here is the slow-changing stuff,
# plus one case (step 7) that the runtime only ever discovers reactively, mid-soak, and one
# (steps 10 and 11) the runtime cannot discover at all because their failure mode is a passing run.
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
# The same mediated npm the Makefile builds and exports, so a step run from `make` and the same
# step run by hand use the identical Node. Detected here too rather than only inherited, because
# this script is meant to be runnable standalone (see Usage above) and a bare `npm` there would
# quietly be a different interpreter than the one `make check-assumptions` just used.
NPM="${NPM:-$(command -v fnm >/dev/null 2>&1 && echo "fnm exec -- npm" || echo npm)}"
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
# say <description> [command...] — the step header, then the command(s) it is about to run, so a
# FAIL below can be re-run by hand without first reading this script to work out what it did. The
# commands are written out at each call site rather than derived, which means they can drift from
# what actually runs; they are worth more than nothing and less than the code, so anything printed
# here must stay copy-pasteable.
say()  {
  step=$((step + 1))
  printf '\n[%d/13] %s\n' "$step" "$1"
  shift
  for _c in "$@"; do printf '        $ %s\n' "$_c"; done
  return 0
}
ok()   { printf '      ok   %s\n' "$1"; }
bad()  { printf '      FAIL %s\n' "$1" >&2; fails=$((fails + 1)); }
note() { printf '      --   %s\n' "$1"; }

echo "check-assumptions: engine=$CONTAINER_ENGINE image=$IMAGE:$OBSIDIAN_VERSION network=$NET nodes=$NODES"

# 1. The engine itself. Everything below is meaningless if this isn't answering, and "which engine
#    and which version" is precisely the thing that changes under you between sessions.
say "container engine responds" "$CONTAINER_ENGINE --version"
if ver=$("$CONTAINER_ENGINE" --version 2>&1); then
  ok "$ver"
else
  bad "'$CONTAINER_ENGINE --version' failed: $ver"
  echo >&2
  echo "check-assumptions: cannot continue without a working engine." >&2
  exit 1
fi

# 2. The OTHER interpreter everything here rests on. The engine runs the nodes; Node runs the
#    harness — every `$NPM run` step below goes through it — so it belongs beside step 1 rather
#    than at the end, and it costs milliseconds.
#
#    This is the Obsidian version check (step 13) applied to the other pinned thing. `obsidian-version`
#    has always been declared in a file, enforced by the Makefile (IMAGE_TAG) and verified here;
#    `.nvmrc` was declared and nothing else, which is exactly why a harness running on a Node nobody
#    chose was invisible for so long. Asked through $NPM rather than by running `node` directly,
#    because what matters is the interpreter the HARNESS will get, not the one this shell has.
#
#    THE MISMATCH IS NOT AUTOMATICALLY A FAILURE, and that distinction is the whole point:
#      - below `engines` (>=22)  a hard fail. package.json says the code needs it; nothing excuses
#                                running under it, and no version manager is required to notice.
#      - off .nvmrc, no fnm      an advisory. fnm is OPTIONAL here (README lists it so), so an
#                                unenforced pin is a documented state, not a broken one. Said out
#                                loud every time so it is never silent.
#      - off .nvmrc WITH fnm     a fail. Enforcement was available and did not hold, which means
#                                something is wrong with it rather than merely absent.
say "the harness runs on the Node .nvmrc pins" "$NPM exec -- node -v" "cat .nvmrc"
# Leading `v` stripped, because `.nvmrc` may legally carry one and `node -v` always does. Comparing
# the two raw forms made `v26.9.0` — a perfectly ordinary way to write this file — read as a
# mismatch against the 26.9.0 fnm correctly ran.
node_want=$(tr -d '[:space:]' < "$here/../.nvmrc" 2>/dev/null | sed 's/^v//')
node_have=$($NPM exec -- node -v 2>/dev/null | tr -d '[:space:]' | sed 's/^v//')
node_major=${node_have%%.*}
# Did mediation actually engage? Read off $NPM itself, which the Makefile built (or this script
# fell back to). This is the question that matters below — "is fnm installed" is not, because an
# fnm nobody is using has no bearing on which interpreter the harness gets.
case "$NPM" in *"fnm exec"*) node_mediated=yes ;; *) node_mediated="" ;; esac
if [ -z "$node_have" ]; then
  bad "could not ask node for its version through '$NPM' — the harness may not run at all"
elif [ -n "$node_major" ] && [ "$node_major" -lt 22 ] 2>/dev/null; then
  bad "node $node_have is below package.json's engines (>=22) — the harness is not supported here"
elif [ -z "$node_want" ]; then
  note "node $node_have; no .nvmrc to compare it against"
elif [ "$node_want" = "$node_have" ] || [ "${node_have#"$node_want".}" != "$node_have" ]; then
  # Exact, or `.nvmrc` naming a PREFIX of it: `26` and `26.9` are both legal ways to pin, and fnm
  # resolves them to a full version the same way nvm does. Demanding an exact string would fail
  # every repo that pins loosely on purpose, while saying nothing about the apparatus.
  ok "node $node_have satisfies .nvmrc's $node_want"
elif [ -n "$node_mediated" ]; then
  # Mediation RAN and still produced a version .nvmrc does not name. A narrow branch on purpose,
  # and worth being honest about how narrow: fnm has no reason to disobey the file it just read, so
  # this is not "fnm is broken".
  #
  # What it catches is fnm and this check reading DIFFERENT FILES. fnm resolves from the CURRENT
  # directory; this check reads `$here/../.nvmrc`, the repo's. Invoke make from a directory carrying
  # its own `.nvmrc` (`make -f /path/to/repo/Makefile` rather than `make -C /path/to/repo`) and the
  # harness is pinned by one file while the repo declares another, with nothing else to say so.
  #
  # NOT the `.node-version` case, though it looks like it should be: with both files present and
  # disagreeing, fnm used `.nvmrc` and this check agreed with it. Measured, not assumed — the
  # earlier version of this comment claimed the opposite.
  bad "node $node_have through '$NPM', but .nvmrc names $node_want — they disagree, so fnm resolved a different file; is make running outside the repo?"
else
  # Nothing mediated, so the pin is simply unenforced — the documented optional state. Note that
  # this branch does NOT ask whether fnm is installed: the apparatus is identical either way, and a
  # script that answers "is the apparatus what this project thinks it is?" must not return a
  # different verdict because of a tool that is sitting unused on PATH. Having fnm changes only the
  # HINT below, never the verdict.
  note "node $node_have, .nvmrc pins $node_want — nothing enforced it here (fnm is optional)"
  if command -v fnm >/dev/null 2>&1; then
    note "  fnm is installed but could not serve the pin — one command fixes it: fnm install"
  else
    note "  to make the pin hold for every caller: brew install fnm && fnm install"
  fi
  note "  every npm step below therefore runs on $node_have, not the version this project declares"
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

# And is Sync actually RUNNING on them? A fresh container boots paused, and nothing in
# `containers-up` changes that. Paused, this script does not fail — it answers. Step 7's blocking
# claims, step 9's write path, step 10's divergence and step 11's race all read differently against a
# node whose Sync was never started, and the verdict at the end would say the apparatus is sound.
#
# A STOP rather than a `sync on`: resuming here would make the script the thing that set the world
# up, and a `paused` nobody noticed would go on being unnoticed everywhere else.
#
# Only positively-reported off-states count. A node that does not answer is not a paused node, and
# is step 7's business, not this one's.
paused=""
for n in $(echo "$NODES" | tr ',' ' '); do
  st=$("$CONTAINER_ENGINE" exec "$n" "$CLI" sync:status 2>/dev/null | sed -n 's/^status:[[:space:]]*//p' | head -1)
  case "$st" in paused|error|stopped|offline) paused="$paused $n($st)" ;; esac
done
if [ -n "$paused" ]; then
  echo >&2
  echo "check-assumptions: STOP — Sync is not running on:$paused" >&2
  echo "  A fresh container boots paused; these checks would answer without Sync ever taking part." >&2
  echo >&2
  echo "  Run:  make unpause-sync && make check-assumptions" >&2
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
say "test container network is as expected" "$CONTAINER_ENGINE network inspect $NET"

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
# hand. The probe address is check-net.sh's own, so step 6 can't fail for a reason step 3 missed.
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
#    a live node, and happens in step 7 with the rest of the live-node checks.
say "node image $IMAGE:$OBSIDIAN_VERSION is present and ships the CLI" \
    "$CONTAINER_ENGINE image inspect $IMAGE:$OBSIDIAN_VERSION" \
    "$CONTAINER_ENGINE run --rm --entrypoint /bin/sh $IMAGE:$OBSIDIAN_VERSION -c 'test -x $CLI && echo present'"
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
say "pinned Obsidian vs upstream (advisory)" \
    "curl -fsSL https://raw.githubusercontent.com/obsidianmd/obsidian-releases/master/desktop-releases.json"
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
say "a D/C reconnect is still a brief blip (check-net, $ROUNDS rounds x 10s outage)" \
    "ROUNDS=$ROUNDS $here/check-net.sh $ROUNDS 10 1.0"
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
say "obsidian-cli output still parses (nodes: $NODES)" \
    "$NPM run check-cli -- --nodes $NODES"
$NPM run --silent check-cli -- --nodes "$NODES"
case $? in
  0) ok "every command the harness depends on is still recognized" ;;
  3) bad "check-cli found no running node (did one go away mid-run?) — nothing was verified" ;;
  *) bad "obsidian-cli output drifted — see above; parsers in src/cli-parse.ts need updating" ;;
esac

# 7. Two claims the settle loop is BUILT on, both of them OURS — written into driver.ts from
#    observation at some past moment, never from Obsidian documentation, and therefore liable to
#    expire silently under an upgrade. `syncStateProbe`'s whole design assumes `sync:status` blocks
#    until a node is synced; if it stopped blocking, a probe timeout would no longer mean "not
#    synced yet" and every settle would be reading noise. Per-attempt capping likewise assumes sync
#    reads can hang. Measured, not asserted: see docs/DESIGN.md.
say "sync:status / sync:history still block the way the settle assumes" \
    "$NPM run probe-sync-versions -- --check"
if $NPM run --silent probe-sync-versions -- --check; then
  ok "the bounded-probe design still rests on true behaviour"
else
  bad "sync CLI blocking behaviour changed — src/driver.ts's syncStateProbe may be reading noise"
fi

# 8. The write path's two load-bearing CLI behaviours. execute.ts appends FIRST and only creates
#    when the CLI positively says the note is missing, which rests on both of these being true:
#
#      - append to a missing note ERRORS ("not found"). If a future CLI made it auto-create instead,
#        the fallback would never fire, every creation would be logged `created: false`, and the
#        create-create conflict-genesis signal would quietly become worthless. Nothing would fail.
#      - create on an EXISTING note does not overwrite and does not error — it makes a numbered
#        sibling ("<note> 1.md"). That is why the order is append-then-create and not the reverse;
#        if this ever became an overwrite, guessing wrong would destroy data rather than litter.
#
#    Both measured against obsidian-cli 1.13.7 on 2026-09-06. Neither is documented by Obsidian, so
#    an upgrade can change either without warning — exactly the silent-wrong-experiment shape this
#    script exists to catch.
probe="bughunt/check-assumptions-write-$$"
say "the write path's create-vs-append CLI behaviour is unchanged" \
    "$CONTAINER_ENGINE exec $live $CLI append 'file=$probe' 'content=(x)'   # expect: not found" \
    "$CONTAINER_ENGINE exec $live $CLI create 'path=$probe.md' 'content=(second)'   # expect: original intact"
cli() { "$CONTAINER_ENGINE" exec "$live" "$CLI" "$@" 2>&1; }
cli delete "file=$probe" >/dev/null 2>&1 || true
cli delete "file=$probe 1" >/dev/null 2>&1 || true
if cli append "file=$probe" "content=(x)" | grep -q 'not found'; then
  ok "append to a missing note still errors, so the create fallback still fires"
else
  bad "append to a missing note NO LONGER errors — execute.ts would log every creation as created:false"
fi
cli create "path=$probe.md" "content=(original)" >/dev/null 2>&1 || true
cli create "path=$probe.md" "content=(second)" >/dev/null 2>&1 || true
if [ "$(cli read "file=$probe" | tr -d '\r\n')" = "(original)" ]; then
  ok "create on an existing note still leaves the original intact"
else
  bad "create on an existing note now CHANGES it — append-then-create is no longer the safe order"
fi
cli delete "file=$probe" >/dev/null 2>&1 || true
cli delete "file=$probe 1" >/dev/null 2>&1 || true

# 9. Conflict files are still what a real divergence produces — i.e. every node is still in
#    Sync's "create conflict file" mode.
#
#    That mode is set BY HAND, per node, through VNC (README's setup step). Nothing in the harness
#    reads it back, and a node brought up without it does not fail: Obsidian merges the divergent
#    copies instead. No tokens are lost, so the oracle — which deliberately gates on tokens, with
#    `conflictMeta` informational (oracle.ts) — returns ok. The soak stays green while testing
#    something other than what its history strings describe, and `conflictFileFound` in every
#    lost-token forensic quietly becomes meaningless. Exactly the silent-wrong-experiment shape.
#
#    A setting that cannot be read has to be provoked instead. In the project's own DSL what this
#    performs is exactly:
#
#        N1AaN2WDN1AaN2AaC
#
#    n1 creates note a; n2 waits until it has it; n2 goes offline; each side appends its own token
#    to the same note; n2 comes back. (Verified to normalize to itself, so that string is literally
#    the shape run here — reproduce it by hand with `make run HISTORY=N1AaN2WDN1AaN2AaC`.)
#
#    It is re-implemented in shell rather than shelled out to `make run` ON PURPOSE: using the
#    harness to check the apparatus the harness rests on is circular — a broken apparatus would
#    break the checker in the same breath, and the whole point of this script is to be the thing
#    that still tells the truth when the runtime has started lying. It also asserts on something
#    the oracle deliberately does NOT judge: conflict-file GENESIS, not token loss.
#
#    THE EVIDENCE RUNS ONE WAY ONLY, and the check is built around that. A conflict file cannot
#    appear in merge mode, so seeing one is conclusive and ends the check. Not seeing one is weak:
#    it is equally consistent with merge mode and with Obsidian dropping an edit outright — and a
#    dropped edit is the bug this project exists to find, i.e. the apparatus working, not failing.
#    So only the MERGE SIGNATURE (both tokens in one note, no conflict file) is treated as a
#    failure. Absence of both is reported as INCONCLUSIVE and does not fail the run: a soak
#    aborting because Sync lost data would be precisely backwards.
#
#    Hence up to 3 attempts, stopping at the first conflict file. Measured 20/20 conflict files on
#    the first attempt, 3-4s per attempt, the file appearing ~1s after the heal — so the retries are
#    nearly free, and the caps below are large multiples of observed timings rather than padding.
#    Note that 20/20 says loss is RARE here, not impossible: this provocation's divergence window is
#    only as wide as two back-to-back appends, far tighter than a real `D...C` history, and it will
#    widen on a slower or busier machine. That is exactly why absence must not fail.
cg_live=""
for n in $(echo "$NODES" | tr ',' ' '); do
  "$CONTAINER_ENGINE" exec "$n" true >/dev/null 2>&1 && cg_live="$cg_live $n"
done
set -- $cg_live
# The provocation itself, rather than a pointer at this script: no single command reproduces the
# step, and the sequence IS the experiment. Re-runnable by hand against any note name.
if [ "$#" -ge 2 ]; then
  # Printed resolved, not as the formula: a command nobody can paste is not worth a line. Same guard
  # cg_ip uses below, so a node whose name is not nN prints a placeholder instead of an arithmetic error.
  case "${2#n}" in ""|*[!0-9]*) cgB_ip="<its pinned ip>" ;; *) cgB_ip="10.89.0.$((100 + ${2#n}))" ;; esac
  say "a real divergence still produces a conflict file, not a merge" \
    "$CONTAINER_ENGINE exec $1 $CLI create 'path=<note>.md' 'content=(base)'   # then wait for it on $2" \
    "$CONTAINER_ENGINE network disconnect $NET $2" \
    "$CONTAINER_ENGINE exec $1 $CLI append 'file=<note>' 'content=(from-$1)'" \
    "$CONTAINER_ENGINE exec $2 $CLI append 'file=<note>' 'content=(from-$2)'" \
    "$CONTAINER_ENGINE network connect --ip $cgB_ip $NET $2" \
    "$CONTAINER_ENGINE exec $2 $CLI files 'folder=bughunt'   # expect: a (Conflicted copy ...) sibling"
else
  say "a real divergence still produces a conflict file, not a merge"
fi
if [ "$#" -lt 2 ]; then
  note "SKIPPED — needs two live nodes, found $#; a PASS below does NOT cover conflict-file mode"
else
  cgA=$1; cgB=$2
  cli_on() { _n=$1; shift; "$CONTAINER_ENGINE" exec "$_n" "$CLI" "$@" 2>&1; }
  # Mirrors nodeIp() in src/isolate.ts. A reconnect MUST restore the same address or the partition
  # stops being a link blip and becomes a network reset — see docs/DESIGN.md, "Network identity".
  cg_ip() { case "${1#n}" in ""|*[!0-9]*) echo "" ;; *) echo "10.89.0.$((100 + ${1#n}))" ;; esac; }
  cg_reachable() { "$CONTAINER_ENGINE" exec "$1" timeout 2 bash -c 'echo > /dev/tcp/8.8.8.8/53' >/dev/null 2>&1; }
  cg_wait_reach() { # node want(0|1) capSeconds — same probe isolate.ts's waitReach uses
    _n=$1; _want=$2; _cap=$3; _i=0
    while [ "$_i" -lt "$_cap" ]; do
      if cg_reachable "$_n"; then _got=1; else _got=0; fi
      [ "$_got" = "$_want" ] && return 0
      _i=$((_i + 1)); sleep 1
    done
    return 1
  }
  cg_conflicts() { cli_on "$1" files "folder=bughunt" 2>/dev/null | grep -F "$cgbase (Conflicted copy" || true; }
  # The node must not be left partitioned if this script dies mid-check: that would break every
  # later run on this machine, and the failure would look like Sync's fault, not ours.
  cg_restore() { [ -n "$(cg_ip "$cgB")" ] && "$CONTAINER_ENGINE" network connect --ip "$(cg_ip "$cgB")" "$NET" "$cgB" >/dev/null 2>&1 || true; }

  # One provocation. Echoes exactly one word, plus detail: CONFLICT | MERGED | NEITHER | ERR.
  # Timings are set from measurement, not padding: the base note reaches the peer in ~1-2s and the
  # conflict file appears ~1s after the heal (20/20 observed), so these caps are large multiples of
  # the real thing, not guesses.
  # NOTE: called via `$(cg_attempt)`, i.e. in a command-substitution SUBSHELL, so anything it
  # assigns is invisible to the caller. `cgnote`/`cgbase` are therefore set by the LOOP below, not
  # here — set here, cleanup silently matched nothing and left files behind every run.
  cg_attempt() {
    cli_on "$cgA" delete "file=$cgnote" >/dev/null 2>&1 || true
    cli_on "$cgA" create "path=$cgnote.md" "content=(base)" >/dev/null 2>&1 || true
    # The note must EXIST on B before the partition. Append to a missing note errors (step 9), so
    # without this both sides would take the create-create path — a different genesis entirely.
    _i=0
    while [ "$_i" -lt 30 ]; do
      case "$(cli_on "$cgB" read "file=$cgnote")" in *"(base)"*) break ;; esac
      _i=$((_i + 1)); sleep 1
    done
    [ "$_i" -ge 30 ] && { echo "ERR the probe note never reached $cgB in 30s"; return; }

    "$CONTAINER_ENGINE" network disconnect "$NET" "$cgB" >/dev/null 2>&1 || true
    cg_wait_reach "$cgB" 0 30 || { cg_restore; echo "ERR $cgB stayed reachable after 'network disconnect'"; return; }
    cli_on "$cgA" append "file=$cgnote" "content=(from-$cgA)" >/dev/null 2>&1 || true
    cli_on "$cgB" append "file=$cgnote" "content=(from-$cgB)" >/dev/null 2>&1 || true
    cg_restore
    cg_wait_reach "$cgB" 1 30 || { echo "ERR $cgB did not become reachable again after reconnect"; return; }

    _i=0
    while [ "$_i" -lt 45 ]; do
      _f="$(cg_conflicts "$cgA")$(cg_conflicts "$cgB")"
      [ -n "$_f" ] && { echo "CONFLICT $(cg_conflicts "$cgA" | head -1)"; return; }
      _i=$((_i + 1)); sleep 1
    done
    _seen=$(cli_on "$cgA" read "file=$cgnote" | tr -d '\r' | tr '\n' ' ')
    case "$_seen" in
      *"(from-$cgA)"*) case "$_seen" in *"(from-$cgB)"*) echo "MERGED $_seen"; return ;; esac ;;
    esac
    echo "NEITHER $_seen"
  }

  cg_tidy() {
    { cg_conflicts "$cgA"; cg_conflicts "$cgB"; } | sort -u | while IFS= read -r f; do
      [ -n "$f" ] || continue
      f=${f#bughunt/}
      cli_on "$cgA" delete "file=bughunt/${f%.md}" >/dev/null 2>&1 || true
    done
    cli_on "$cgA" delete "file=$cgnote" >/dev/null 2>&1 || true
  }

  cgnote=""; cgbase="check-assumptions-conflict-$$"
  trap 'cg_restore' EXIT INT TERM
  if [ -z "$(cg_ip "$cgB")" ]; then
    bad "cannot derive a pinned IP for $cgB — refusing to partition a node we cannot reconnect"
  else
    cg_seen_merge=""; cg_seen_conflict=""; cg_last=""; cg_try=1
    while [ "$cg_try" -le 3 ]; do
      cgnote="bughunt/check-assumptions-conflict-$$-$cg_try"
      cgbase="check-assumptions-conflict-$$-$cg_try"
      cg_res=$(cg_attempt)
      cg_tidy
      cg_last="$cg_res"
      case "$cg_res" in
        CONFLICT*) cg_seen_conflict=1; break ;;
        MERGED*)   cg_seen_merge=1; break ;;
      esac
      cg_try=$((cg_try + 1))
    done
    if [ -n "$cg_seen_conflict" ]; then
      ok "divergence produced a conflict file (attempt $cg_try/3): ${cg_last#CONFLICT }"
    elif [ -n "$cg_seen_merge" ]; then
      bad "both edits MERGED into one note and no conflict file appeared"
      note "a node is NOT in \"create conflict file\" mode. Runs will still pass — a merge loses no"
      note "tokens — but conflictFileFound is meaningless and every history is testing a different"
      note "experiment than it describes."
      note "Fix: VNC into each node, set Sync's conflict handling to create conflict files."
      note "saw: ${cg_last#MERGED }"
    else
      note "INCONCLUSIVE after 3 attempts — no conflict file, but no merge signature either."
      note "last: $cg_last"
      note "This is NOT reported as a failure. The absence of a conflict file is weak evidence: it"
      note "is equally consistent with merge mode and with Obsidian dropping an edit outright, and"
      note "the latter is the bug this project hunts — a finding for the harness, not an apparatus"
      note "fault. Only the merge signature above is conclusive, and it did not appear."
      note "Follow up with:  make run HISTORY=N1AaN2WDN1AaN2AaC"
    fi
  fi
  trap - EXIT INT TERM
  cg_restore
fi

# 10. `N1AaN2Aa` still conflicts, with no partition to force it — in 2 reps of 4.
#
#    Step 9 forces a divergence and asks whether Sync still conflicts it. This asks the other half:
#    does the canonical race still race? `N1AaN2Aa` is two appends to a note that does not exist
#    yet, back to back on two nodes. It diverges only while both writes land before either node's
#    note reaches the other, so anything the harness does between the two appends can suppress it —
#    a pre-write `sync:history` read did exactly that on 2026-09-07, and nothing failed.
#
#    The ASSERTION is the conflict file, in 2 REPS OF 4 — not in every rep. Measured over a 90-rep
#    soak (2026-09-18, Obsidian 1.13.7): 84 conflicted, 3 lost a token, 3 merged. At 93% per rep,
#    demanding 3 of 3 fails about one run in five, and that is what this step was doing before the
#    rate was known: flapping between PASS and FAIL with nothing wrong. 2-of-4 fails 0.1% of the
#    time at that rate, 5% if the rate falls to 75%, 31% if it halves. Coarse on purpose — a change
#    finer than that is a soak's question, not a four-rep one.
#
#    `created` on the two appends is the discriminator for WHY a rep did not conflict, never the
#    assertion: it was [true, true] in 90 of 90, so the race itself is not the variable.
#
#    The gap is reported, never asserted on, and the soak says what it decides:
#
#      gap        <130ms   130-400ms   >400ms
#      outcome    2 of 5 LOST    conflict    merge (3 of 3)
#
#    The two narrowest gaps in 90 reps (120ms, 122ms) both lost, so loss concentrates where the race
#    is tightest rather than falling at random — and every loss so far was `inServer: true`, meaning
#    the token is in the server's version history but in no node's note and no conflict copy. A user
#    would see no conflict file and never know. The merges are entirely a wide-gap effect, which
#    retires the "unexplained create-create merge" question DESIGN used to carry.
# Whether the checks above passed, read before this step adds to the count. Only used to say so in
# the loss message — a reader deciding whether to trust this result wants to know.
pre10_fails=$fails
race_clean=0
race_dir="./check-assumptions-runs/step10-$(date -u +%Y%m%dT%H%M%SZ)"
say "N1AaN2Aa still conflicts: 2+ of 4 reps (no partition, timing only)" \
    "$NPM run start -- --history N1AaN2Aa --repeat 4 --runs-dir ${race_dir#./} --display off"
rm -rf "$race_dir"
# Not runs/: corpus.ts parses a run directory as `<ts>-<history>` and analyze.ts groups by the
# directory name, so a telltale name there would enter the corpus tables as a bogus history.
#
# The exit status is ignored on purpose. `npm run start` exits non-zero on any FAIL verdict,
# including a rep that found a real loss, which is the case this step most wants to read rather
# than dismiss. Whether the run happened is decided by whether it left rep logs.
#
# `cd` because this script runs from any directory but `npm run` does not.
(cd "$here/.." && $NPM run --silent start -- --history N1AaN2Aa --repeat 4 \
   --runs-dir "$here/../${race_dir#./}" --display off) >/dev/null 2>&1 || true
race_dir="$here/../${race_dir#./}"
if [ -z "$(find "$race_dir" -name '*.jsonl' 2>/dev/null | head -1)" ]; then
  bad "N1AaN2Aa produced no rep logs at all — the harness itself is broken, not just slow"
else
  race_out=$(python3 - "$race_dir" <<'PY'
import json, sys, pathlib
# FOUR reps, and two conflict files are a pass.
#
# The conflict file is not certain per rep, and gating on "every rep" was gating on a coin that
# lands heads 93 times in 100. Measured over a 90-rep soak, 2026-09-18: 84 conflict, 3 lost, 3
# merged. At that rate "3 of 3" fails about one run in five, which is exactly the flapping this
# step was doing — no change in Obsidian required to produce it.
#
# 2-of-4 costs almost nothing in false alarms and still catches a collapse:
#
#   conflict rate   93%    85%    75%    60%    50%    25%
#   this step fails 0.1%   1.2%   5.1%  17.9%  31.3%  73.8%
#
# So it is a coarse gate on purpose: it will not notice the rate halving, and it will not cry wolf.
# A rate that needs detecting more finely than that needs a soak, not three more reps.
#
# LOSS is still printed on every rep that shows it, pass or fail. It is the thing this project
# hunts, and a passing gate must not swallow it.
conflicts = 0
reps = 0
bad = 0
for f in sorted(pathlib.Path(sys.argv[1]).glob("*/*.jsonl")):
    ev = [json.loads(l) for l in f.open()]
    ap = [e for e in ev if e.get("kind") == "appended"]
    res = [e for e in ev if e.get("kind") == "results"]
    if len(ap) != 2 or not res:
        print("REP %s: %d appends, %d verdicts — expected 2 and 1" % (f.stem, len(ap), len(res)))
        bad += 1; continue
    gap = round((ap[1]["t"] - ap[0]["t"]) * 1000)
    created = [e["created"] for e in ap]
    v = res[0]["verdict"]["notes"][0]
    reps += 1
    if v.get("conflictFiles", 0) >= 1:
        conflicts += 1
        print("ok  %s: gap=%dms conflict file" % (f.stem, gap))
    elif not all(created):
        print("SLOW %s: gap=%dms created=%s — n1's note reached n2 first, so n2 appended to it"
              " instead of creating its own. No divergence, so nothing to conflict." % (f.stem, gap, created))
    elif v.get("lost"):
        print("LOSS %s: gap=%dms both nodes created, no conflict file, and %s is in neither the note"
              " nor any conflict copy on either node" % (f.stem, gap, ", ".join(v["lost"])))
    else:
        print("MERGE %s: gap=%dms both nodes created and the two edits MERGED into one note with no"
              " conflict file — see step 10. Measured: every merge in a 90-rep soak had a gap above"
              " 400ms, so a merge at a NARROW gap is the surprising one" % (f.stem, gap))
print("%d of %d reps produced a conflict file (2 needed)" % (conflicts, reps))
# `bad` is only ever a rep that could not be READ. An outcome is never itself a failure here; the
# count decides.
sys.exit(1 if (bad or conflicts < 2) else 0)
PY
  )
  race_rc=$?
  echo "$race_out" | while IFS= read -r l; do note "$l"; done
  if [ "$race_rc" -eq 0 ]; then
    ok "the race still conflicts at the rate it should"
    race_clean=1
  else
    bad "N1AaN2Aa produced fewer than 2 conflict files in 4 reps"
    note "rep logs kept: $race_dir"
    case "$race_out" in
      *"SLOW "*)
        note "SLOW: something is taking longer between the two appends. Either the harness gained"
        note "  work there — anything reading the CLI on the write path has to ride in the write"
        note "  batch or not happen — or the round trip itself got slower, which is not ours to fix."
        note "  The gaps above say which: the write path is two round trips on the second node."
        note "    make bench-cli              what one exec costs now, against an empty one"
        note "    make probe-propagation      what a create's trip costs now"
        note "    make repro HISTORY=N1AaN2Aa && sh runs/repro-*.sh" ;;
    esac
    case "$race_out" in
      *"LOSS "*)
        note "LOSS: this may be an actual bug in Obsidian rather than an apparatus fault. Worth"
        note "  running down:"
        note "    make repro HISTORY=N1AaN2Aa && sh runs/repro-*.sh   standalone reproduction"
        note "    make soak HISTORY=N1AaN2Aa                          establish a rate"
        note "    make analyze"
        if [ "$pre10_fails" -eq 0 ]; then
          note "  Checks 1-9 passed."
        else
          note "  NOTE: $pre10_fails earlier check(s) failed — fix those before reading this as a finding."
        fi ;;
    esac
    case "$race_out" in
      *"MERGE "*)
        note "MERGE: two independent creates became one note with both tokens. Step 9 is the check"
        note "  for Sync's conflict-file mode; if it passed, this is unexplained and worth a look." ;;
    esac
  fi
  # Leave the vault as we found it. Driven off the LISTING rather than the log's conflict-file
  # events, which are not a complete inventory. Deleted on one node; the deletion propagates.
  #
  # BEFORE the logs are discarded, not after: the note names come out of those logs, so deleting
  # them first left this loop with nothing to iterate and the reps' notes in the vault — on the
  # PASSING path only, which is the one nobody looks at.
  race_notes=$(python3 - "$race_dir" <<'PY'
import json, sys, pathlib
out = set()
for p in pathlib.Path(sys.argv[1]).glob("*/*.jsonl"):
    for line in p.open():
        e = json.loads(line)
        if e.get("kind") == "appended" and e.get("fullname"): out.add(e["fullname"])
print("\n".join(sorted(out)))
PY
  )
  for rn in $race_notes; do
    "$CONTAINER_ENGINE" exec "$live" "$CLI" files folder=bughunt 2>/dev/null \
      | grep -F "$rn" | while IFS= read -r f; do
        f=$(printf '%s' "$f" | tr -d '\r')
        [ -n "$f" ] || continue
        "$CONTAINER_ENGINE" exec "$live" "$CLI" delete "file=${f%.md}" >/dev/null 2>&1 || true
      done
  done
  [ "${race_clean:-0}" = 1 ] && rm -rf "$race_dir"
fi

# 11. Advisory: how fast a change actually reaches the other node. NOT a showstopper check — these
#    numbers can move without anything being broken — but they shape how every timing result here
#    is read, and how patient a `W<n>` has to be, so a silent shift is exactly the kind of thing
#    that leaves old conclusions standing on a floor that moved. It prints its own verdict; the exit
#    code is reserved for a change that never arrived at all, which is breakage rather than drift.
say "sync propagation is still as fast as recorded (advisory)" \
    "$NPM run probe-propagation"
if $NPM run --silent probe-propagation; then
  :
else
  bad "a change never arrived at the peer at all — that is not drift, something is broken"
fi

# 12. Advisory: are the two call arrangements the harness actually uses still among the fast ones?
#
#    The sampler issues its four calls unbatched + parallel; the write path, whose calls each depend
#    on the last, goes batched + sequential. Those were the arguably best arrangements measured
#    against the Obsidian and container engine of the day — measurements of one environment, not
#    properties of Obsidian, and an engine that changed what an exec costs would move them.
#
#    Advisory, like step 12: a slower cell does not invalidate a result, it means a design choice
#    has gone stale. The exit code is reserved for the benchmark failing to answer at all, which is
#    breakage — a composed row that no longer runs, or a row label renamed out from under the check.
#
#    Reduced sample count (BENCH_CHECK's own default) because the question is "is this cell still
#    fast", not "how fast". `make bench-cli` is the full table.
say "the call arrangements the design uses are still among the fast ones (advisory)" \
    "BENCH_CHECK=1 bash $here/bench-cli.sh $live"
BENCH_CHECK=1 bash "$here/bench-cli.sh" "$live"
case $? in
  0) ok "both arrangements the design uses are still among the fast ones" ;;
  3) note "see above: an arrangement the design uses is no longer among the fast ones" ;;
  *) bad "bench-cli could not answer — a command it depends on broke, or a row it checks was renamed" ;;
esac

# The deferred half of step 4: does the Obsidian actually running in a node self-report the version
# its image is tagged with? An image that drifted from its tag would mislabel every run's results.
# Needs a live node for the reason given in step 4, so it rides along here (`live` was resolved up
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
