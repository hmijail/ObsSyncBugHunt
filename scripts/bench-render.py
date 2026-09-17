# Render a section of the benchmark table: one row per line of `label \t s1 s2 s3 ...` (seconds).
#
# The histogram bins are SHARED across every row of a section, so the bars are comparable — a row
# sitting to the right really is slower, and a wide row really is more variable. Per-row scaling
# would normalise away exactly the two things worth seeing.
import os, sys, math, statistics

# `▁` is reserved for an EMPTY bin and nothing else; any bin holding at least one sample starts at
# `▂`. Scaling all eight levels linearly across 0..peak looked tidier but quantised a single sample
# down to the same character as none at all (round(1/50*7) == 0), which hid exactly the rare
# outliers a distribution is drawn to reveal. So: 0 -> `▁`, 1 -> `▂`, peak -> `█`, and the seven
# non-empty levels share what is left.
BLOCKS = "▁▂▃▄▅▆▇█"

LEVELS = len(BLOCKS) - 1  # 7 bands; BLOCKS[0] belongs to the empty bin alone


def bar(count, peak):
    """0 -> the lowest char. Every other count falls in one of LEVELS equal bands of peak/LEVELS.

    ZERO IS THE ONLY SPECIAL CASE. 1 gets no level of its own: with peak=50 the first band spans
    1..7, so a bin holding one sample looks the same as one holding seven — which is right, because
    at that scale they are the same to within a fourteenth of the row. Only when peak <= LEVELS does
    each count get a distinct character.

    What 1 must never do is print as 0. It did, while all eight levels shared the 0..peak range
    (round(1 / 50 * 7) == 0), which hid exactly the lone outliers a distribution is drawn to show.
    Equal bands also mean a bar's height is the same fraction of the peak in every row, so heights
    can be compared down a column.
    """
    if count <= 0:
        return BLOCKS[0]
    return BLOCKS[min(LEVELS, math.ceil(count * LEVELS / peak))]
# Bin width in milliseconds, fixed rather than derived from the data range. A fixed width means a
# bar occupies the same place on the page in every run, so two runs can be compared by eye and a
# bin's meaning ("50ms of latency") never shifts under you. Bins are anchored to a multiple of the
# width, for the same reason.
BIN_MS = float(os.environ.get("BENCH_BIN_MS", "50"))

# Optional: a baseline median and this run's noise floor, both in ms. Rows whose median sits within
# the floor of the baseline are marked `=`, meaning "indistinguishable from the control". Without it
# a reader has to hold the floor in their head and do the arithmetic per row, which is how three
# non-existent differences got believed before this existed.
BASE = float(os.environ.get("BENCH_BASELINE_MS", "0")) or None
FLOOR = float(os.environ.get("BENCH_FLOOR_MS", "0")) or None

rows = []
for line in sys.stdin:
    line = line.rstrip("\n")
    if not line.strip():
        continue
    label, _, rest = line.partition("\t")
    v = sorted(float(x) * 1000 for x in rest.split())
    if v:
        rows.append((label, v))
if not rows:
    sys.exit(0)

lo = math.floor(min(v[0] for _, v in rows) / BIN_MS) * BIN_MS
hi = max(v[-1] for _, v in rows)
BINS = max(1, math.ceil((hi - lo) / BIN_MS))

axis = f"{lo:.0f}ms"
dashes = max(0, BINS - len(axis) - len(f"{lo + BINS * BIN_MS:.0f}ms") - 2)
print(f"  {'':<38} {'min':>6} {'med':>6} {'p90':>6} {'max':>6} {'span':>6}   "
      f"{axis} {'—' * dashes} {lo + BINS * BIN_MS:.0f}ms  ({BIN_MS:.0f}ms per bin)")
for label, v in rows:
    counts = [0] * BINS
    for x in v:
        counts[min(BINS - 1, int((x - lo) / BIN_MS))] += 1
    peak = max(counts) or 1
    spark = "".join(bar(c, peak) for c in counts)
    p90 = v[math.ceil(0.9 * len(v)) - 1]
    med = statistics.median(v)
    mark = " "
    if BASE and FLOOR:
        # TWICE the floor before claiming a difference. The floor is the range of three medians, and
        # the range of three samples is a badly downward-biased estimate of spread — so treating it
        # as a hard threshold marks 12ms-off-an-8ms-floor as a real effect. Erring toward "no
        # difference" is the right direction here: every difference this benchmark has reported
        # among the fast cells has evaporated on re-measurement.
        mark = "*" if abs(med - BASE) > 2 * FLOOR else "="
    print(f"  {label:<38} {v[0]:6.0f} {med:6.0f} {p90:6.0f} {v[-1]:6.0f} {v[-1]-v[0]:6.0f} {mark} {spark}")
