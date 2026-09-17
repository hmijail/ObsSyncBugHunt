// Drawing a run as lanes of characters, one column per sampling slot.
//
// The RENDERER here knows nothing about where slots come from. That is the point: it draws
// `probe-propagation`'s live sampling loop, a rep reconstructed from its `.jsonl` afterwards, and the
// status bar during a soak, from one implementation. Gathering and drawing were entangled while all
// three lived inside the probe, and the only reason the probe could show this picture at all was
// that it happened to sample everything itself.
//
// `foldEvents`, at the bottom, is the one part that does know the log's event shapes — it turns a
// rep's events into slots. It is here rather than in its own file because both `timeline-rep` and
// `analyze` need it, and neither should import a CLI script to get it.
//
// THE CONCEPTUAL SLOT. A slot is any moment at which ANYONE sampled. Within a slot each lane shows
// either a character (that lane was sampled) or a SPACE (it was not). The space is load-bearing: a
// normal run samples strategically — a node is looked at when a `W` or a pause happens to touch it,
// and not otherwise — so most lanes are mostly empty, and drawing a `.` there would claim an
// observation that never happened. `.` means "looked, nothing changed"; ` ` means "did not look".
//
// SECONDS. A `|` is a wallclock second boundary. A second containing no slot at all contributes a
// bar with nothing after it, so an idle stretch reads as `||` — the gaps in our own instrument,
// visible rather than implied.
import type { NodeId } from "./types.js";

/** A counter reading. The non-answers are kept apart: `absent` is the server having no history for
 *  the note yet, `timeout` is the call BLOCKING — itself the signal that a sync is in flight there —
 *  and `unrecognized` is the CLI saying something we do not parse. */
export type Reading =
  | { kind: "ok"; total: number }
  | { kind: "absent" }
  | { kind: "timeout" }
  | { kind: "unrecognized" };

export const readReading = (r: { status: string; total?: number }): Reading =>
  r.status === "ok" ? { kind: "ok", total: r.total! }
  : r.status === "absent" ? { kind: "absent" }
  : r.status === "timeout" ? { kind: "timeout" }
  : { kind: "unrecognized" };

/** The mark alphabet, in one place so the live probe and the log reconstruction cannot drift apart.
 *  Anything not listed here is a lane-specific mark (a note letter, `D`/`C`, `F`). */
export const MARK = {
  unchanged: ".",
  blocked: "x", // the call was still running when its cap expired — the node is busy syncing
  // Nothing there YET — the server has no version history for this note, or this node has no such
  // file on disk. The two lanes mean the same thing by it, and it must never be confused with `.`:
  // a `vers` or `file` lane that drew a dot for an absent note claimed the note was fine.
  absent: "-",
  // FILE LANE. Two facts matter and both are wanted, so they are folded into one character: the
  // note's current STATE, and whether it changed in this very sample.
  //
  //   .  complete, unchanged          u  complete, and it changed here
  //   m  missing a token, unchanged   M  missing a token, and it changed here
  //   c  changed here, and a conflict file appeared with it
  //   C  the same, and a token is still missing
  //
  // "Missing" means a token acked by now that is in neither the note nor any of its conflict
  // copies. A token merely moved INTO a conflict copy is not this — the oracle calls that
  // `onlyInConflict` and it is a far milder thing.
  //
  // Only the STATE half is level: `m` redraws while the token stays missing. The change half is
  // edge — `u`, `M`, `c` and `C` each need something to have moved in this very sample.
  updated: "u",
  missing: "m",
  missingChanged: "M",
  conflicted: "c",
  conflictedMissing: "C",
  unparsed: "?", // the reply could not be identified at all
  // The readings do not agree — the note read as present while the folder listing omitted it. Not
  // `?`: both replies arrived and both parsed, so nothing was unreadable. Not yet a fault either,
  // so far as we can tell. This is the mark for "unexpected, worth a look", and it is the same
  // character a logged `weirdness` draws.
  unexpected: "!",
  unsampled: " ", // this lane was not looked at in this slot
  second: "|",
} as const;

/**
 * One node's copy of one note, as a single character. See MARK's file-lane block for the alphabet.
 *
 * Shared by the live probe and the log reconstruction, which used to decide this separately.
 *
 * `conflictAppeared` is the conflict count RISING since the last look at this (node, note) —
 * computed where the samples are taken, not here, because a reconstruction may start mid-run and
 * cannot diff counts it never saw.
 */
export const fileMark = (o: {
  fileStatus: string;
  lost: boolean;
  changed: boolean;
  conflictAppeared: boolean;
}): string => {
  if (o.fileStatus === "absent") return MARK.absent;
  if (o.fileStatus === "timeout") return MARK.blocked;
  if (o.fileStatus === "inconsistent") return MARK.unexpected;
  if (o.fileStatus !== "present") return MARK.unparsed;
  // Most specific first. A conflict outranks the plain change it also was, and losing a token
  // outranks both.
  if (o.lost && o.changed) return o.conflictAppeared ? MARK.conflictedMissing : MARK.missingChanged;
  if (o.lost) return MARK.missing;
  if (o.changed) return o.conflictAppeared ? MARK.conflicted : MARK.updated;
  return MARK.unchanged;
};

/**
 * How a node's reported sync state is drawn.
 *
 * An EXPLICIT table, not the state's first letter. Obsidian reports six states (see
 * cli-parse.ts's KNOWN_SYNC_STATUS) and two of them begin with the same letter: `syncing` and
 * `stopped` both became `s`, which is the worst possible collision here — one means data is moving,
 * the other means Sync is switched off.
 *
 * `synced` is the quiet baseline and draws the ordinary `.`; a blocked call is `x`; anything the
 * parser did not recognize is `?`.
 */
const SYNC_MARKS: Record<string, string> = {
  synced: MARK.unchanged,
  syncing: "s",
  paused: "p",
  error: "e",
  offline: "o",
  stopped: "h", // halted — `s` is taken, and `stopped` must never read as `syncing`
  timeout: MARK.blocked,
};

export const syncMark = (state: string): string => SYNC_MARKS[state] ?? MARK.unparsed;

/** Remembers the last OK value for one counter lane, so an unchanged reading renders as `.` and a
 *  change renders as its new value. Only the last digit is shown — the interesting thing is WHEN it
 *  moved, and a full number would cost a column per digit and break the grid. */
export class CounterLane {
  private prev: number | null = null;
  mark(r: Reading): string {
    if (r.kind === "timeout") return MARK.blocked;
    if (r.kind === "absent") return MARK.absent;
    if (r.kind === "unrecognized") return MARK.unparsed;
    const changed = r.total !== this.prev;
    this.prev = r.total;
    return changed ? String(r.total % 10) : MARK.unchanged;
  }
}

/**
 * One node's copy of one note, watched across successive looks — the file lane's sibling to
 * `CounterLane`, and for the same reason: deciding whether something CHANGED needs memory of the
 * last look, and that memory has exactly one correct behaviour on a look that did not answer.
 *
 * It lives here, shared by the harness and the propagation probe, because it did not before: both
 * kept their own `lastContent`/`lastConflicts` maps and their own copy of this logic, and both had
 * the same bug — a `timeout` cleared the remembered content, so the next successful look compared
 * against nothing and reported a change that never happened (15 of 16 `changed` marks on rep
 * 08T171228). Fixing it twice is what made it obvious it should only exist once.
 *
 * THE RULE: a look that did not answer is evidence of nothing and disturbs nothing. Only a positive
 * `present` or `absent` updates what is remembered. `CounterLane` has always worked this way.
 */
export class FileLane {
  private lastContent: string | undefined;
  private lastConflicts = 0;

  /**
   * Record one look, and report what it means.
   *
   * `tokens` are the ones that ought to be here by now; `lost` is the oracle's sense of the word —
   * present in neither the note nor any of its conflict copies. A token merely moved INTO a
   * conflict copy is not lost, which is why the copies' bodies are searched too.
   */
  look(o: { fileStatus: string; content: string; conflicts: string[]; tokens: string[] }): {
    fileStatus: string; changed: boolean; lost: boolean | null; conflicts: number; conflictAppeared: boolean;
  } {
    const present = o.fileStatus === "present";
    const answered = present || o.fileStatus === "absent";
    const changed = present && this.lastContent !== o.content;
    if (present) this.lastContent = o.content;
    // Positively absent is a real answer, and forgetting is right: if the file comes back, that IS
    // a change. Only a non-answer leaves the memory alone.
    else if (answered) this.lastContent = undefined;
    // Same rule for the conflict count: a non-answer resetting it to zero would make the next real
    // look report a conflict "appearing" that had been there all along.
    let conflictAppeared = false;
    if (answered) {
      conflictAppeared = o.conflicts.length > this.lastConflicts;
      this.lastConflicts = o.conflicts.length;
    }
    // `null`, not `false`: with no content to search, "the token is here" and "the token is gone"
    // are equally unfounded.
    const texts = [o.content, ...o.conflicts];
    const lost = answered ? o.tokens.some((t) => !texts.some((x) => x.includes(t))) : null;
    return { fileStatus: o.fileStatus, changed, lost, conflicts: o.conflicts.length, conflictAppeared };
  }
}

/** A lane's name is also its identity and its row label, e.g. `n1 ops`, `n2 vers a`. Node first,
 *  always: the rows are grouped by node, so a label that led with the note letter sorted one node's
 *  rows away from the rest of that node's. Built from a driver's own node name, never a hardcoded
 *  n1/n2, so the local instance `L` gets lanes like anything else. */
export type LaneId = string;

export const opsLane = (node: NodeId): LaneId => `${node} ops`;
export const syncLane = (node: NodeId): LaneId => `${node} sync`;
export const versLane = (letter: string, node: NodeId): LaneId => `${node} vers ${letter}`;
export const fileLane = (letter: string, node: NodeId): LaneId => `${node} file ${letter}`;

/** One column. A lane missing from `marks` was not sampled in this slot — distinct from a lane that
 *  was sampled and had nothing to report. */
export interface Slot {
  t: number; // seconds since the run started
  marks: Map<LaneId, string>;
}

export const slot = (t: number): Slot => ({ t, marks: new Map() });

/**
 * Lanes as text, one column per slot, `|` at each wallclock second boundary.
 *
 * Label width is derived from the lanes themselves rather than fixed. Hand-spacing these is exactly
 * how the ops row ended up one column out of step with the three below it, and with `L` in play and
 * note letters in the label there is no constant that stays right.
 */
export function renderLanes(slots: Slot[], lanes: LaneId[]): string[] {
  if (lanes.length === 0) return [];
  const width = Math.max(...lanes.map((l) => l.length)) + 2;
  const chars = new Map<LaneId, string[]>(lanes.map((l) => [l, []]));

  // Bars are derived from the slot times rather than pushed as the run goes, so a reconstruction
  // from timestamps and a live loop produce the same grid.
  let second = slots.length > 0 ? Math.floor(slots[0].t) : 0;
  for (const s of slots) {
    const sec = Math.floor(s.t);
    for (let i = 0; i < sec - second; i++) for (const cs of chars.values()) cs.push(MARK.second);
    second = sec;
    for (const l of lanes) chars.get(l)!.push(s.marks.get(l) ?? MARK.unsampled);
  }
  return lanes.map((l) => `      ${l.padEnd(width)}${chars.get(l)!.join("")}`);
}

/**
 * A block redrawn in place, so a table and its lanes grow while the run happens instead of appearing
 * only at the end.
 *
 * Rewinding is a cursor-up by LINE count, which is a physical-ROW count: a lane long enough to wrap
 * would undercount and each redraw would walk a little further up the screen. A run is assumed to
 * fit the terminal, so nothing here truncates.
 */
export class Live {
  private rows = 0;
  readonly on = Boolean(process.stdout.isTTY);
  draw(lines: string[]): void {
    if (!this.on) return;
    this.rewind();
    process.stdout.write(lines.join("\n") + "\n");
    this.rows = lines.length;
  }
  rewind(): void {
    if (!this.on || this.rows === 0) return;
    process.stdout.write(`\x1b[${this.rows}A\x1b[J`);
    this.rows = 0;
  }
}

// --- folding a rep's log back into slots ------------------------------------------------------
//
// The renderer above knows nothing about logs. This part does: it maps the events a rep actually
// writes onto lanes, so the same picture the propagation probe draws live can be reconstructed
// afterwards from any rep — at whatever resolution that rep happened to sample itself at.

interface LogEvent { t?: number; kind?: string; [k: string]: unknown }

const str = (e: LogEvent, k: string): string | null => (typeof e[k] === "string" ? (e[k] as string) : null);

/**
 * A rep's events -> the columns and lanes to draw.
 *
 * Lanes appear only if something in this rep could populate them, so the block never shows a row
 * that was never going to have anything in it. Within the lanes that do appear, a blank column is
 * the honest report that nobody looked — which in a `strategic` run is most of them.
 */
export function foldEvents(events: LogEvent[]): { slots: Slot[]; lanes: LaneId[]; quietSettleSlots: number } {
  const withT = events.filter((e) => typeof e.t === "number").sort((a, b) => a.t! - b.t!);
  const slots: Slot[] = [];
  const counters = new Map<LaneId, CounterLane>();
  const letters = new Map<string, string>(); // full note name -> DSL letter
  const nodes = new Set<string>();
  const used = new Set<LaneId>();

  // File lanes the sampler covers. It reports the note's full state (complete / missing / absent),
  // so wherever it is present it is the authority for that lane and weaker marks stand aside.
  const sampled = new Set<LaneId>();
  // Note letters come from `appended`; a rep that never appended has no notes to draw.
  for (const e of withT) {
    if (e.kind === "appended") {
      const full = str(e, "fullname"); const l = str(e, "note");
      if (full && l) letters.set(full, l);
    }
    const n = str(e, "node") ?? str(e, "wait");
    if (n) nodes.add(n);
    // `token-arrived` names its nodes as `to`/`from` and nothing else. Missing them meant a node
    // that only ever RECEIVES — never writes, never waits — had its lanes marked and then filtered
    // out for belonging to a node the fold had never heard of.
    for (const k of ["to", "from"]) { const v = str(e, k); if (v) nodes.add(v); }
    if (e.kind === "sample" && n !== null && typeof e.fileStatus === "string") {
      const full = str(e, "note");
      if (full !== null) sampled.add(fileLane(letters.get(full) ?? full, n));
    }
    for (const nn of (Array.isArray(e.nodes) ? e.nodes : [])) if (typeof nn === "string") nodes.add(nn);
  }
  const letterOf = (full: string | null): string | null => (full === null ? null : letters.get(full) ?? null);
  // Several events can land in one slot and speak about the same lane. A specific mark always wins
  // over a bare `.`: "the token arrived here" and "we looked and nothing changed" are both true of
  // that column, but only one of them is worth a character. Without this, a settle-poll logged just
  // after a `token-arrived` erased its `F`.
  // ONE EVENT, ONE COLUMN. A slot is "somebody measured something", and every logged observation is
  // exactly that, so there is nothing to infer and nothing to merge. This used to group events
  // within 250ms of each other, on the theory that a sampling round's lines belong together — but
  // the gaps between logged events turned out to be a continuum, not two clusters (measured
  // 2026-09-06: 42 gaps under 10ms, 35 in 50-250ms, 35 in 250-500ms), so the threshold was slicing
  // a distribution rather than separating one.
  //
  // Dropping it also removes a whole class of problem: when no two events share a column, two marks
  // can never collide, so there is no precedence rule to get wrong. An append and a disconnect 2ms
  // apart are simply two columns, which is what they are.
  //
  // The slot is created LAZILY, on the first mark: an event with nothing to say (`history`,
  // `network-probe`, `timings`) must not leave an empty column behind.
  let cur: Slot | null = null;
  const mark = (lane: LaneId, ch: string): void => {
    if (cur === null) { cur = slot(evT); slots.push(cur); }
    cur.marks.set(lane, ch);
    used.add(lane);
  };
  const counterFor = (lane: LaneId): CounterLane => {
    let c = counters.get(lane);
    if (!c) { c = new CounterLane(); counters.set(lane, c); }
    return c;
  };

  let evT = 0; // the timestamp of the event being folded, read by `mark` when it creates the slot
  let inWaitOn: string | null = null; // the node whose `W` is currently in progress, if any
  let settleFrom: number | null = null; // when the closing settle began, if it has
  for (const e of withT) {
    evT = e.t!;
    cur = null; // this event's column, made on demand by the first `mark`
    const node = str(e, "node");
    const letter = letterOf(str(e, "fullname") ?? str(e, "note")) ?? str(e, "note");

    switch (e.kind) {
      case "appended":
        inWaitOn = null;
        if (node && letter) mark(opsLane(node), letter);
        break;
      case "disconnecting": inWaitOn = null; if (node) mark(opsLane(node), "D"); break;
      case "connecting": inWaitOn = null; if (node) mark(opsLane(node), "C"); break;
      case "wait-handoff": if (node) mark(opsLane(node), "h"); break;
      case "pausing": if (node) mark(opsLane(node), "P"); break;
      // NOT ops lanes. `ops` is what the USER did — a write, a fault, a wait, a pause. These two are
      // things the harness NOTICED, and they are noticed about one node's copy of one note, so they
      // belong on that file lane where the reader is already looking for trouble.
      case "loss-detected": {
        const l = letterOf(str(e, "note"));
        if (node && l) mark(fileLane(l, node), "L");
        break;
      }
      case "weirdness": {
        const l = letterOf(str(e, "note"));
        if (node && l) mark(fileLane(l, node), MARK.unexpected);
        break;
      }
      case "token-arrived": {
        // An arrival is a content change, but this event knows only that ONE token showed up — not
        // whether the note ended up complete. Where the sampler is watching it does know, so the
        // sampler wins: drawing `u` here as well produced a column pair like `Mu`, two characters
        // for one instant flatly contradicting each other ("missing a token" / "complete").
        //
        // Kept for a STRATEGIC run, where nothing else marks this lane at all.
        const to = str(e, "to");
        const l = letterOf(str(e, "note"));
        if (to && l && !sampled.has(fileLane(l, to))) mark(fileLane(l, to), MARK.updated);
        break;
      }
      case "sample": {
        const l = letterOf(str(e, "note"));
        if (!node || !l) break;
        // Only when the event actually carries a counter. A sample emitted from a wait has a
        // content reading and no `sync:history`, and marking the lane anyway painted `?` down it.
        const vs = str(e, "versStatus");
        if (vs !== null) {
          const lane = versLane(l, node);
          mark(lane, counterFor(lane).mark(
            vs === "ok" ? { kind: "ok", total: Number(e.vers ?? 0) }
            : vs === "absent" ? { kind: "absent" }
            : vs === "timeout" ? { kind: "timeout" } : { kind: "unrecognized" },
          ));
        }
        const sync = str(e, "sync");
        if (sync) mark(syncLane(node), syncMark(sync));
        // The content read that comes with a full sample. `F` still comes from `token-arrived`,
        // which is the event that knows a token became readable; this only says we looked.
        // `absent` is NOT `.`. Both mean the read succeeded, but one of them means the note is not
        // on this node at all — and drawing a dot for it made a lane of "the file isn't here" look
        // exactly like a lane of "the file is here, unchanged", which is the opposite claim.
        const fs = str(e, "fileStatus");
        if (fs) {
          mark(fileLane(l, node), fileMark({
            fileStatus: fs,
            lost: e.lost === true,
            changed: e.changed === true,
            conflictAppeared: e.conflictAppeared === true,
          }));
        }
        break;
      }
      case "settle-poll": {
        const states = Array.isArray(e.states) ? e.states : [];
        // A mid-history wait names one node in `wait`; the final settle names them all in `nodes`.
        const who = str(e, "wait") !== null ? [str(e, "wait")!] : (Array.isArray(e.nodes) ? e.nodes : []);
        // A wait leaves no event of its own, so its first poll stands in for "a `W` started here".
        // Without this a successful wait is invisible in the reconstruction while the probe draws a
        // `W` for it — two pictures of the same run disagreeing about whether an op happened.
        //
        // Detected as a TRANSITION, not by `elapsedSec === 0`: the first poll already costs a sync
        // probe and a content gather, so it routinely logs `elapsedSec: 1` and that test silently
        // never fired.
        const waiter = str(e, "wait");
        if (waiter !== null && inWaitOn !== waiter) { mark(opsLane(waiter), "W"); inWaitOn = waiter; }
        if (waiter === null) inWaitOn = null; // a final settle ends whatever wait was in progress
        if (e.final === true && settleFrom === null) settleFrom = e.t!;
        who.forEach((nn, i) => {
          if (typeof nn !== "string") return;
          const st = states[i];
          mark(syncLane(nn), syncMark(typeof st === "string" ? st : "?"));
          // A wait that saw every expected token is a positive observation of this node's disk.
          const l = letterOf(str(e, "note"));
          if (l && e.missing === 0) mark(fileLane(l, nn), MARK.unchanged);
        });
        break;
      }
      case "content-at-wait": {
        const l = letterOf(str(e, "note"));
        const who = str(e, "wait");
        if (l && who) mark(fileLane(l, who), MARK.unchanged);
        break;
      }
      default: break;
    }
  }

  // Drop the closing settle's tail once it stops CHANGING anything. The final settle polls for a
  // fixed window after the history is over, so a rep that has come to rest ends in a long run of
  // columns repeating whatever the last state was — pure instrument, no run.
  //
  // "Changed" is per lane against what that lane last showed, NOT "is a dot". A settle repeating
  // `<` eighty times (a node stuck behind, which is what a losing rep looks like) is exactly as
  // unchanging as one repeating `.`, and an all-dots test kept every one of those columns. A settle
  // where something genuinely moves — a late arrival, a counter ticking, a conflict file appearing —
  // is what the settle is FOR, and everything up to that stays. The count dropped is reported rather
  // than silently swallowed.
  let quietSettleSlots = 0;
  if (settleFrom !== null) {
    const changesAt = new Array<boolean>(slots.length).fill(false);
    const seen = new Map<LaneId, string>();
    slots.forEach((sl, i) => {
      for (const [lane, m] of sl.marks) {
        // A NON-ANSWER is transparent here. `x` (the call was still running when its cap expired)
        // and `?` (a reply we cannot read) say nothing about whether the state moved, and a settle
        // whose sync lane flaps `. x .` would otherwise look like it was changing continuously —
        // which is enough to defeat the shave entirely, since the trailing run keeps being broken.
        if (m === MARK.blocked || m === MARK.unparsed) continue;
        if (seen.get(lane) !== m) { changesAt[i] = true; seen.set(lane, m); }
      }
    });
    // EVERY non-changing settle column goes, not merely the trailing run. Trimming only the tail
    // was defeated by anything at all happening late — a sync state flapping `. s .` in the last
    // second kept the entire settle, hundreds of columns of an unchanging `F`, because the trailing
    // run kept being broken.
    const kept: Slot[] = [];
    slots.forEach((sl, i) => {
      if (sl.t < settleFrom! || changesAt[i]) kept.push(sl);
      else quietSettleSlots++;
    });
    // Survivors are re-timed to sit right after the history, so the dropped span does not reappear
    // as a wall of second-bars. The settle is being SUMMARISED, and stretching the survivors across
    // the real elapsed time would put the noise back in a different shape. Their order and their
    // content are unchanged; only the spacing is, and the count says how much was dropped.
    const lastHistory = kept.filter((sl) => sl.t < settleFrom!).length;
    kept.slice(lastHistory).forEach((sl, i) => { sl.t = settleFrom! + i / 1000; });
    slots.length = 0;
    slots.push(...kept);
  }
  // Recomputed from what SURVIVED: a lane whose only marks were in the trimmed tail has nothing
  // left to show, and an empty row would be worse than no row.
  used.clear();
  for (const sl of slots) for (const l of sl.marks.keys()) used.add(l);

  // Grouped by NODE: everything about n1, then everything about n2. Reading a run means following
  // one node's story and then the other's, not comparing the same note across nodes — and the
  // per-note rows belong under the node whose ops and sync state explain them.
  const ns = [...nodes].sort();
  const ls = [...new Set(letters.values())].sort();
  const all = ns.flatMap((n) => [
    opsLane(n), syncLane(n),
    ...ls.flatMap((l) => [versLane(l, n), fileLane(l, n)]),
  ]);
  return { slots, lanes: all.filter((l) => used.has(l)), quietSettleSlots };
}

/**
 * A block pinned below scrolling output: `log()` erases it, writes the line, and redraws it
 * underneath.
 *
 * Everything a run prints must go through here while the bar is up. A stray `console.log` writes
 * into the rows the bar believes it owns, and every subsequent rewind then eats a line of real
 * scrollback — so `attach()` takes over `console.log` for the bar's lifetime rather than trusting
 * call sites to remember.
 */
export class StatusBar {
  private readonly live = new Live();
  private lines: string[] = [];
  private original: typeof console.log | null = null;

  attach(): void {
    if (!this.live.on || this.original !== null) return;
    this.original = console.log;
    console.log = (...args: unknown[]): void => {
      this.live.rewind();
      this.original!(...args);
      this.live.draw(this.lines);
    };
  }

  /** Replace what the bar shows. Cheap enough to call on every logged event. */
  set(lines: string[]): void {
    this.lines = lines;
    this.live.draw(lines);
  }

  detach(): void {
    this.live.rewind();
    if (this.original) { console.log = this.original; this.original = null; }
    this.lines = [];
  }
}
