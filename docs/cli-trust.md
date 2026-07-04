# Trusting obsidian-cli output (design decisions)

This harness is a correctness oracle, so the cardinal sin is emitting a verdict from CLI output we
didn't actually understand. obsidian-cli is hostile to naive trust: it **always exits 0** (even on
errors), and under load (a wedged podman, a busy app) a call can return **empty or partial** output.
On 2026-06-26 a `files folder=bughunt` came back empty while the conflict files were on disk the whole
time — read as "no conflicts" → a fabricated "data loss". Never again.

## The rule
**An output is used only if it can be POSITIVELY identified as a valid answer to the exact question
asked — otherwise the rep ends inconclusive (`-UNKNOWN`), never on a guess.** "Doesn't look like an
error" is not enough; it must affirmatively match a known answer shape.

- **Timely first.** Every call has a hard timeout (`exec.ts`, SIGKILL so a wedged `podman` can't ignore
  it). A killed call is *untimely*: we log `cli-unresponsive` and **retry, waiting for recovery**
  (`driver.ts`'s `run`), never judging on a stalled read. A permanent outage (after the retry budget)
  ends the rep as `-UNKNOWN` (`cli-permanently-unresponsive`).
  - **The settle POLLS sync-state, it doesn't block on it.** `sync:status` *blocks until the node is
    synced* (it returns immediately only when synced), so the settle loop (`execute.ts`) reads it via a
    **bounded probe** (`driver.ts`'s `syncStateProbe`, `--probe-sec`, default 5s): a quick reply is the
    real status word, a timeout means "still syncing". This is essential for correctness, not just
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

## The inherently-inconclusive case: `files` empty
`files folder=X` returns the **same empty string** for an empty folder, a *missing* folder, and a
*failed* call — there is no positive signal to tell them apart. So an empty listing is **not** an
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
`podman exec n1 /opt/obsidian/obsidian-cli read 'file=…'`) and the **`src/file:line`** throw site
(`siteOf`, parsed from the stack); a compact console line; and a `<category>.json` dropped in the rep
dir. The morning-after triage file name already says which kind it was. An inconsistency that escapes
the rep loop entirely (e.g. preflight against an unparseable baseline) has no rep to attach to, so the
top-level handler records it the same way and exits.
