# Trusting obsidian-cli output (design decisions)

This harness is a correctness oracle, so the cardinal sin is emitting a verdict from CLI output we
didn't actually understand. obsidian-cli is hostile to naive trust: it **always exits 0** (even on
errors), and under load (a wedged container engine, a busy app) a call can return **empty or partial** output.
On 2026-06-26 a `files folder=bughunt` came back empty while the conflict files were on disk the whole
time — read as "no conflicts" → a fabricated "data loss". Never again.

The always-exits-0 half of that keeps catching things outside the parsers, where nobody is looking
for it. `containers/healthcheck.sh` wrote `if files_out=$(cli files); then ...; else notes=ERR; fi`
— so its ERR branch was unreachable, the refusal "Command line interface is not enabled" counted as
one line of output, i.e. one note, and a node whose CLI did nothing reported healthy. `wait-node.sh`
passed it and `containers-up` announced "nodes ready" for nodes that would sync nothing. Classify
obsidian-cli by its REPLY, never by its status, even in a shell one-liner that is not parsing
anything.

## The rule
**An output is used only if it can be POSITIVELY identified as a valid answer to the exact question
asked — otherwise the rep ends inconclusive (`-UNKNOWN`), never on a guess.** "Doesn't look like an
error" is not enough; it must affirmatively match a known answer shape.

- **Timely first.** Every call has a hard timeout (`exec.ts`, SIGKILL so a wedged engine CLI can't ignore
  it). A killed call is *untimely*: we log `cli-unresponsive` and **retry, waiting for recovery**
  (`driver.ts`'s `run`), never judging on a stalled read. A permanent outage (after the retry budget)
  ends the rep as `-UNKNOWN` (`cli-permanently-unresponsive`).
  - **The settle POLLS sync-state, it doesn't block on it.** `sync:status` *blocks until the node is
    synced* (it returns immediately only when synced), so the settle loop (`execute.ts`) reads it via a
    **bounded probe** (`driver.ts`'s `syncStateProbe`, `--probe-sec`, default 5s): a quick reply is the
    real status word, a timeout means "still syncing". That blocking behaviour is obsidian-cli's,
    not ours, so it is re-checked rather than assumed: `npm run probe-sync-versions -- --check`
    (`make check-assumptions`, step 8) fails if `sync:status` stops blocking, because then a probe
    timeout would no longer mean "not synced yet" and every settle would be reading noise. This is essential for correctness, not just
    speed — a single long blocking `sync:status` call straddling the quiescence window once made the
    settle judge a *single pre-convergence sample* (fabricating `-SYNCBAD`). Polling re-samples the
    content signature every cycle, so the verdict is built from the genuinely-settled state.
- **Then positively recognized.** `cli-parse.ts` has one recognizer per command; each returns a typed
  result only for a known shape, else the `UNRECOGNIZED` sentinel.
  - **Read-only calls retry for recovery.** An unparseable read is often just transient — a node
    mid-(re)connect answers a sync command with the free-text `Error: Sync is in error state.`
    (disconnection is also reported as the recognized word `error` by `sync:status`, which is why only
    the free-text commands tripped). So `driver.ts`'s `runRecognized` **re-runs the command a few
    seconds later hoping for a recognizable reply** (logging `cli-output-unrecognized-retry`), and only
    after the budget gives up. SAFE because reads are idempotent.
  - **Every attempt is also individually timeout-bounded, not just retried.** A read misbehaving isn't
    limited to "answers fast but wrong" — some commands (`sync:history ... total` in particular) can
    themselves silently block for a long stretch even after `sync:status` already reports the node
    `synced`, since the two commands' own internal readiness isn't the same clock. `runRecognized`
    bounds every attempt to a short per-call timeout (`recognizeCallTimeoutMs`) instead of inheriting
    `run()`'s much larger default, and a timed-out attempt retries exactly like an unrecognized one
    (`cli-call-timeout-retry`, same budget) — turning a long silent stall into a visible, bounded,
    retried sequence. A retry sequence that eventually succeeds is now logged too
    (`cli-output-recognized-after-retry`) — success used to return silently with no trace of how long
    it actually took to get there.
  - **Mutations fail fast.** `create`/`append`/`prepend`/`open`/`delete` (and sync on/off) are never
    retried — re-issuing a write could double-apply it; they go straight to `-UNKNOWN`.
  - On final give-up the driver throws a `CliUnrecognizedOutput` naming the **recognizer** that
    failed (the small `cli-parse.ts` function to teach the new shape) and ends the rep `-UNKNOWN`,
    logged with that recognizer name + the offending CLI line + throw site. So a **genuine future
    obsidian-cli format change is surfaced** instead of silently mis-scoring — see the per-rep-outcomes
    section below.
- **Empty is never a positive answer by itself.** See the `files` case below.
- **Absent** is positive **only** via the exact `Error: File "<name>" not found.` form.

## Known answer shapes (captured 2026-06-26, obsidian-cli 1.12.x)

Re-check with `npm run check-cli -- --nodes n1,n2` (or `make check-assumptions`, step 7, which runs
it and fails the pass on drift). It exercises every command below against a live node and reports
which recognizer no longer matches — so this list is a convenience, not the authority. The dates
and version above are when it was last written down by hand; the checker is what knows today.

- `read` → content; absent = `Error: File "…" not found.`; empty/other-error → UNRECOGNIZED.
- `files [folder=]` → lines of `*.md` paths; any `Error:` line → UNRECOGNIZED; **empty is ambiguous**
  (see below).
- `sync:status` → `status: <word>` (+ vault/size lines); the word must be in `KNOWN_SYNC_STATUS`
  (`synced|syncing|paused|error|stopped|offline`) — an unseen word → UNRECOGNIZED (learn & handle it).
- `sync:history file= total` → a bare integer; absent form; else UNRECOGNIZED.
- `sync:history file=` → `N: <date> (N bytes) [dev]` rows.
- `diff file= filter=sync` → filename header + `<v>  Sync  <date>  <size>  [dev]` rows.
- `sync:read file= version=` → `<name> (version N, <date>)` then `---` then content; bad version =
  `Error: Failed to retrieve version: …`.
- mutations (`create/append/prepend/open/delete`) → `Created:|Appended to:|Prepended to:|Opened:|Deleted( permanently)?:|Moved to trash:` …
- `vault info=name` → a single bare line naming the **active** vault; empty/`Error:` → UNRECOGNIZED.
  Note this is the one call that reads back what every other call is operating on — see the
  ignored-parameter section below.
- `vaults verbose` (added 2026-09-21, obsidian-cli 1.13.7) → one `<name>\t<path>` per known vault,
  open or not. Split on the FIRST tab: names cannot contain one, paths can contain spaces. Without
  `verbose` the paths are absent, which `parseVaultList` treats as UNRECOGNIZED rather than as a
  path-less half-answer — the paths are the whole reason it is parsed.

## A parameter the CLI ACCEPTS is not a parameter it HONOURS

Everything above is about not trusting what obsidian-cli *says*. This is the mirror image: not
trusting that it *did what it was told*. The rule above has a hidden assumption — that the answer
coming back is an answer to the question we asked — and a silently-ignored argument breaks exactly
that, without ever producing an output shape to be suspicious of.

`vault=<name>` is the case that proved it. It is documented (`obsidian help`: "Target a specific
vault by name"), it is accepted, it exits 0 — and it reaches only the vault Obsidian currently has
FOCUSED. Any other name, whether a closed vault, a vault open in another window, or not a vault at
all, is discarded in silence. `make probe-vault-param` re-derives this live rather than quoting a
reading taken once; `make check-assumptions` (step 10) fails if it ever stops being true.

Note what makes this invisible to every defence in this document. The output was a perfectly
well-formed, positively-recognizable vault name. `parseVaultName` was right to accept it. There
was no drift, no empty reply, no unknown `Error:` — the parser's entire contract was satisfied.
The answer was simply *about a different vault than the one asked about*, and no amount of
paranoia about output shapes can detect that.

**So a parameter that selects WHAT a call acts on needs its own confirmation, separately from the
recognizer.** The pattern that works is to stop treating the parameter as an instruction and treat
it as an assertion: ask the CLI what it is actually acting on, compare, and refuse on a mismatch
(`src/local-vault.ts`; the reasoning is in docs/DESIGN.md, "Targeting the local vault"). Fail
closed, because an unanswered probe leaves the same ignorance as a wrong answer.

A second-order trap, found the hard way in this same investigation. The first measurement of
`vault=` compared a *focused* vault against a *closed* one, concluded "it only reaches vaults open
as their own window", and that conclusion sat in `driver.ts` as "confirmed live" for months. It was
untestable-by-that-experiment: a closed vault is also a non-focused one, so the data could not tell
"reaches open windows" from "reaches only the focused vault". Opening the second vault in its own
window settled it in one command — `vault=` follows focus alone. **A measurement that cannot
distinguish two hypotheses has not chosen between them**, and writing it down as though it had is
how a harness ends up resting on the more convenient one. `probe-vault-param` exists partly to keep
that distinction in front of whoever re-checks this: its section 3 names both hypotheses and says
which one the run they just did can actually rule out.

The generalisation worth carrying: **a parameter is only trustworthy if some call reads it back.**
`vault=` can be read back (`vault info=name`), which is what makes the guard possible at all. Where
a future parameter cannot be read back, it should be treated as advisory and the harness arranged
so that nothing depends on it — not assumed to have worked because nothing complained.

And the corollary for tests of this kind: when a check compares two calls and expects them to
agree, make sure the baseline is *a real answer* first. A CLI that is refusing everything (e.g.
"Command line interface is not enabled.", the state a fresh container is in) returns the identical
refusal to both calls, and a naive equality test reports a confident pass. `check-assumptions`
step 10 validates the baseline looks like a vault name before comparing.

## The inherently-inconclusive case: `files` empty
`files folder=X` returns the **same empty string** for an empty folder, a *missing* folder, and a
*failed* call — there is no positive signal to tell them apart. (That `files` still parses at all
is re-checked by `npm run check-cli`; that the two independent sources still agree is re-checked on
every run by the cross-checks below, each of which logs a `cross-check` line whether or not it
finds a disagreement.) So an empty listing is **not** an
answer on its own; it must be confirmed by an independent source:

- **Anchor (the verdict path, implemented).** At the final observation, the rep's own canonical notes
  are known present (we created them and `read` just confirmed them). The listing is valid **iff it
  contains those anchor notes**; a listing that omits a note we can read is self-inconsistent and
  throws `CliInconsistencyError("cli-listing-inconsistent")` → the rep ends `-OBSFAIL`. This makes the
  2026-06-26 shape (empty `files` while reads succeed) impossible to mis-score. It is effectively a
  `read`-vs-`files` cross-check.
- **Filesystem second-source (implemented).** `ObsidianDriver.listDirFs` does a direct `ls` of the
  vault folder (`<vaultPath>/<folder>`, via `Executor.shell`); `ls` positively distinguishes empty-
  existing (exit 0, no entries) from missing (exit ≠ 0), which obsidian-cli's `files` cannot. At the
  **settled verdict**, `crossCheckFs` (execute.ts) compares the `.md` set the CLI reports against the
  set on disk: **every file the CLI reports must exist on disk, and every file on disk must be
  reported.** A CLI-reports-but-FS-lacks mismatch is the forum "conflict file was never really
  created" bug; an on-disk-but-CLI-omits mismatch is the 2026-06-26 dropout. Either → `-OBSFAIL`. Skipped
  when no `vaultPath` is configured (local/dev). `vaultPath` defaults to `/root/vaults/TestVault`
  (override `--vault-path`).
- **Filesystem second-source for CONTENT (implemented 2026-09-08).** The listing check above settles
  which files EXIST; this settles what is IN them. `ObsidianDriver.readFileFs` `cat`s a vault-relative
  path, and at the **settled verdict** `crossCheckContent` (execute.ts) compares disk against the
  observation the oracle is about to judge — every note's canonical body and every conflict copy's
  body, on every node. A mismatch → `cli-fs-content-disagreement` → `-OBSFAIL`.

  Why it was needed: `lost` — the finding this whole harness exists to produce — meant "obsidian-cli's
  `read` did not show the token, in the note or any conflict copy, on any node". One witness. A `read`
  that omitted a token the file actually contained would have been reported as data loss, and nothing
  would have contradicted it. The listing check had refused to take the CLI's word about which files
  exist since the beginning; this stops taking its word about their contents.

  Trailing newlines are normalised away before comparing (`read` returns the note without its final
  newline, `cat` returns the file); comparing raw makes the check fire on every note, which is the
  fastest route to it being switched off. Absent-on-both-sides is left to the listing check rather
  than re-reported here. Skipped when no `vaultPath` is configured. Costs about one round trip per
  file (`cat` and `read` measure the same — see docs/DESIGN.md); both cross-checks log a
  `cross-check` line with what they compared and their `ms`, agreeing or not, so the current cost is
  readable off any rep's log.

## An "unrecognized" reply must be logged WITH the reply

Recognizing output positively means there is a third outcome besides yes and no: the CLI said
something this harness does not parse. Recording only that fact is useless — teaching a recognizer
needs the exact bytes, and by the time anyone reads a log the call is long gone.

**This was a real blind spot, not a hypothetical one.** `runs/` accumulated **421** `versStatus:
"unrecognized"` sample entries that recorded the word and nothing else. The throwing path had always
been fine (`CliUnrecognizedOutput` carries the `ExecResult`, and `describeInconsistency` writes its
`stdout` into the rep's record); the gap was exactly the BOUNDED sampler, which must never throw and
was therefore dropping its evidence on the floor.

Every non-throwing path now returns the bytes alongside the status: `snapshotVersionsTotal`,
`snapshotRead`, `snapshotReadByPath`, `snapshotFiles`, `vaultNameProbe`, and the version read folded
into `editAndConfirm`. They surface on `sample` events as `versRaw` / `fileRaw`.

- **Not truncated.** A reply worth reporting is worth reporting whole; it is the one artefact that
  can teach the parser.
- **An empty reply reports `raw: ""`**, not a missing field. "It said nothing" and "it said something
  unparseable" are different faults and the log has to keep them apart.
- **`cli-batch-unrecognized-retry` names WHICH command failed** and what it said. "One of these five
  did not parse" is not actionable. A batch that could not be split at all has no per-command
  outputs, so it reports the whole reply instead.

**Open, and the point of collecting this.** The replies that *were* being captured are all things
this project already documents: `Error: Sync is in error state. Check sync settings.` and
`Error: Failed to retrieve sync history: Cannot read properties of null (…)` — phases 3 and 2 of the
offline behaviour in docs/DESIGN.md. If those turn out to be the bulk of the unrecognized replies,
they are not unparseable at all: they are a **known refusal** being filed as a mystery, and the
recognizers should return it as a positive "the client refused" answer. That is now decidable from
any soak's own log, which it was not before.

## Flagged-inconsistency conditions are per-rep outcomes (not a soak-killer)
A correctness-assumption violation is **not fatal** — it's just another possible result of a rep, so a
night-long soak keeps running. `runRep` (run.ts) is the single choke point every rep funnels through;
it catches `CliInconsistencyError` / `CliUnrecognizedOutput`, classifies it (`inconsistency.ts`), tags
the rep dir, and moves on. Two categories:

- **`-OBSFAIL`** — a client **misreports its own vault**: a real finding. Covers
  `cli-fs-disagreement` (obsidian-cli's `files` listing vs a direct `ls` of the vault dir disagree —
  the forum "phantom conflict file" bug) and `cli-listing-inconsistent` (a note that `read`s as present
  is missing from the same node's `files` output — two CLI calls contradicting each other, the
  2026-06-26 dropped-listing shape). This is a discovery, so it must NOT read as "not implemented".
- **`-UNKNOWN`** — we **couldn't judge**: `CliUnrecognizedOutput` (output matched no recognizer → the
  parser needs updating for a CLI format change) or `cli-permanently-unresponsive` (the CLI never
  answered within the retry budget). Also the verdict ladder's catch-all.

Each hit is logged to iterate on it immediately: a `category`-tagged JSON line appended to a durable
top-level index named after the label — **`runs/OBSFAIL.log`** / **`runs/UNKNOWN.log`** — carrying the
offending **CLI line in copy-paste-runnable form** (`quoteArgv(raw.argv)`, e.g.
`docker exec n1 /opt/obsidian/obsidian-cli read 'file=…'`) and the **`src/file:line`** throw site
(`siteOf`, parsed from the stack); a compact console line; and a `<category>.json` dropped in the rep
dir. The morning-after triage file name already says which kind it was. An inconsistency that escapes
the rep loop entirely (e.g. preflight against an unparseable baseline) has no rep to attach to, so the
top-level handler records it the same way and exits.
