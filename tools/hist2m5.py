"""Convert histdata.com M1 zips for one instrument into 5-minute bars [utc_ms, o, h, l, c].

    python tools/hist2m5.py audjpy data data/audjpy_m5.json

histdata timestamps are EST (UTC-5, no DST) and stamp the bar's open minute. Missing 5-minute
buckets inside a trading week are forward-filled with a flat bar at the previous close, so the
day index in tools/gen_row.js sees a complete grid; holidays then fall out on its movement test.
"""
import sys, glob, zipfile, json, io, os
from datetime import datetime, timezone, timedelta

pair, zipdir, out = sys.argv[1], sys.argv[2], sys.argv[3]
rows = {}
for zp in sorted(glob.glob(os.path.join(zipdir, f"hist_{pair}_*.zip"))):
    z = zipfile.ZipFile(zp)
    for name in z.namelist():
        if not name.endswith('.csv'):
            continue
        for line in io.TextIOWrapper(z.open(name), encoding='utf8'):
            parts = line.strip().split(';')
            if len(parts) < 5:
                continue
            d, t = parts[0].split(' ')
            ts = datetime(int(d[:4]), int(d[4:6]), int(d[6:8]), int(t[:2]), int(t[2:4]), tzinfo=timezone.utc) + timedelta(hours=5)
            rows[int(ts.timestamp() * 1000)] = (float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4]))
print(pair, 'm1 rows', len(rows))
m5 = {}
for ms in sorted(rows):
    o, h, l, c = rows[ms]
    b = ms - ms % 300000
    e = m5.get(b)
    if e is None:
        m5[b] = [b, o, h, l, c]
    else:
        e[2] = max(e[2], h); e[3] = min(e[3], l); e[4] = c
bars, prev, filled = [], None, 0
for k in sorted(m5):
    if prev is not None and 300000 < k - prev[0] <= 12 * 3600000:
        t = prev[0] + 300000
        while t < k:
            bars.append([t, prev[4], prev[4], prev[4], prev[4]]); filled += 1
            t += 300000
    bars.append(m5[k]); prev = m5[k]
print(pair, 'm5 bars', len(bars), 'filled', filled, datetime.fromtimestamp(bars[0][0] / 1000, timezone.utc), '->', datetime.fromtimestamp(bars[-1][0] / 1000, timezone.utc))
json.dump(bars, open(out, 'w'), separators=(',', ':'))
