#!/usr/bin/env sh
# GUI liveness report for an Obsidian node, INDEPENDENT of Sync. Gathers several
# orthogonal signals so we can tell a genuinely-alive app from a blank/stuck
# startup — and, separately, from a hung Sync. Each probe is timeout-guarded so
# one hang can't mask the others; a full report is always printed.
#
# Single-line output (shell-evalable key=value pairs):
#   shot_bytes=<int>   screenshot PNG size — rendered UI (light theme) = tens of KB;
#                      a blank/black screen compresses to a few hundred bytes
#   windows=<int>      top-level X clients (Obsidian window mapped => >=1)
#   notes=<int|ERR>    `obsidian-cli files` line count — a NON-sync CLI command, so
#                      it proves the app + vault are serving without touching Sync
#
# Side effects: (re)writes /var/log/obsidian-shot.png for forensics and appends a
# timestamped report line to /var/log/obsidian-health.log. Always exits 0 — it is
# a report, not a gate; callers apply their own policy.
export DISPLAY=:99
shot=/var/log/obsidian-shot.png
cli=/opt/obsidian/obsidian-cli

# 1. screenshot + size
if timeout 15 import -window root "$shot" 2>/dev/null; then
  shot_bytes=$(stat -c %s "$shot" 2>/dev/null || echo 0)
else
  shot_bytes=0
fi
case "$shot_bytes" in ""|*[!0-9]*) shot_bytes=0 ;; esac

# 2. window count (X clients with a top-level window)
windows=$(timeout 8 xlsclients -display :99 2>/dev/null | grep -c .)
case "$windows" in ""|*[!0-9]*) windows=0 ;; esac

# 3. note count via a non-sync CLI command (app + vault liveness)
# `notes` answers "is the CLI actually usable on this node", which is what wait-node.sh gates on.
#
# It must NOT be decided by the exit status. obsidian-cli ALWAYS EXITS 0, even when refusing — the
# first line of docs/cli-trust.md — so `if files_out=$(...)` took the success branch every time and
# the ERR case was unreachable. The refusal "Command line interface is not enabled..." then counted
# as one line, i.e. one note, and a node whose CLI does nothing reported healthy: wait-node.sh
# passed it, containers-up announced "nodes ready", and the run did nothing for reasons no message
# ever connected to the missing login.
#
# So classify by the REPLY. Empty stays 0 (a fresh TestVault genuinely has no notes, and the
# empty-vs-failed ambiguity cli-trust.md describes is not resolvable here); the known refusal
# shapes are positively identified as ERR.
files_out=$(timeout 15 "$cli" files 2>/dev/null) || files_out="__call_failed__"
case "$files_out" in
  __call_failed__|*"not enabled"*|*"Error:"*) notes=ERR ;;
  "")                                         notes=0   ;;
  *)                                          notes=$(printf '%s\n' "$files_out" | grep -c .) ;;
esac

report="shot_bytes=$shot_bytes windows=$windows notes=$notes"
printf '%s\n' "$report"
printf '%s %s\n' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$report" >> /var/log/obsidian-health.log 2>/dev/null || true
exit 0
