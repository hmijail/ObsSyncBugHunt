#!/usr/bin/env sh
# Demonstrate, on demand, what obsidian-cli's `vault=` parameter actually does.
#
# WHY THIS IS A SCRIPT AND NOT A PARAGRAPH. The harness's local-vault guard (src/local-vault.ts)
# exists because `vault=` is documented ("Target a specific vault by name"), accepted, exits 0 —
# and does not select a vault. Writing the evidence into docs/DESIGN.md as a table of numbers
# would be recording a fact about one machine on one afternoon, which goes stale silently and
# invites exactly the false confidence the guard exists to prevent. So the design note states the
# conclusion and points here; this re-derives it against whatever Obsidian is actually installed.
#
# It is a DEMONSTRATION, not a checker: it makes no read-only-vs-mutating judgement calls and
# touches nothing. Every call below is a read. The automatable half of the same claim is asserted
# by `make check-assumptions` (step 10), which fails the run if it changes.
#
# THE TWO HYPOTHESES, and why the weaker one survived for months. An early measurement compared a
# FOCUSED vault against a CLOSED one and concluded that `vault=` reaches any vault "open as its own
# window". That experiment cannot distinguish:
#
#   (A) `vault=` reaches any OPEN vault        (the weaker, more convenient reading)
#   (B) `vault=` reaches only the FOCUSED vault (what actually happens)
#
# because a closed vault is also a non-focused one. Telling them apart needs a second vault open in
# its own window while a different one is focused — which is a human action, so this script asks for
# it rather than pretending to arrange it. Run it both ways; case 2 is the one that matters.
#
# Usage:
#   scripts/probe-vault-param.sh [--bin <obsidian-cli>] [--other <vault name>]
#   make probe-vault-param [LOCAL_BIN=...] [OTHER_VAULT=...]
#
#   --other   the vault to aim `vault=` at. Defaults to the first known vault that isn't active.
#             Pass it explicitly to test a specific one — in particular, one you have deliberately
#             opened in a SECOND Obsidian window.
#
# Exits 0 if the probe ran and reported, 1 if it could not run (no CLI, no second vault, ...).
# It does NOT exit non-zero on a surprising answer — surprise is the interesting result here, and
# `make check-assumptions` is the thing whose job is to fail on it.
set -u

BIN=obsidian
OTHER=""
while [ $# -gt 0 ]; do
  case "$1" in
    --bin)   BIN="${2:-}"; shift 2 ;;
    --other) OTHER="${2:-}"; shift 2 ;;
    -h|--help) sed -n '2,37p' "$0" | sed 's/^# \{0,1\}//'; exit 0 ;;
    *) echo "unknown argument: $1 (try --help)" >&2; exit 1 ;;
  esac
done

command -v "$BIN" >/dev/null 2>&1 || { echo "probe: '$BIN' is not on PATH — pass --bin <path>" >&2; exit 1; }

cli() { "$BIN" "$@" 2>&1; }
rule() { printf '%s\n' "------------------------------------------------------------"; }

active=$(cli vault info=name | head -1)
case "$active" in
  ""|*Error:*|*"not enabled"*)
    echo "probe: obsidian-cli did not name a vault (said: '$active')." >&2
    echo "  Is Obsidian running, with the CLI enabled (Settings > General > Advanced)?" >&2
    exit 1 ;;
esac

vaults=$(cli vaults verbose)
printf '%s' "$vaults" | grep -q "$(printf '\t')" || {
  echo "probe: 'vaults verbose' did not return <name>TAB<path> rows — cannot pick another vault." >&2
  echo "  It said: $(printf '%s' "$vaults" | head -2)" >&2
  exit 1; }

# A vault that is NOT the active one. Any will do for case 1; for case 2 the caller names the one
# they have opened in a second window.
if [ -z "$OTHER" ]; then
  OTHER=$(printf '%s\n' "$vaults" | cut -f1 | grep -vxF "$active" | head -1)
  [ -n "$OTHER" ] || { echo "probe: only one vault ($active) is known to Obsidian — nothing to aim vault= at." >&2
                       echo "  Create or open a second vault, then re-run." >&2; exit 1; }
fi

# REFUSE to aim vault= at the vault that is already active. The probe would run, print, and prove
# nothing whatsoever — the answer is the active vault either way, so the output would be
# indistinguishable from a real result. That is the exact failure this whole probe exists to warn
# about ("a measurement that cannot distinguish two hypotheses"), and it is easier to commit here
# than anywhere else: `--other` is typed by hand, and focus moves while you are typing it.
if [ "$(printf '%s' "$OTHER" | tr 'A-Z' 'a-z')" = "$(printf '%s' "$active" | tr 'A-Z' 'a-z')" ]; then
  echo "probe: refusing to run — '--other $OTHER' is the vault that is ALREADY ACTIVE." >&2
  echo "  Aiming vault= at the active vault proves nothing: it answers with that vault whether" >&2
  echo "  the parameter works or is discarded. Name a DIFFERENT vault:" >&2
  printf '%s\n' "$vaults" | cut -f1 | grep -vxF "$active" | sed 's/^/    --other /' >&2
  echo "  (If you meant to test a second window, focus the OTHER vault first — Obsidian follows" >&2
  echo "   focus, so which one is 'active' changes as you click around.)" >&2
  exit 1
fi

echo "probe-vault-param: bin=$BIN"
echo "  active vault (what the CLI is really on):  $active"
echo "  aiming vault= at:                          $OTHER"
rule

# --- 1. does `vault=` change which vault answers? -------------------------------------------------
named=$(cli vault info=name "vault=$OTHER" | head -1)
bogus_name="definitely-not-a-vault-$$"
bogus=$(cli vault info=name "vault=$bogus_name" | head -1)

echo "1. Which vault answers when vault= names another one?"
printf '     %-42s -> %s\n' "vault info=name"                        "$active"
printf '     %-42s -> %s\n' "vault info=name vault=$OTHER"          "$named"
printf '     %-42s -> %s\n' "vault info=name vault=<not a vault>"   "$bogus"
if [ "$named" = "$active" ] && [ "$bogus" = "$active" ]; then
  echo "   => vault= was IGNORED. Both answered with the active vault, and an unknown name"
  echo "      produced no error at all. This is the behaviour local-vault.ts is built on."
elif [ "$named" = "$OTHER" ]; then
  echo "   => vault= REACHED '$OTHER'. That is NOT what this project measured; re-read"
  echo "      src/local-vault.ts and docs/DESIGN.md before trusting any local run."
else
  echo "   => unexpected: neither the active vault nor the requested one. Investigate."
fi
rule

# --- 2. same question, asked of content rather than identity --------------------------------------
# `vault info=name` could conceivably be special. Counting files is the independent check: two
# vaults of different sizes cannot both answer with the same count unless it is the same vault.
a_files=$(cli files | grep -c .)
o_files=$(cli files "vault=$OTHER" | grep -c .)

echo "2. Which vault's CONTENT comes back?"
printf '     %-42s -> %s entries\n' "files"                  "$a_files"
printf '     %-42s -> %s entries\n' "files vault=$OTHER"     "$o_files"
if [ "$a_files" = "$o_files" ]; then
  echo "   => the same count: vault= did not redirect the read either."
  echo "      (Only conclusive if the two vaults differ in size — check the paths below.)"
else
  echo "   => DIFFERENT counts: vault= reached a different vault. See the warning in 1."
fi
rule

# --- 3. the part a script cannot arrange for itself -----------------------------------------------
echo "3. The hypothesis this cannot settle on its own."
echo
echo "   The result above is the same whether '$OTHER' is CLOSED or merely NOT FOCUSED, so by"
echo "   itself it cannot tell these apart:"
echo "     (A) vault= reaches any OPEN vault        — then a closed '$OTHER' explains the result"
echo "     (B) vault= reaches only the FOCUSED vault — then being open would not have helped"
echo
echo "   To settle it: open '$OTHER' in a SECOND Obsidian window (File > Open vault), leave"
echo "   '$active' focused, and run:"
echo
echo "       scripts/probe-vault-param.sh --other '$OTHER'"
echo
echo "   If section 1 still answers '$active' with '$OTHER' visibly open in its own window, (B)"
echo "   holds and an open window buys nothing. That is what was measured on obsidian-cli 1.13.7,"
echo "   and it is why the harness CHECKS which vault is focused instead of trying to select one."
rule
echo "Known vaults and their paths (sizes make section 2 conclusive):"
printf '%s\n' "$vaults" | sed 's/^/  /'
