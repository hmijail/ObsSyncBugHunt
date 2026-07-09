# Bash runtime sourced by every script `make repro` generates. Six commands, one per DSL
# action (plus Check, the final verdict), each taking a NODE SELECTOR as $1 where relevant: a
# number (1, 2, ...) for a numbered container, or the literal "L" for the local instance. Exit
# codes from obsidian-cli/podman are never trustworthy (the CLI always exits 0 even on error —
# see docs/cli-trust.md) — every decision below is made from actual reply text, never $?. The one
# exception is podman's OWN commands (network connect/disconnect), whose exit code IS meaningful.
#
# Expects these to already be set by the sourcing script: BIN, NODES, NETWORK, RUN_ID,
# NOTE_DIR, TS (a fresh per-execution timestamp, so re-running the same script twice never
# collides with the first run's notes), SEQ (a running counter, starts at 1), NODES/NODE_IP/
# NODE_MACADDR (sparse arrays keyed by the actual node NUMBER, e.g. NODES[3]=n3 if the history
# only ever touches N3 — never a compact 0-based array, since a history can skip numbers),
# ALL_NODES (every configured node selector, numbers plus "L"
# if configured — used only by Check, to hunt for a token across every place it could have
# landed, since any configured node is a live, continuously-syncing participant regardless of
# whether this particular history happens to touch it — mirrors execute.ts's own final settle,
# which always checks every configured driver, never just touched ones), VERBOSE (0/1),
# WAIT_CAP_SEC/WAIT_POLL_SEC (Wait's bounded-poll tuning). LOCAL_BIN/LOCAL_NODE_ID are only needed
# if the history ever calls a function with "L".
#
# This is a SIMPLIFIED, hand-maintained reimplementation of src/execute.ts's real op interpreter
# (runHistory) — no retries, no settle/quiet-window logic. If execute.ts's own op semantics
# change (append's create-vs-append fallback, what a disconnect/connect actually does, what
# counts as "synced", the token format), check whether this file needs the same update —
# execute.ts carries the reverse pointer back to here for the same reason.

# run <argv...> — echoes "+ argv..." to stderr when VERBOSE=1, then executes argv exactly as if
# run() weren't there (its own exit status is the wrapped command's, so `run ... || die ...`
# works; its stdout is exactly the wrapped command's, so `x=$(run ...)` captures cleanly).
run() {
  [ "${VERBOSE:-0}" = 1 ] && echo "+ $*" >&2
  "$@"
}

# die <message> — abort the whole script immediately with a clear reason, instead of letting one
# silently-failed step cascade into a pile of confusing follow-on errors two steps later.
die() { echo "ABORT: $*" >&2; exit 1; }

bin_for() {    # the command prefix to run obsidian-cli through
  if [ "$1" = "L" ]; then echo "$LOCAL_BIN"; else echo "podman exec ${NODES[$1]} $BIN"; fi
}
nodeid_for() { # the real node-id string embedded in tokens (container name, or the local instance's own id)
  if [ "$1" = "L" ]; then echo "$LOCAL_NODE_ID"; else echo "${NODES[$1]}"; fi
}

# Append <node> <letter> — try append, fall back to create if this node doesn't have the note
# yet (decided from the reply text, since exit codes are meaningless here — see above). Aborts if
# create itself doesn't report success — a note that silently never got created is exactly the
# failure that used to cascade into confusing "File not found" errors two steps later.
Append() {
  local b id note out
  b=$(bin_for "$1"); id=$(nodeid_for "$1")
  note="$NOTE_DIR/$TS-$2-$RUN_ID"
  out=$(run $b append file="$note" content="($id-$SEQ-$2)")
  if [[ "$out" != Appended\ to:* ]]; then
    out=$(run $b create path="$note.md" content="($id-$SEQ-$2)")
    [[ "$out" == Created:* ]] || die "create failed for $note: $out"
  fi
  run $b open file="$note"
  SEQ=$((SEQ+1))
}

# Wait <node> — bounded poll of this node's own sync:status until it says "synced". Simplistic:
# no per-note settle/quiet-window logic (see execute.ts for the real thing); gives up silently
# once WAIT_CAP_SEC has elapsed rather than aborting — a node that's slow (or stuck) to sync is
# often the actual finding being reproduced, not a broken step, so this deliberately does NOT die.
Wait() {
  local b status i iters
  b=$(bin_for "$1")
  iters=$((WAIT_CAP_SEC / WAIT_POLL_SEC))
  for i in $(seq 1 "$iters"); do
    status=$(run $b sync:status)
    [[ "$status" == status:\ synced* ]] && break
    sleep "$WAIT_POLL_SEC"
  done
}

# Disconnect/Connect <node> — never called with "L". Unlike the CLI, podman's own exit code IS
# meaningful, so these check it directly (the one place in this file that does).
Disconnect() { run podman network disconnect "$NETWORK" "${NODES[$1]}" || die "disconnect failed for node $1"; }
Connect()    { run podman network connect --ip "${NODE_IP[$1]}" --mac-address "${NODE_MACADDR[$1]}" "$NETWORK" "${NODES[$1]}" || die "connect failed for node $1"; }
Pause()      { sleep "$1"; }                                                                # Pause <seconds>

# Check <letter> <token1> [<token2> ...] — the actual verdict: hunt for each token across every
# node/local instance's canonical content AND any "(Conflicted copy ...)" file for this note (token survival
# is "found somewhere", exactly the real oracle's rule in oracle.ts — just without its settle
# timing/quiet-window machinery). Call this ONLY after every node has had a chance to sync (the
# generated script always runs a Wait per node first — see generateScript's final step).
Check() {
  local letter=$1; shift
  local note="$NOTE_DIR/$TS-$letter-$RUN_ID"
  local blob="" n b entries f
  for n in "${ALL_NODES[@]}"; do
    b=$(bin_for "$n")
    blob+=$(run $b read file="$note")$'\n'
    entries=$(run $b files folder="$NOTE_DIR")
    while IFS= read -r f; do
      [[ "$f" == "$note "*"(Conflicted copy"* ]] && blob+=$(run $b read path="$f")$'\n'
    done <<< "$entries"
  done
  local tok missing=0
  for tok in "$@"; do
    if [[ "$blob" == *"$tok"* ]]; then echo "  OK      $tok"; else echo "  MISSING $tok"; missing=$((missing+1)); fi
  done
  echo "$note: $(($#-missing))/$# tokens found"
}
