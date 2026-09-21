#!/usr/bin/env sh
# Does check-assumptions' vault-premise check actually DETECT the changes it claims to detect?
#
# WHY THIS EXISTS. Steps 9 and 10 of check-assumptions.sh guard the premise the local-vault guard
# rests on: that obsidian-cli still ignores `vault=` for a vault that isn't focused, and still
# lists vaults with their paths. Between them they have six branches, and in normal operation
# exactly two ever run — the "nothing has changed" ones. The rest fire only on a day obsidian-cli
# has behaved differently, which is to say: never, until the single occasion they have to be
# right. Untested code that runs once, years later, under surprise, is not a safety net; it is a
# comment that happens to be executable.
#
# So the branches are exercised here against FAKE CLI replies. No container, no Obsidian, no
# network: it redefines `cli()` and runs the real block.
#
# WHAT IT REFUSES TO DO, and why each refusal is here rather than assumed:
#
#   - It does not keep its own COPY of the block. It extracts the live one between the
#     `>>> vault-premise-check` / `<<< vault-premise-check` sentinels. A copy would pass forever
#     while the real step rotted beside it, which is precisely the failure this whole line of work
#     is about.
#   - It does not accept whatever the sentinels happen to bracket. The extracted text is checked
#     for the things that make it the check it claims to be (it must call `cli`, must ask
#     `vault info=name`, must pass a `vault=` argument, must list vaults). Sentinels that drift
#     around an empty or gutted region would otherwise "pass" every case having tested nothing —
#     which is not hypothetical: the first version of this file asserted `vaults verbose` was in
#     the block while the closing sentinel sat above it, and said so on its first run.
#   - It does not judge a case by its exit status alone. Most branches fail, so an exit code
#     cannot tell them apart — a bug that routed the "it errors now" input into the "it switches
#     vaults now" branch would be invisible, both being failures. Each case therefore also has to
#     produce ITS OWN message.
#
# Usage: scripts/check-assumptions-selftest.sh [-v]
#        -v  print each case's full output, pass or fail
# Exits 0 if every case produced the expected verdict AND the expected message, 1 otherwise.
set -u

verbose=0
[ "${1:-}" = "-v" ] && verbose=1

here="$(cd "$(dirname "$0")" && pwd)"
src="$here/check-assumptions.sh"
work="${TMPDIR:-/tmp}/ca-selftest.$$"
mkdir -p "$work"
trap 'rm -rf "$work"' EXIT

[ -r "$src" ] || { echo "selftest: cannot read $src" >&2; exit 1; }

# ---- extract the live block, then prove it is still the block -----------------------------------
block="$work/block.sh"
sed -n '/^# >>> vault-premise-check/,/^# <<< vault-premise-check/p' "$src" > "$block"

fatal() { echo "selftest: $1" >&2; shift; for l in "$@"; do echo "  $l" >&2; done; exit 1; }

grep -q '^# >>> vault-premise-check' "$block" && grep -q '^# <<< vault-premise-check' "$block" || fatal \
  "could not extract the vault-premise block from $src" \
  "the '>>> vault-premise-check' / '<<< vault-premise-check' sentinels are missing, reordered," \
  "or no longer at the start of their lines. Restore them around the step 10+11 block, or this" \
  "test silently verifies nothing."

# Structural sanity: the sentinels could survive while the code between them does not.
# Each pattern below is something the check cannot do its job without.
miss=""
grep -q 'cli vault info=name'      "$block" || miss="$miss\n  - no 'cli vault info=name' (the baseline read)"
grep -q 'vault=\$bogus'            "$block" || miss="$miss\n  - no 'vault=\$bogus' argument (the thing being tested)"
grep -q 'vaults verbose'           "$block" || miss="$miss\n  - no 'vaults verbose' (the listing the guard resolves against)"
[ "$(grep -c 'bad ' "$block")" -ge 3 ] || miss="$miss\n  - fewer than 3 'bad' branches; the drift cases look gone"
if [ -n "$miss" ]; then
  printf 'selftest: the extracted block no longer looks like the vault-premise check:%b\n' "$miss" >&2
  echo "  Either steps 10/11 were rewritten (update this file to match), or the sentinels now" >&2
  echo "  bracket the wrong region. Refusing to report a pass on it." >&2
  exit 1
fi

# ---- the cases ----------------------------------------------------------------------------------
# One per way the world can be. Each names the expected verdict AND a fragment that only ITS branch
# prints — because three of the four outcomes are failures and an exit code cannot tell them apart.
#
#   ignored     the premise, unchanged                   -> ok    (guard still required)
#   errors      obsidian-cli started validating vault=   -> fail  (an improvement; docs go stale)
#   switches    vault= actually selects a vault now      -> fail  (the guard's assumption is void)
#   disabled    the CLI refuses everything identically   -> fail  (the false-green this nearly shipped)
#   empty       the CLI answered nothing                 -> fail  (no baseline, so nothing is proven)
#   no-paths    `vaults verbose` lost its path column    -> fail  (parseVaultList would break)
cases='ignored errors switches disabled empty no-paths'

want_rc()    { case "$1" in ignored) echo 0 ;; *) echo 1 ;; esac; }
want_match() {
  case "$1" in
    ignored)  echo 'still silently ignored' ;;
    errors)   echo 'now ERRORS' ;;
    switches) echo 'reports a DIFFERENT vault' ;;
    disabled) echo 'did not name a vault' ;;
    empty)    echo 'did not name a vault' ;;
    no-paths) echo 'no longer <name>TAB<path> rows' ;;
  esac
}
# The block makes TWO different calls (`vault info=name [vault=...]` and `vaults verbose`), so each
# fake dispatches on the arguments. A fake that answered everything with one string is how the
# `disabled` false-green happened in the first place — it is a case here, not the default.
VAULTS_TSV='TestVault	/root/vaults/TestVault'
fake_cli() {
  case "$1" in
    ignored)  printf 'cli() { case "$*" in *"vaults verbose"*) printf "%%b\\n" "%s";; *) echo TestVault;; esac; }\n' "$VAULTS_TSV" ;;
    errors)   printf 'cli() { case "$*" in *"vaults verbose"*) printf "%%b\\n" "%s";; *definitely*) echo "Error: Vault \"x\" not found.";; *) echo TestVault;; esac; }\n' "$VAULTS_TSV" ;;
    switches) printf 'cli() { case "$*" in *"vaults verbose"*) printf "%%b\\n" "%s";; *definitely*) echo SomeOtherVault;; *) echo TestVault;; esac; }\n' "$VAULTS_TSV" ;;
    disabled) echo 'cli() { echo "Command line interface is not enabled. Please turn it on in Settings."; }' ;;
    empty)    echo 'cli() { echo ""; }' ;;
    no-paths) echo 'cli() { case "$*" in *"vaults verbose"*) echo TestVault;; *) echo TestVault;; esac; }' ;;
  esac
}

bad=0
for name in $cases; do
  rc_want=$(want_rc "$name")
  m_want=$(want_match "$name")
  run="$work/$name.sh"
  {
    echo '#!/usr/bin/env sh'
    echo 'set -u'
    # The stubs the block expects from its host script. `say` only prints a header, so flattening
    # it is safe; ok/bad keep their real meaning because the verdict IS what is under test.
    echo 'fails=0; step=8'
    echo 'CONTAINER_ENGINE=engine; live=node; CLI=/opt/obsidian/obsidian-cli'
    echo 'say() { step=$((step+1)); printf "  [step %d] %s\n" "$step" "$1"; }'
    echo 'ok()  { printf "      ok   %s\n" "$1"; }'
    echo 'bad() { printf "      FAIL %s\n" "$1"; fails=$((fails + 1)); }'
    fake_cli "$name"
    cat "$block"
    echo 'exit $fails'
  } > "$run"

  out=$(sh "$run" 2>&1); rc=$?
  # Normalise: the block's messages wrap across lines, so match against a single flattened line.
  flat=$(printf '%s' "$out" | tr '\n' ' ')

  rc_ok=no;  [ "$rc" -eq 0 ] && [ "$rc_want" -eq 0 ] && rc_ok=yes
  [ "$rc" -ne 0 ] && [ "$rc_want" -ne 0 ] && rc_ok=yes
  m_ok=no;   case "$flat" in *"$m_want"*) m_ok=yes ;; esac

  if [ "$rc_ok" = yes ] && [ "$m_ok" = yes ]; then
    printf '  ok    %-9s verdict=%s  matched %s\n' "$name" \
      "$( [ "$rc" -eq 0 ] && echo pass || echo fail )" "\"$m_want\""
    [ "$verbose" -eq 1 ] && printf '%s\n' "$out" | sed 's/^/          /'
  else
    printf '  FAIL  %-9s ' "$name" >&2
    [ "$rc_ok" = no ] && printf 'verdict=%s (wanted %s) ' \
      "$( [ "$rc" -eq 0 ] && echo pass || echo fail )" \
      "$( [ "$rc_want" -eq 0 ] && echo pass || echo fail )" >&2
    [ "$m_ok" = no ] && printf 'did not print "%s" (wrong branch fired?)' "$m_want" >&2
    printf '\n' >&2
    printf '%s\n' "$out" | sed 's/^/          /' >&2
    bad=$((bad + 1))
  fi
done

echo
if [ "$bad" -eq 0 ]; then
  echo "selftest: PASS — steps 10 and 11 detect every kind of change they claim to,"
  echo "          and each one lands in its own branch."
  exit 0
fi
echo "selftest: FAIL — $bad of $(echo $cases | wc -w | tr -d ' ') case(s) went wrong." >&2
echo "  The check in check-assumptions.sh no longer behaves as documented. Fix it there," >&2
echo "  not here: this file only states what it is supposed to do." >&2
exit 1
