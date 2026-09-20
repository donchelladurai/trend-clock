"""Build data/swing.json: the 00:00-08:00 UK overnight session, per instrument, on the 4-hour,
1-hour and 30-minute charts.

    python tools/gen_swing.py data data/swing.json          # all instruments
    python tools/gen_swing.py data data/swing.json eurusd   # one, for a quick look

Reads the same histdata.com M1 zips tools/fetch_histdata.js downloads (EST-stamped, no DST) and
streams them once per instrument, so memory stays flat whatever the history length.

For every timeframe the bars are cut on UK local time, so a 4-hour bar is 00:00-04:00 UK the year
round and the slots line up with the clock the trader is reading. Three numbers per slot:

  trend  share of days the 20-period EMA of that timeframe moved more over that bar than a typical
         overnight bar moves on that chart: |EMA[t] - EMA[t-1]| >= TH x the 14-day ATR of UK
         calendar days, with TH fitted per timeframe as the median of that same quantity over every
         instrument and every slot of the session. "Trending" therefore reads as "busier than the
         median overnight bar of this chart", which is comparable across instruments because each
         is divided by its own daily ATR. The board's absolute 5-minute rule was carried over first,
         scaled by sqrt(minutes/15), and left every instrument between 10% and 18% — too dark to
         read and too strict to mean anything. The fitted values are recorded in meta.trendRule.
  vol    the bar's true range as a share of that daily ATR: what fraction of a day's range this
         slot typically delivers. Median over the days, with the 90th percentile kept beside it,
         because the mean of a range is dragged about by single news bars.
  turn   trend starts and stops, counted the board's way: a three-state direction (+1/0/-1) with
         hysteresis, entering at 2 x TH and held while the sign is unchanged and the move is still
         above 0.5 x TH — the ratios the board keeps either side of its own trend threshold; a turn
         is any bar where that state differs from the bar before.
         Counts, the ratio to the row's own mean, and the Poisson/Benjamini-Hochberg tier are all
         computed here, because the swing page carries no statistics layer of its own.

A slot counts for a day only when the underlying minutes are at least half present and the bar
moved at all, so a thin overnight instrument reports fewer days rather than a flat line.
"""
import sys, os, glob, zipfile, io, json, math
from datetime import date, timedelta
from collections import defaultdict

DATA_DIR = sys.argv[1] if len(sys.argv) > 1 else 'data'
OUT = sys.argv[2] if len(sys.argv) > 2 else 'data/swing.json'
ONLY = sys.argv[3:] if len(sys.argv) > 3 else None

# Board label -> histdata symbol. Wall Street (Dow) and Chicago Wheat have no symbol on the feed.
INSTRUMENTS = [
    ('Indices', 'FTSE 100', 'ukxgbp'),
    ('Indices', 'Germany 40', 'grxeur'),
    ('Indices', 'France 40', 'frxeur'),
    ('Indices', 'US Tech 100', 'nsxusd'),
    ('Indices', 'US 500', 'spxusd'),
    ('FX — USD pairs', 'EUR/USD', 'eurusd'),
    ('FX — USD pairs', 'GBP/USD', 'gbpusd'),
    ('FX — USD pairs', 'AUD/USD', 'audusd'),
    ('FX — USD pairs', 'USD/CAD', 'usdcad'),
    ('FX — USD pairs', 'USD/JPY', 'usdjpy'),
    ('FX — USD pairs', 'USD/CHF', 'usdchf'),
    ('FX — USD pairs', 'NZD/USD', 'nzdusd'),
    ('FX — EUR crosses', 'EUR/GBP', 'eurgbp'),
    ('FX — EUR crosses', 'EUR/AUD', 'euraud'),
    ('FX — EUR crosses', 'EUR/JPY', 'eurjpy'),
    ('FX — EUR crosses', 'EUR/CAD', 'eurcad'),
    ('FX — EUR crosses', 'EUR/CHF', 'eurchf'),
    ('FX — EUR crosses', 'EUR/NZD', 'eurnzd'),
    ('FX — other crosses', 'AUD/JPY', 'audjpy'),
    ('Commodities', 'Spot Gold', 'xauusd'),
]
# minutes per bar -> how many of them fall in 00:00-08:00
TIMEFRAMES = [('4h', 240, 2), ('1h', 60, 8), ('30m', 30, 16)]
SESSION_MIN, SESSION_LEN = 0, 480          # 00:00 to 08:00 UK
# Every instrument is counted over the same window, so the rows can be read against each other.
# AUD/JPY has five years on disk from the board's own refresh; the rest have two, so two it is.
# Earlier bars are still streamed — they warm the EMA and the ATR — but they are not counted.
WINDOW_FROM = (2024, 1, 1)
ATR_DAYS, MA_LEN = 14, 20
ON_RATIO, OFF_RATIO = 2.0, 0.5          # either side of the fitted trend threshold, as the board has it
FDR, MID_FDR, MIN_LAM, MIN_N = 0.10, 0.40, 3.0, 30

# ---- UK local time without a per-row timezone call ---------------------------------------------
def days_from_civil(y, m, d):
    y -= m <= 2
    era = (y if y >= 0 else y - 399) // 400
    yoe = y - era * 400
    doy = (153 * (m + (-3 if m > 2 else 9)) + 2) // 5 + d - 1
    doe = yoe * 365 + yoe // 4 - yoe // 100 + doy
    return era * 146097 + doe - 719468

def last_sunday(y, m):
    """UTC minute of 01:00 on the last Sunday of month m — the BST switch."""
    d = 31 if m == 3 else 31 if m == 10 else 30
    while True:
        days = days_from_civil(y, m, d)
        if (days + 4) % 7 == 0:                      # 1970-01-01 was a Thursday
            return days * 1440 + 60
        d -= 1

FROM_DAY = days_from_civil(*WINDOW_FROM)
BST = {y: (last_sunday(y, 3), last_sunday(y, 10)) for y in range(2019, 2031)}
BST_RANGES = sorted(BST.values())

def uk_offset(utc_minute):
    for a, b in BST_RANGES:
        if a <= utc_minute < b:
            return 60
    return 0

# ---- one instrument ----------------------------------------------------------------------------
def stream_rows(symbol):
    """M1 rows as (uk_minute, open, high, low, close), chronological."""
    for zp in sorted(glob.glob(os.path.join(DATA_DIR, f'hist_{symbol}_*.zip'))):
        z = zipfile.ZipFile(zp)
        for name in z.namelist():
            if not name.endswith('.csv'):
                continue
            for line in io.TextIOWrapper(z.open(name), encoding='utf8'):
                p = line.split(';')
                if len(p) < 5:
                    continue
                stamp = p[0]
                y, mo, d = int(stamp[0:4]), int(stamp[4:6]), int(stamp[6:8])
                hh, mm = int(stamp[9:11]), int(stamp[11:13])
                utc = days_from_civil(y, mo, d) * 1440 + hh * 60 + mm + 300   # EST -> UTC
                yield utc + uk_offset(utc), float(p[1]), float(p[2]), float(p[3]), float(p[4])

def build(symbol):
    """Bars per timeframe plus the daily ATR, in one pass."""
    series = {tf: [] for tf, _, _ in TIMEFRAMES}          # (uk_day, tod, o, h, l, c, minutes)
    cur = {tf: None for tf, _, _ in TIMEFRAMES}
    day_bar = None
    atr, atr_n, atr_acc, prev_close = None, 0, 0.0, None
    atr_at_day = {}                                        # uk_day -> ATR as of the previous day

    def close_day(db):
        nonlocal atr, atr_n, atr_acc, prev_close
        _, hi, lo, cl = db
        tr = hi - lo if prev_close is None else max(hi - lo, abs(hi - prev_close), abs(lo - prev_close))
        prev_close = cl
        if atr_n < ATR_DAYS:
            atr_acc += tr
            atr_n += 1
            if atr_n == ATR_DAYS:
                atr = atr_acc / ATR_DAYS
        else:
            atr = (atr * (ATR_DAYS - 1) + tr) / ATR_DAYS

    for uk, o, h, l, c in stream_rows(symbol):
        day, tod = divmod(uk, 1440)
        if day_bar is None or day_bar[0] != day:
            if day_bar is not None:
                close_day(day_bar)
            day_bar = [day, h, l, c]
            atr_at_day[day] = atr                          # ATR from completed days only
        else:
            day_bar[1] = max(day_bar[1], h)
            day_bar[2] = min(day_bar[2], l)
            day_bar[3] = c
        for tf, mins, _ in TIMEFRAMES:
            start = tod - tod % mins
            b = cur[tf]
            if b is None or b[0] != day or b[1] != start:
                if b is not None:
                    series[tf].append(tuple(b))
                cur[tf] = [day, start, o, h, l, c, 1]
            else:
                b[3] = max(b[3], h)
                b[4] = min(b[4], l)
                b[5] = c
                b[6] += 1
    for tf, _, _ in TIMEFRAMES:
        if cur[tf] is not None:
            series[tf].append(tuple(cur[tf]))
    if day_bar is not None:
        close_day(day_bar)
    return series, atr_at_day

# ---- statistics ---------------------------------------------------------------------------------
def gammp(a, x):
    """Regularized lower incomplete gamma; series below the crossover, continued fraction above."""
    if x <= 0:
        return 0.0
    lead = math.exp(-x + a * math.log(x) - math.lgamma(a))
    if x < a + 1:
        ap, s, dl = a, 1.0 / a, 1.0 / a
        for _ in range(500):
            ap += 1
            dl *= x / ap
            s += dl
            if abs(dl) < abs(s) * 1e-16:
                break
        return min(1.0, s * lead)
    b, c, d = x + 1 - a, 1e300, 1.0 / (x + 1 - a)
    hh = d
    for i in range(1, 500):
        an = -i * (i - a)
        b += 2
        d = an * d + b
        if abs(d) < 1e-300:
            d = 1e-300
        c = b + an / c
        if abs(c) < 1e-300:
            c = 1e-300
        d = 1.0 / d
        dl = d * c
        hh *= dl
        if abs(dl - 1) < 1e-16:
            break
    return max(0.0, 1 - lead * hh)

def pois_upper(c, lam):
    """P(X >= c) for Poisson(lam). The count is inside its own tail, as CLAUDE.md 3.2 insists."""
    return 1.0 if c <= 0 else gammp(c, lam)

def bh_cutoff(ps, q):
    """Benjamini-Hochberg p cutoff at rate q; -1 when nothing passes."""
    s = sorted(ps)
    n = 0
    for i, p in enumerate(s):
        if p <= q * (i + 1) / len(s):
            n = i + 1
    return s[n - 1] if n else -1

def quantile(xs, q):
    if not xs:
        return 0.0
    s = sorted(xs)
    if len(s) == 1:
        return s[0]
    pos = q * (len(s) - 1)
    lo = int(pos)
    hi = min(lo + 1, len(s) - 1)
    return s[lo] + (s[hi] - s[lo]) * (pos - lo)

def measure(series, atr_at_day, tf, mins, nslots, th):
    """Per slot: trending share, range as a share of the daily ATR, turn counts and tiers.

    Pass A calls this with th = None to collect the |dEMA|/ATR sample the threshold is fitted from;
    pass B calls it with the fitted number and everything else follows.
    """
    bars = series[tf]
    fitting = th is None
    on, off = ((th * ON_RATIO, th * OFF_RATIO) if not fitting else (float('inf'), float('inf')))
    dnorm = []
    ema, state, prev_ema, n_seen = None, 0, None, 0
    trend_hits = [0] * nslots
    day_count = [0] * nslots
    turns = [0] * nslots
    ranges = [[] for _ in range(nslots)]
    seen_days = set()
    for day, tod, o, h, l, c, minutes in bars:
        # EMA of the timeframe's own closes, across the whole history, not just the session.
        if n_seen < MA_LEN - 1:
            ema = c if ema is None else ema + (c - ema) / (n_seen + 1)
            n_seen += 1
            prev_ema = ema
            continue
        if n_seen == MA_LEN - 1:
            ema = ema + (c - ema) / MA_LEN
            n_seen += 1
            prev_ema = ema
            continue
        prev_ema = ema
        ema = ema + (c - ema) * 2.0 / (MA_LEN + 1)
        atr = atr_at_day.get(day)
        if not atr or atr <= 0:
            continue
        d = ema - prev_ema
        sgn = 1 if d > 0 else -1 if d < 0 else 0
        keep = state != 0 and sgn == state and abs(d) >= off * atr
        new_state = state if keep else (sgn if abs(d) >= on * atr else 0)
        turned = new_state != state
        state = new_state
        if day < FROM_DAY:
            continue
        if not (SESSION_MIN <= tod < SESSION_MIN + SESSION_LEN):
            continue
        slot = (tod - SESSION_MIN) // mins
        if slot >= nslots:
            continue
        # A slot counts only when the minutes are mostly there and the bar moved.
        if minutes < mins * 0.5 or h <= l:
            continue
        day_count[slot] += 1
        seen_days.add(day)
        dnorm.append(abs(d) / atr)
        if not fitting and abs(d) >= th * atr:
            trend_hits[slot] += 1
        if turned:
            turns[slot] += 1
        ranges[slot].append((h - l) / atr)
    if fitting:
        return {'dnorm': dnorm}
    total_turns = sum(turns)
    lam = total_turns / nslots if nslots else 0.0
    ps = [pois_upper(turns[k], lam) if lam > 0 else 1.0 for k in range(nslots)]
    cut = bh_cutoff(ps, FDR) if lam >= MIN_LAM else -1
    mid = bh_cutoff(ps, MID_FDR) if lam >= MIN_LAM else -1
    return {
        'trend': [round(trend_hits[k] / day_count[k], 3) if day_count[k] else 0 for k in range(nslots)],
        'vol': [round(quantile(ranges[k], 0.5), 4) for k in range(nslots)],
        'volHi': [round(quantile(ranges[k], 0.9), 4) for k in range(nslots)],
        'turns': turns,
        'turnRatio': [round(turns[k] / lam, 2) if lam > 0 else 0 for k in range(nslots)],
        'tier': [2 if (cut >= 0 and ps[k] <= cut) else 1 if (mid >= 0 and ps[k] <= mid) else 0 for k in range(nslots)],
        'p': [round(ps[k], 5) for k in range(nslots)],
        'n': day_count,
        'lam': round(lam, 2),
        'days': len(seen_days),
        'first': min(seen_days) if seen_days else 0,
        'last': max(seen_days) if seen_days else 0,
    }

# ---- run -----------------------------------------------------------------------------------------
todo = [(g, l, s) for g, l, s in INSTRUMENTS
        if (not ONLY or s in ONLY) and glob.glob(os.path.join(DATA_DIR, f'hist_{s}_*.zip'))]
skipped = [l for g, l, s in INSTRUMENTS
           if (not ONLY or s in ONLY) and not glob.glob(os.path.join(DATA_DIR, f'hist_{s}_*.zip'))]

# Pass A — what does a typical overnight bar's MA move look like on each chart? The threshold is
# the median across every instrument, so one number per timeframe serves the whole page and the
# instruments stay comparable with each other.
print('fitting thresholds…')
samples = {tf: [] for tf, _, _ in TIMEFRAMES}
for group, label, symbol in todo:
    series, atr_at_day = build(symbol)
    for tf, mins, nslots in TIMEFRAMES:
        samples[tf].extend(measure(series, atr_at_day, tf, mins, nslots, None)['dnorm'])
    del series, atr_at_day
TH = {tf: round(quantile(samples[tf], 0.5), 5) for tf, _, _ in TIMEFRAMES}
for tf, _, _ in TIMEFRAMES:
    print(f'  {tf}: threshold {TH[tf]:.5f} of a daily ATR, from {len(samples[tf]):,} bars')
del samples

rows = []
for group, label, symbol in todo:
    series, atr_at_day = build(symbol)
    row = {'group': group, 'label': label, 'symbol': symbol, 'tf': {}}
    for tf, mins, nslots in TIMEFRAMES:
        row['tf'][tf] = measure(series, atr_at_day, tf, mins, nslots, TH[tf])
    days = row['tf']['30m']['days']
    tr = row['tf']['30m']['trend']
    print(f"{label:<14} {days:>4} days | 30m trend {min(tr):.2f}-{max(tr):.2f} "
          f"vol {min(row['tf']['30m']['vol']):.3f}-{max(row['tf']['30m']['vol']):.3f} "
          f"turns/window {row['tf']['30m']['lam']:.1f} "
          f"| 1h lam {row['tf']['1h']['lam']:.1f} | 4h lam {row['tf']['4h']['lam']:.1f}")
    rows.append(row)

def iso(day_int):
    return (date(1970, 1, 1) + timedelta(days=day_int)).isoformat() if day_int else ''

firsts = [r['tf']['30m']['first'] for r in rows if r['tf']['30m']['first']]
lasts = [r['tf']['30m']['last'] for r in rows if r['tf']['30m']['last']]
meta = {
    'session': '00:00–08:00 UK',
    'from': iso(min(firsts)) if firsts else '', 'to': iso(max(lasts)) if lasts else '',
    'timeframes': [{'key': tf, 'minutes': mins, 'slots': n} for tf, mins, n in TIMEFRAMES],
    'trendRule': {'maLen': MA_LEN, 'atrDays': ATR_DAYS, 'fitted': TH,
                  'fittedAs': 'median |dEMA| / daily ATR over every instrument and session slot'},
    'turnRule': {'onRatio': ON_RATIO, 'offRatio': OFF_RATIO,
                 'on': {tf: round(TH[tf] * ON_RATIO, 5) for tf, _, _ in TIMEFRAMES},
                 'off': {tf: round(TH[tf] * OFF_RATIO, 5) for tf, _, _ in TIMEFRAMES}},
    'fdr': FDR, 'midFdr': MID_FDR, 'minLam': MIN_LAM, 'minN': MIN_N,
    'unavailable': ['Wall Street', 'Chicago Wheat'],
    'source': 'histdata.com M1, converted to UK local time',
}
json.dump({'meta': meta, 'rows': rows}, open(OUT, 'w'), separators=(',', ':'))
print(f'\nwrote {OUT}: {len(rows)} instruments' + (f'; no data for {", ".join(skipped)}' if skipped else ''))
