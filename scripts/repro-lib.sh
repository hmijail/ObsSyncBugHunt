# Bash runtime sourced by every script `make repro` generates. Six commands, one per DSL
# action (plus Check, the final verdict), each taking a NODE SELECTOR as $1 where relevant: a
# number (1, 2, ...) for a numbered container, or the literal "M" for the Mac. Exit codes from
# obsidian-cli/podman are never trustworthy (the CLI always exits 0 even on error — see
# docs/cli-trust.md) — every decision below is made from actual reply text, never $?.
#
# Expects these to already be set by the sourcing script: BIN, NODES (array), NETWORK, RUN_ID,
# NOTE_DIR, SEQ (a running counter, starts at 1), NODE_IP/NODE_MACADDR (arrays, one entry per
# node number), ALL_NODES (every node selector this run touches, numbers plus "M" if configured
# — used only by Check, to hunt for a token across every place it could have landed),
# WAIT_CAP_SEC/WAIT_POLL_SEC (Wait's bounded-poll tuning). MAC_BIN/MAC_NODE_ID are only needed if
# the history ever calls a function with "M".
#
# This is a SIMPLIFIED, hand-maintained reimplementation of src/execute.ts's real op interpreter
# (runHistory) — no retries, no settle/quiet-window logic. If execute.ts's own op semantics
# change (append's create-vs-append fallback, what a disconnect/connect actually does, what
# counts as "synced", the token format), check whether this file needs the same update —
# execute.ts carries the reverse pointer back to here for the same reason.

bin_for() {    # the command prefix to run obsidian-cli through
  if [ "$1" = "M" ]; then echo "$MAC_BIN"; else echo "podman exec ${NODES[$(($1-1))]} $BIN"; fi
}
nodeid_for() { # the real node-id string embedded in tokens (container name, or the Mac's own id)
  if [ "$1" = "M" ]; then echo "$MAC_NODE_ID"; else echo "${NODES[$(($1-1))]}"; fi
}

# Append <node> <letter> — try append, fall back to create if this node doesn't have the note
# yet (decided from the reply text, since exit codes are meaningless here — see above).
Append() {
  local b id note out
  b=$(bin_for "$1"); id=$(nodeid_for "$1")
  note="$NOTE_DIR/$RUN_ID-$2"
  out=$($b append file="$note" content="($id-$SEQ-$2)")
  [[ "$out" == Appended\ to:* ]] || $b create name="$note" content="($id-$SEQ-$2)"
  $b open file="$note"
  SEQ=$((SEQ+1))
}

# Wait <node> — bounded poll of this node's own sync:status until it says "synced". Simplistic:
# no per-note settle/quiet-window logic (see execute.ts for the real thing); gives up silently
# once WAIT_CAP_SEC has elapsed rather than erroring, so a stuck node doesn't kill the script.
Wait() {
  local b status i iters
  b=$(bin_for "$1")
  iters=$((WAIT_CAP_SEC / WAIT_POLL_SEC))
  for i in $(seq 1 "$iters"); do
    status=$($b sync:status)
    [[ "$status" == status:\ synced* ]] && break
    sleep "$WAIT_POLL_SEC"
  done
}

Disconnect() { podman network disconnect "$NETWORK" "${NODES[$(($1-1))]}"; }               # Disconnect <node> — never called with "M"
Connect()    { podman network connect --ip "${NODE_IP[$1]}" --mac-address "${NODE_MACADDR[$1]}" "$NETWORK" "${NODES[$(($1-1))]}"; } # Connect <node>
Pause()      { sleep "$1"; }                                                                # Pause <seconds>

# Check <letter> <token1> [<token2> ...] — the actual verdict: hunt for each token across every
# node/Mac's canonical content AND any "(Conflicted copy ...)" file for this note (token survival
# is "found somewhere", exactly the real oracle's rule in oracle.ts — just without its settle
# timing/quiet-window machinery). Call this ONLY after every node has had a chance to sync (the
# generated script always runs a Wait per node first — see generateScript's final step).
Check() {
  local letter=$1; shift
  local note="$NOTE_DIR/$RUN_ID-$letter"
  local blob="" n b entries f
  for n in "${ALL_NODES[@]}"; do
    b=$(bin_for "$n")
    blob+=$($b read file="$note")$'\n'
    entries=$($b files folder="$NOTE_DIR")
    while IFS= read -r f; do
      [[ "$f" == "$note "*"(Conflicted copy"* ]] && blob+=$($b read path="$f")$'\n'
    done <<< "$entries"
  done
  local tok missing=0
  for tok in "$@"; do
    if [[ "$blob" == *"$tok"* ]]; then echo "  OK      $tok"; else echo "  MISSING $tok"; missing=$((missing+1)); fi
  done
  echo "$note: $(($#-missing))/$# tokens found"
}
