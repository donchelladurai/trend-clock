"""Convert histdata.com M1 zips for one instrument into N-minute bars [utc_ms, o, h, l, c, real].

    python tools/hist2bars.py spxusd data data/spxusd_m2.json 2 2026   # 2-minute bars, zips from 2026 on
    python tools/hist2bars.py eurusd data data/eurusd_m5.json 5        # 5-minute bars, every zip on disk

histdata stamps the bar's open minute in what its site calls EST, but the offset follows the
UK/European clock change, not the American one: the stamp is always Europe/London local time
minus five hours (FX week-open at raw 17:00 in January and July, raw 16:00 only in the three
March weeks when New York was on summer time and London was not; the London cash open at raw
03:00 the year round). So the conversion is raw + 5 h read as Europe/London time, then to UTC.
A fixed +5 h, which this script used until 25 Sep 2026, lands every summer bar an hour late.

Buckets are aligned to the UTC clock (an even minute for 2-minute bars, a multiple of five for
5-minute bars), which is also the UK clock's alignment since the UK offset is a whole hour. A
bucket with no source minute inside a trading week (a gap of up to 20 hours, so an overnight
cash close is covered and the weekend is not) is filled with a flat bar at the previous close and
marked real = 0, so the day index in tools/gen_row.js sees a complete grid but can still tell
where the feed had nothing; a window that is unreal on most days is drawn closed.
"""
import sys, glob, zipfile, json, io, os
from datetime import datetime, timezone, timedelta

pair, zipdir, out = sys.argv[1], sys.argv[2], sys.argv[3]
minutes = int(sys.argv[4]) if len(sys.argv) > 4 else 5
since = int(sys.argv[5]) if len(sys.argv) > 5 else 0     # skip zips for years before this
step = minutes * 60000

def last_sunday(y, month):
    d = datetime(y, month, 31 if month in (3, 10) else 30)
    return d - timedelta(days=(d.weekday() + 1) % 7)

def uk_to_utc(uk):
    """Naive Europe/London local time -> aware UTC, by the UK rule (BST from the last Sunday of
    March 01:00 UTC to the last Sunday of October 01:00 UTC). Written out because Windows Python
    ships no zone database and zoneinfo raises without the tzdata package."""
    bst_start = last_sunday(uk.year, 3).replace(hour=1)
    bst_end = last_sunday(uk.year, 10).replace(hour=1)
    guess = uk - timedelta(hours=1)          # UTC if the instant is in summer time
    off = 1 if bst_start <= guess < bst_end else 0
    return (uk - timedelta(hours=off)).replace(tzinfo=timezone.utc)
FILL_MAX = 20 * 3600000
rows = {}
for zp in sorted(glob.glob(os.path.join(zipdir, f"hist_{pair}_*.zip"))):
    if int(os.path.basename(zp).split('_')[2][:4]) < since:
        continue
    z = zipfile.ZipFile(zp)
    for name in z.namelist():
        if not name.endswith('.csv'):
            continue
        for line in io.TextIOWrapper(z.open(name), encoding='utf8'):
            parts = line.strip().split(';')
            if len(parts) < 5:
                continue
            d, t = parts[0].split(' ')
            uk = datetime(int(d[:4]), int(d[4:6]), int(d[6:8]), int(t[:2]), int(t[2:4])) + timedelta(hours=5)
            ts = uk_to_utc(uk)
            rows[int(ts.timestamp() * 1000)] = (float(parts[1]), float(parts[2]), float(parts[3]), float(parts[4]))
print(pair, 'm1 rows', len(rows))
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
print(pair, f'm{minutes} bars', len(bars), 'filled', filled, datetime.fromtimestamp(bars[0][0] / 1000, timezone.utc), '->', datetime.fromtimestamp(bars[-1][0] / 1000, timezone.utc))
json.dump(bars, open(out, 'w'), separators=(',', ':'))
