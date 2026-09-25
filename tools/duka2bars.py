"""Convert Dukascopy daily 1-minute .bi5 files (tools/fetch_dukascopy.py) into N-minute bars
[utc_ms, o, h, l, c, real], the same shape tools/hist2bars.py writes.

    python tools/duka2bars.py USA30IDXUSD data data/usa30_m2.json 2 1000

The last argument is the price scale (Dukascopy stores integers; 1000 for its index CFDs). Each
record is 24 bytes big-endian: seconds from that day's 00:00 UTC, open, close, low, high, volume
(float32). Dukascopy pads closed markets with placeholder records — a Saturday holds 1440 minutes
of o = h = l = c at zero volume, a weekday the same for its maintenance break — so a flat record
with zero volume is treated as absent, not as a bar; buckets missing inside a trading week (gaps
up to 20 hours) are then filled flat and marked real = 0, as hist2bars.py does, and the weekend
stays a gap.
"""
import sys, glob, os, lzma, struct, json
from datetime import datetime, timezone, date

sym, d, out = sys.argv[1], sys.argv[2], sys.argv[3]
minutes = int(sys.argv[4]) if len(sys.argv) > 4 else 2
scale = float(sys.argv[5]) if len(sys.argv) > 5 else 1000.0
step = minutes * 60000
FILL_MAX = 20 * 3600000
rows, placeholders = {}, 0
for p in sorted(glob.glob(os.path.join(d, f'duka_{sym}_*.bi5'))):
    if os.path.getsize(p) == 0:
        continue
    day = date.fromisoformat(os.path.basename(p)[len(sym) + 6:-4])
    base = int(datetime(day.year, day.month, day.day, tzinfo=timezone.utc).timestamp() * 1000)
    raw = lzma.decompress(open(p, 'rb').read())
    for i in range(len(raw) // 24):
        t, o, c, l, h, v = struct.unpack('>5if', raw[i * 24:(i + 1) * 24])
        if o <= 0:
            continue
        if v == 0 and o == h == l == c:
            placeholders += 1; continue
        rows[base + t * 1000] = (o / scale, h / scale, l / scale, c / scale)
print(sym, 'm1 rows', len(rows), 'placeholders dropped', placeholders)
agg = {}
for ms in sorted(rows):
    o, h, l, c = rows[ms]
    b = ms - ms % step
    e = agg.get(b)
    if e is None:
        agg[b] = [b, o, h, l, c, 1]
    else:
        e[2] = max(e[2], h); e[3] = min(e[3], l); e[4] = c
bars, prev, filled = [], None, 0
for k in sorted(agg):
    if prev is not None and step < k - prev[0] <= FILL_MAX:
        t = prev[0] + step
        while t < k:
            bars.append([t, prev[4], prev[4], prev[4], prev[4], 0]); filled += 1
            t += step
    bars.append(agg[k]); prev = agg[k]
print(sym, f'm{minutes} bars', len(bars), 'filled', filled, datetime.fromtimestamp(bars[0][0] / 1000, timezone.utc), '->', datetime.fromtimestamp(bars[-1][0] / 1000, timezone.utc))
json.dump(bars, open(out, 'w'), separators=(',', ':'))
