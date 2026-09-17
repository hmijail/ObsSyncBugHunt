// Reconstruct one rep's timeline from its log.
//
// The propagation probe shows this picture live, by sampling everything itself several times a
// second. A normal rep cannot do that — the instrument would perturb what it measures — so it
// samples strategically: a node is looked at when a `W` or a pause happens to touch it, and not
// otherwise. The same picture is still there, at whatever resolution that rep happened to use.
//
// WHAT THE BLANKS MEAN. A `.` is "looked, nothing changed". A blank is "did not look at all". In a
// `strategic` run most lanes are mostly blank, and that is the honest report — the gaps are in our
// instrument, not in Sync. Run with `SAMPLING=everything` to fill them in, at the cost of
// perturbing the very timings the rep exists to measure.
//
// Usage: make timeline-rep REP=runs/<history>/<rep>.jsonl
//        npm run timeline-rep -- runs/<history>/<rep>.jsonl
import { readFileSync } from "node:fs";
import { foldEvents, renderLanes } from "./timeline.js";

function main(): void {
  const file = process.argv[2];
  if (!file) {
    console.error("timeline-rep: needs a rep .jsonl\n  make timeline-rep REP=runs/<history>/<rep>.jsonl");
    process.exit(2);
  }
  const events = readFileSync(file, "utf8").split("\n").filter(Boolean).flatMap((l) => {
    try { return [JSON.parse(l) as Record<string, unknown>]; } catch { return []; } // a torn last line
  });
  const hist = events.find((e) => e.kind === "history");
  const { slots, lanes, quietSettleSlots } = foldEvents(events);

  console.log("");
  console.log(`  ${(hist?.string as string) ?? file}${hist?.sampling ? `   (SAMPLING=${hist.sampling as string})` : ""}`);
  console.log("");
  if (lanes.length === 0) {
    console.log("  nothing observable in this rep — no appends, so no lanes to draw");
    return;
  }
  console.log("    ops:   a/b/... note written   D/C disconnect/connect   W wait   P pause   h handed off early");
  console.log("    | second boundary");
  console.log("    (blank) not sampled");
  console.log("    every lane: a column where nothing noteworthy happened holds only dots.");
  console.log("    file:  . complete   u complete, changed here   m missing a token   M missing, changed here");
  console.log("           - no file   L loss declared   ! readings that do not add up");
  console.log("           x this node\u0027s whole sample was cut off   ? reply not recognized");
  console.log("    vers:  digit the counter moved, to this value   . unchanged   - no history yet");
  console.log("    sync:  . synced   s syncing   p paused   e error   o offline   h stopped   x blocked");
  console.log("    (blank) not sampled");
  console.log("");
  for (const line of renderLanes(slots, lanes)) console.log(line);
  console.log("");
  const span = slots.length > 0 ? (slots[slots.length - 1].t - slots[0].t).toFixed(1) : "0";
  console.log(`  ${slots.length} sampling slots over ${span}s` +
    (quietSettleSlots > 0 ? `   (+${quietSettleSlots} quiet slots of closing settle, not shown)` : ""));
}

main();
