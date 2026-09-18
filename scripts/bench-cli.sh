#!/usr/bin/env bash
# What does one obsidian-cli call cost, how much of that is the container, and would the filesystem
# be cheaper?
#
# Run:  make bench-cli            (or: bash scripts/bench-cli.sh n2)
#
# EVERY COMMAND IS VERIFIED BEFORE ANYTHING IS TIMED. A command that fails fails FAST, and a
# benchmark that discards output reports that as a good result. The exposure is concrete: `cat` with
# a wrong vault path returns in ~0ms and would publish "the filesystem beats the CLI" — the most
# interesting possible conclusion, and pure artefact. The preflight cross-checks `cat` against
# `cli read` and `ls` against `cli files`, because those two pairs are exactly what the FS-vs-CLI
# comparison rests on, and nothing else here would notice if they diverged.
#
# WHAT IS TIMED. Rows marked `(in container)` time the command INSIDE the node, so they measure what
# Obsidian costs. Every other row times from the HOST, around the whole `<engine> exec`, so it
# measures what the harness pays to ask. The gap between a pair is the transport, measured rather
# than inferred by subtracting an empty exec.
#
# NO GAP BETWEEN CALLS, and that is a choice. Measured: back-to-back `sync:status` runs at a median
# of 182ms, with a 0.2s gap 202ms, with a 1s gap 208ms. A pause makes calls SLOWER, not cleaner — it
# measures the cold path once the daemon and Obsidian's IPC have gone quiet. The harness issues its
# calls in bursts, so warm is the representative case. BENCH_GAP measures the cold one deliberately.
#
# METHODOLOGY, learned the hard way. Four earlier versions of this script were wrong:
#   1. A timer per call, shelling out to python3 — 26ms of process startup inside every sample.
#      It reported `read` at 84ms and `sync:status` at 301ms, both inflated.
#   2. Timing N calls together and dividing — diluted the timer but threw away the distribution, so
#      a lone stall vanished into a block average.
#   3. Two cells, one pass. A run at four commands said batched 371ms vs parallel 284ms; a code
#      change was made on it; a run at eight commands reversed it. Neither number was real.
#   4. Each row's samples run consecutively. That ties a row to a stretch of wall-clock time and
#      hands it whatever drifted then — it once reported 19% between two runs of ONE command.
# Hence: the shell's own `time` (a builtin, ~0-1ms), every call its own sample, all rows interleaved
# in a reshuffled order, and two identical control rows so the table states its own noise floor.
set -euo pipefail

NODE="${1:-${BENCH_NODE:-n2}}"
# BENCH_NODE  which node to measure against (default n2; also the script's first argument).
# BENCH_VAULT the vault's path INSIDE the node, for the `cat`/`ls` rows (default
#             /root/vaults/TestVault). Point it somewhere wrong to watch the preflight refuse.
# BENCH_N     samples per row. Both sections run every row once per round, so this multiplies.
# BENCH_GAP   seconds to sleep between calls (default 0). See above.
# BENCH_INTERLEAVED=0 runs each row's samples consecutively instead. That is the WRONG way to
#             measure; it is kept as an opt-out so the bias can be demonstrated rather than asserted.
#             Run it both ways and watch the controls' p90 span.
# BENCH_BIN_MS histogram bin width. Fixed, so a bar means the same latency in every run.
# BENCH_SHOW=1 print the exact command each row times, and run nothing.
# BENCH_CHECK=1 skip the single-command section, and end with one verdict line plus an exit code:
#             are the two arrangements the harness actually uses still among the fast ones?
#             Fewer samples by default, since the question is "is this cell still fast", not
#             "how fast" — check-assumptions runs it this way.
N="${BENCH_N:-$([ -n "${BENCH_CHECK:-}" ] && echo 5 || echo 10)}"
GAP="${BENCH_GAP:-0}"
INTERLEAVED="${BENCH_INTERLEAVED:-1}"
SHOW="${BENCH_SHOW:-}"
CHECK="${BENCH_CHECK:-}"
ENGINE="${CONTAINER_ENGINE:-$(command -v docker >/dev/null 2>&1 && echo docker || echo podman)}"
CLI=/opt/obsidian/obsidian-cli
VAULT="${BENCH_VAULT:-/root/vaults/TestVault}"
NOTE="bughunt/bench-$$"
TIMEFORMAT=%R

cli() { "$ENGINE" exec "$NODE" "$CLI" "$@"; }
cleanup() { cli delete "file=$NOTE" >/dev/null 2>&1 || true; cli delete "file=$NOTE 1" >/dev/null 2>&1 || true; }
trap cleanup EXIT

"$ENGINE" exec "$NODE" true >/dev/null 2>&1 || { echo "node '$NODE' is not up — make containers-up"; exit 2; }

# Two of the timed rows are `sync:status` and `sync:history`, and both are far cheaper on a node
# whose Sync is not running — so a paused node does not fail here, it just quietly reports the wrong
# cost for the two calls the harness makes most. A fresh container boots paused.
sync_state=$("$ENGINE" exec "$NODE" "$CLI" sync:status 2>/dev/null | sed -n 's/^status:[[:space:]]*//p' | head -1)
case "$sync_state" in
  paused|error|stopped|offline)
    echo "node '$NODE' has Sync $sync_state — these timings would not be the ones the harness pays."
    echo "  Resume it with 'make unpause-sync' and re-run."; exit 2 ;;
esac

# --- the commands ------------------------------------------------------------------------------
CLI_R="$CLI read file=$NOTE";      FS_R="cat $VAULT/$NOTE.md"
CLI_F="$CLI files folder=bughunt"; FS_F="ls -1 $VAULT/bughunt"
S1="$CLI sync:status"; S2="$CLI sync:history file=$NOTE total"

# Timed INSIDE the node. bash, not sh: /bin/sh is dash and has no `time` builtin.
inside() { printf '%s exec %s bash -c '"'"'TIMEFORMAT=%%R; t=$( { time { %s >/dev/null 2>&1; } ; } 2>&1 ); echo "$t"'"'"'' "$ENGINE" "$NODE" "$1"; }

# BENCH_SHOW prints CMDS verbatim — scaffolding and all. An earlier version tidied it into a
# readable summary, which made it inaccurate: the point of the flag is to show exactly what runs, and
# a prettified command cannot be checked against reality. The only thing not in the string is the
# outer wrapper `sample_cell` adds, and the header states that.
LABELS=(); CMDS=(); KIND=()
add()    { LABELS+=("$1"); CMDS+=("$2"); KIND+=("host"); }
add_in() { LABELS+=("$1"); CMDS+=("$(inside "$2")"); KIND+=("in"); }

add    "$ENGINE exec true"                 "\"$ENGINE\" exec $NODE true"
add    "cli read (existent)"               "\"$ENGINE\" exec $NODE $CLI_R"
add_in "  ↳ in container"                  "$CLI_R"
add    "fs  cat"                           "\"$ENGINE\" exec $NODE $FS_R"
add_in "  ↳ in container"                  "$FS_R"
add    "cli files"                         "\"$ENGINE\" exec $NODE $CLI_F"
add_in "  ↳ in container"                  "$CLI_F"
add    "fs  ls"                            "\"$ENGINE\" exec $NODE $FS_F"
add_in "  ↳ in container"                  "$FS_F"
add    "cli sync:status"                   "\"$ENGINE\" exec $NODE $S1"
add_in "  ↳ in container"                  "$S1"
add    "cli sync:history total"            "\"$ENGINE\" exec $NODE $S2"
add_in "  ↳ in container"                  "$S2"
SINGLES=${#LABELS[@]}

# NEGATIVE CONTROL, first in the matrix. Two rows running a command identical to each other and to
# `batched, sequential (cli)`, so the span between them is this run's noise floor: what the apparatus
# reports between things that are NOT different. Printed first so the reader calibrates before
# reading anything else, and shuffled in with the rest so they are measured under the same conditions
# they certify.
add "control A = batched,seq (cli)" "\"$ENGINE\" exec $NODE sh -c '$S1 >/dev/null; $CLI_F >/dev/null; $S2 >/dev/null; $CLI_R >/dev/null'"
add "control B = batched,seq (cli)" "\"$ENGINE\" exec $NODE sh -c '$S1 >/dev/null; $CLI_F >/dev/null; $S2 >/dev/null; $CLI_R >/dev/null'"
for src in cli fs; do
  if [ "$src" = cli ]; then R="$CLI_R"; F="$CLI_F"; else R="$FS_R"; F="$FS_F"; fi
  # EVERY cell discards output inside the container, not just the parallel ones. `files
  # folder=bughunt` returns ~100 lines, so cells without the inner redirect were shipping several KB
  # back through the docker pipe while the parallel cells wrote to /dev/null in place — a real cost
  # difference between the very cells being compared, and nothing to do with the transport under
  # test. The outer discard in `sample_cell` still catches anything that escapes.
  add "batched,   sequential  ($src)" "\"$ENGINE\" exec $NODE sh -c '$S1 >/dev/null; $F >/dev/null; $S2 >/dev/null; $R >/dev/null'"
  add "batched,   parallel    ($src)" "\"$ENGINE\" exec $NODE sh -c '$S1 >/dev/null & $F >/dev/null & $S2 >/dev/null & $R >/dev/null & wait'"
  add "unbatched, sequential  ($src)" "\"$ENGINE\" exec $NODE sh -c '$S1 >/dev/null'; \"$ENGINE\" exec $NODE sh -c '$F >/dev/null'; \"$ENGINE\" exec $NODE sh -c '$S2 >/dev/null'; \"$ENGINE\" exec $NODE sh -c '$R >/dev/null'"
  add "unbatched, parallel    ($src)" "(\"$ENGINE\" exec $NODE sh -c '$S1 >/dev/null' & \"$ENGINE\" exec $NODE sh -c '$F >/dev/null' & \"$ENGINE\" exec $NODE sh -c '$S2 >/dev/null' & \"$ENGINE\" exec $NODE sh -c '$R >/dev/null' & wait)"
done

# BENCH_SHOW exits HERE — before the seed note is created and before the preflight runs. An
# inspection flag that quietly writes to the vault and issues ten commands is not an inspection
# flag; it was doing both until this block moved above them.
if [ -n "$SHOW" ]; then
  echo
  echo "  Exactly what runs. A 'host' row is additionally wrapped by the caller as"
  echo "      { time { <the line below> >/dev/null 2>/dev/null; } ; } 2>&1"
  echo "  so the shell times the whole exec. An '↳ in container' row carries its own timing inside"
  echo "  the node and is run as-is; its output IS the measurement, so the caller does not wrap it."
  echo
  for i in $(seq 0 $(( ${#LABELS[@]} - 1 ))); do printf '  %-34s %s\n' "${LABELS[$i]}" "${CMDS[$i]}"; done
  exit 0
fi

cli create "path=$NOTE.md" "content=(bench-seed)" >/dev/null 2>&1 || true

# --- preflight: does any of this actually work? ------------------------------------------------
#
# Captures both the OUTPUT and the EXIT CODE of every command. The exit code matters because the two
# families fail differently: `cat`/`ls` return non-zero and write `cat: ...` on stderr, while
# obsidian-cli always exits 0 (see docs/cli-trust.md) and reports trouble only in its text. A first
# version of this gate tested only for a leading `Error:` and duly passed
# `cat: /nonexistent/... No such file or directory` as healthy — the exact failure it exists to
# catch. Every predicate is also guarded against `set -e`, which killed that version before it could
# report anything.
fail=0
check() { # name, expectation, output, result(0 = pass)
  local name="$1" want="$2" out="$3" ok="$4"
  local shown; shown=$(printf '%s' "$out" | head -1 | cut -c1-42)
  if [ "$ok" = "0" ]; then
    printf '  ok   %-26s %-30s %s\n' "$name" "$want" "$shown"
  else
    printf '  FAIL %-26s %-30s %s\n' "$name" "$want" "${shown:-<no output>}"
    fail=1
  fi
}
# Run a command, capturing output and exit code without tripping `set -e`.
#
# The `if` matters: a bare `OUT=$(failing-cmd)` is ITSELF a failing command, so under `set -e` the
# script dies on the assignment and never reaches the check that was supposed to report it. That is
# how the first two versions of this gate managed to abort silently while testing a broken path.
grab() {
  if OUT=$(eval "$1" 2>&1); then RC=0; else RC=$?; fi
  return 0
}

echo
echo "verifying every command before timing anything"
echo

grab "\"$ENGINE\" exec $NODE true"
ok=0; [ "$RC" = "0" ] || ok=1
check "$ENGINE exec true" "exit 0" "$OUT" "$ok"

grab "\"$ENGINE\" exec $NODE $CLI_R"; o_read="$OUT"
ok=0; { [ "$RC" = "0" ] && [ -n "$OUT" ] && ! printf '%s' "$OUT" | grep -q '^Error:'; } || ok=1
check "cli read" "exit 0, non-empty, no Error:" "$o_read" "$ok"

grab "\"$ENGINE\" exec $NODE $FS_R"; o_cat="$OUT"
ok=0; { [ "$RC" = "0" ] && [ -n "$OUT" ]; } || ok=1
check "fs  cat" "exit 0, non-empty" "$o_cat" "$ok"

ok=0; [ "$o_cat" = "$o_read" ] || ok=1
check "cat == read" "byte-identical to cli read" "$o_cat" "$ok"

grab "\"$ENGINE\" exec $NODE $CLI_F"; o_files="$OUT"
ok=0; { [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -q "$(basename "$NOTE").md"; } || ok=1
check "cli files" "lists the bench note" "$o_files" "$ok"

grab "\"$ENGINE\" exec $NODE $FS_F"; o_ls="$OUT"
n_ls=$(printf '%s\n' "$o_ls" | grep -c . || true)
n_files=$(printf '%s\n' "$o_files" | grep -c . || true)
ok=0; { [ "$RC" = "0" ] && [ "$n_ls" = "$n_files" ]; } || ok=1
check "ls count == files count" "cli files saw $n_files" "$o_ls" "$ok"

grab "\"$ENGINE\" exec $NODE $S1"; o_st="$OUT"
ok=0; { [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -q '^status: '; } || ok=1
check "cli sync:status" "^status: " "$o_st" "$ok"

grab "\"$ENGINE\" exec $NODE $S2"; o_h="$OUT"
ok=0; { [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qE '^[0-9]+$'; } || ok=1
check "cli sync:history total" "a bare integer" "$o_h" "$ok"

# `content=(x)` must be quoted: unquoted inside an eval it is a shell array literal and the whole
# command dies with a syntax error — which the first version of this check reported as `ok`, because
# a syntax error is neither empty nor prefixed `Error:`. Hence RC is now part of every check: the
# shell's own failures are as invalidating as the CLI's.
grab "\"$ENGINE\" exec $NODE $CLI append 'file=$NOTE' 'content=(bench-x)'"; o_app="$OUT"
ok=0; { [ "$RC" = "0" ] && [ -n "$OUT" ] && ! printf '%s' "$OUT" | grep -q '^Error:'; } || ok=1
check "cli append" "exit 0, non-empty, no Error:" "$o_app" "$ok"

grab "$(inside "$S1")"; o_in="$OUT"
ok=0; { [ "$RC" = "0" ] && printf '%s' "$OUT" | grep -qE '^[0-9]+\.[0-9]+$'; } || ok=1
check "in-container timing" "a bare float (seconds)" "$o_in" "$ok"

# The COMPOSED cells too, not only the commands they are made of. The checks above would pass a cell
# that fails to run at all: a quoting slip makes the whole line a shell syntax error, which exits
# non-zero in ~0ms and would sit in the table looking like the fastest transport. That is not
# hypothetical — an unquoted `content=(x)` did exactly this, and was reported as `ok`, until the
# check started looking at exit codes.
#
# Exit status is the right test here: these cells discard their output by design, and the CONTENT of
# each command they compose has already been checked above. What is left to catch is the composition.
echo
for i in $(seq 0 $(( ${#LABELS[@]} - 1 ))); do
  [ "${KIND[$i]}" = "in" ] && continue   # already covered by the in-container timing check
  if eval "${CMDS[$i]}" >/dev/null 2>&1; then :; else
    printf '  FAIL %-30s exits non-zero — the composed line does not run\n' "${LABELS[$i]}"
    fail=1
  fi
done
[ "$fail" = "0" ] && printf '  ok   %-26s %s\n' "all ${#LABELS[@]} composed rows" "run and exit 0"

if [ "$fail" != "0" ]; then
  echo
  echo "  A command did not do what this benchmark assumes. NOT timing anything: a failing command"
  echo "  is a FAST command, and every row built on it would look like a measurement."
  exit 1
fi

# --- rows --------------------------------------------------------------------------------------
# --- sampling ----------------------------------------------------------------------------------
PROG_DONE=0; PROG_TOTAL=0
GAP_NOTE=""; [ "$GAP" = "0" ] || GAP_NOTE="  (+${GAP}s gap)"
progress() {
  PROG_DONE=$(( PROG_DONE + 1 ))
  [ -t 2 ] || return 0
  printf '\r  [%d/%d] %-44s' "$PROG_DONE" "$PROG_TOTAL" "$1${GAP_NOTE}" >&2
}
progress_end() { [ -t 2 ] && printf '\r%*s\r' 66 '' >&2; return 0; }

SAMP=()
for i in $(seq 0 $(( ${#CMDS[@]} - 1 ))); do SAMP[$i]=""; done
sample_cell() {
  local i="$1" t
  progress "${LABELS[$i]}"
  if [ "${KIND[$i]}" = "in" ]; then
    t=$(eval "${CMDS[$i]}" 2>/dev/null)          # the container timed it; take its answer
  else
    t=$( { time { eval "${CMDS[$i]}" >/dev/null 2>/dev/null; } ; } 2>&1 )
  fi
  SAMP[$i]="${SAMP[$i]} $t"
  [ "$GAP" = "0" ] || sleep "$GAP"
}

# Both sections walk the same helper, so they cannot drift apart again — an earlier version fixed
# the interleaving for the matrix and left the single commands blocked.
run_rows() {
  local first="$1" last="$2" count=$(( $2 - $1 + 1 ))
  PROG_DONE=0; PROG_TOTAL=$(( count * N ))
  if [ "$INTERLEAVED" = "0" ]; then
    for i in $(seq "$first" "$last"); do for _ in $(seq 1 "$N"); do sample_cell "$i"; done; done
  else
    for _ in $(seq 1 "$N"); do
      # A fresh permutation per round. python3 rather than `shuf`, absent on a stock macOS.
      for i in $(python3 -c "
import random
a = list(range($first, $last + 1)); random.shuffle(a); print(' '.join(map(str, a)))"); do
        sample_cell "$i"
      done
    done
  fi
  progress_end
}

render() {
  local first="$1" last="$2" f; f="$(mktemp)"
  for i in $(seq "$first" "$last"); do printf '%s\t%s\n' "${LABELS[$i]}" "${SAMP[$i]}" >> "$f"; done
  python3 "$(dirname "$0")/bench-render.py" < "$f"
  rm -f "$f"
}

echo
echo "obsidian-cli vs the filesystem on '$NODE' via $ENGINE"
echo "$N samples per row, each timed separately; milliseconds"
echo "rows marked '↳ in container' are timed INSIDE the node — the rest around the whole $ENGINE exec"
echo "histogram bins are shared down each section, so further right really is slower"
echo
[ "$INTERLEAVED" = "0" ] && echo "  BENCH_INTERLEAVED=0: rows run consecutively. Expect the controls to disagree — that is the point."
if [ -z "$CHECK" ]; then
  run_rows 0 $(( SINGLES - 1 ))
  render 0 $(( SINGLES - 1 ))
fi
echo
echo "  the four sampling calls, across every way of issuing them."
echo "  Axes: sequential vs parallel; one exec or one each; obsidian-cli vs the filesystem."
echo "  (sync:status and sync:history stay CLI in every row — nothing on disk can answer them.)"
echo
run_rows "$SINGLES" $(( ${#LABELS[@]} - 1 ))

# The floor is computed BEFORE the matrix is rendered, so each row can be marked against it: `=`
# means "median within the noise floor of the control", `*` means it stands clear. Otherwise the
# reader has to carry the floor in their head and subtract per row — and three differences that do
# not exist were believed here before this marker did the arithmetic for them.
CA=$SINGLES; CB=$(( SINGLES + 1 )); CSAME=$(( SINGLES + 2 ))
FLOORS=$(python3 -c "
import sys, statistics
groups, cur = [], []
for a in sys.argv[1:]:
    if a == '--': groups.append(cur); cur = []
    else: cur.append(float(a) * 1000)
groups.append(cur)
meds = sorted(statistics.median(sorted(g)) for g in groups if g)
print(f'{statistics.median(meds):.3f} {meds[-1] - meds[0]:.3f}')" ${SAMP[$CA]} -- ${SAMP[$CB]} -- ${SAMP[$CSAME]})
BENCH_BASELINE_MS=${FLOORS%% *} BENCH_FLOOR_MS=${FLOORS##* } render "$SINGLES" $(( ${#LABELS[@]} - 1 ))
echo "  '=' median is within 2x this run's noise floor of the controls; '*' stands clear of it."
echo "  Twice, because the floor is the range of only three medians, which understates the spread."

# Three rows ran an identical command: both controls and `batched, sequential (cli)`. The span across
# all three is this run's noise floor. All three, not just the two labelled controls — leaving one out
# would discard a third of the evidence and report a narrower floor than the run supports.
echo
# The footer answers "can this column tell the rows apart?" — not "does it reproduce to some fixed
# percentage". An earlier version used a flat 10%, which was a number with nothing behind it and was
# incoherent besides: at a ~270ms median, 10% is 27ms, while the cells differ from one another by
# ~20ms. A column could be stamped "usable" while its own floor was wider than every difference in
# it. So the two quantities are compared directly instead:
#
#   FLOOR   the column's span across the three rows that ran an IDENTICAL command — the difference
#           this apparatus reports between things that are not different.
#   SPREAD  the column's span across all the OTHER rows — the differences you are trying to read.
#
# If the floor is as large as the spread, the column cannot discriminate, whatever its percentage.
ALL=""
for i in $(seq "$SINGLES" $(( ${#LABELS[@]} - 1 ))); do
  [ "$i" = "$CA" ] || [ "$i" = "$CB" ] || [ "$i" = "$CSAME" ] && continue
  ALL="$ALL -- ${SAMP[$i]}"
done
python3 -c "
import sys, math, statistics

def parse(args):
    groups, cur = [], []
    for a in args:
        if a == '--':
            groups.append(cur); cur = []
        else:
            cur.append(float(a) * 1000)
    groups.append(cur)
    return [sorted(g) for g in groups if g]

argv = sys.argv[1:]
cut = argv.index('==')
ident = parse(argv[:cut])      # the three rows that ran the same command
others = parse(argv[cut + 1:]) # every other row

def stat(v, which):
    if which == 'med': return statistics.median(v)
    if which == 'p90': return v[math.ceil(0.9 * len(v)) - 1]
    if which == 'max': return v[-1]
    return v[-1] - v[0]

print(f'  NOISE FLOOR, from {len(ident)} rows that ran an identical command')
print(f'  (control A, control B and \'batched, sequential (cli)\').')
print()
print('    column      floor   resolves   rows within the floor')
for which in ('med', 'p90', 'max', 'span'):
    fl = [stat(g, which) for g in ident]
    ot = [stat(g, which) for g in others]
    floor = max(fl) - min(fl)
    base = statistics.median(fl)
    # How many of the other rows sit inside 2x the floor of the identical ones — i.e. how much of
    # this column is indistinguishable from a row that ran the very same command. That is the number
    # that says what the column can do, and it does not collapse to "yes" just because one row is
    # obviously different, which a floor-versus-total-spread comparison does.
    inside = sum(1 for v in ot if abs(v - base) <= 2 * floor)
    print(f'    {which:<8} {floor:6.0f}ms   >{2 * floor:5.0f}ms   {inside} of {len(ot)} are inside it')" \
  ${SAMP[$CA]} -- ${SAMP[$CB]} -- ${SAMP[$CSAME]} == $ALL
echo

# --- the verdict, for check-assumptions ---------------------------------------------------------
#
# The harness picked its two arrangements from this table (docs/DESIGN.md, "How the calls are
# issued"): the sampler issues its four calls UNBATCHED + PARALLEL, and the write path, which cannot
# be parallel because each call depends on the last, goes BATCHED + SEQUENTIAL. Both were fast here
# under Obsidian 1.13.7 and Docker on macOS. Neither is a law about Obsidian; both are measurements
# of one environment, and an engine or a CLI that changed what an exec costs would move them.
#
# So the question asked here is not "how fast", it is "is the cell the code uses still among the fast
# ones". A cell is called slow when its median stands more than twice this run's noise floor clear of
# the best cell in the table — the same 2x the row markers use, and for the same reason: the floor is
# the range of three medians, which understates the spread, and every difference this benchmark has
# reported among the fast cells has evaporated on re-measurement.
if [ -n "$CHECK" ]; then
  ROWARGS=()
  for i in $(seq "$SINGLES" $(( ${#LABELS[@]} - 1 ))); do
    ROWARGS+=("${LABELS[$i]}|$(echo ${SAMP[$i]} | tr ' ' ',')")
  done
  python3 -c "
import sys, statistics

FLOOR = float(sys.argv[1])
rows = {}
for a in sys.argv[2:]:
    label, _, vals = a.partition('|')
    v = sorted(float(x) * 1000 for x in vals.split(',') if x)
    if v: rows[label.strip()] = statistics.median(v)

# The two the code uses. Named by the exact labels above; a rename there must break this loudly
# rather than silently check nothing.
USED = {
    'unbatched, parallel    (cli)': 'the sampler (ObsidianDriver.sampleNotes)',
    'batched,   sequential  (cli)': 'the write path (ObsidianDriver.editAndConfirm)',
}
missing = [k for k in USED if k not in rows]
if missing:
    print('  -- cannot check: no row labelled ' + '; '.join(repr(m) for m in missing))
    sys.exit(2)

best = min(rows.values())
margin = 2 * FLOOR
bad = []
print()
print(f'  best cell {best:.0f}ms; noise floor {FLOOR:.0f}ms, so \"noticeably worse\" is more than {margin:.0f}ms above it')
for label, why in sorted(USED.items()):
    med = rows[label]
    over = med - best
    verdict = 'ok' if over <= margin else '--'
    print(f'  {verdict}  {label}  {med:6.0f}ms  ({over:+.0f}ms vs best)   {why}')
    if over > margin: bad.append((label, med, over, why))

if not bad:
    print()
    print('  ok  both arrangements the design uses are still among the fast ones')
    sys.exit(0)
print()
print('  -- the design uses an arrangement that is no longer among the fast ones:')
for label, med, over, why in bad:
    print(f'       {why}')
    print(f'       uses {label.strip()}, now {over:.0f}ms above the best cell')
print()
print('     These were the arguably best arrangements under the Obsidian and container engine of')
print('     the day; they are measurements, not properties of Obsidian. If one is now noticeably')
print('     worse than the rest, the design should probably be revised: see docs/DESIGN.md,')
print('     \"How the calls are issued\", and the comments on the two methods named above.')
# 3, not 1: a slow cell is a finding about the DESIGN, while 1 and 2 mean this benchmark could not
# answer at all (a command broke, or a row label was renamed out from under the check).
sys.exit(3)
" "${FLOORS##* }" "${ROWARGS[@]}"
  exit $?
fi
