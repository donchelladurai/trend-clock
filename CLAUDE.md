# TrendClock

Static files, no build, no dependencies on the page: `index.html` (the board), `brief.html` (news
spikes), `swing.html` (the overnight session), `news.js` (shared feed logic). One optional local
process, `tools/live.js`, feeds the board live bars; without it the board is a climatology.

Since 13 Oct 2026 the board answers three questions about 21 instruments (and four composites) on
each of the three charts the owner day-trades — **15-, 5- and 2-minute** — across the 08:00–21:00 UK
trading day cut into 52 fifteen-minute windows:

- **Blue heat strip** — on what share of days was the 20-period SMA *trending* in this window?
- **Orange bar strip** — how often did a trend *start or stop* here (a "turn"), and is that more
  than ordinary variation for this row?
- **Live state** (dashboard, with the helper running) — is the 20SMA moving *now*, on which chart,
  and what did bars in this state do next: a turn within 15 or 30 minutes, a trend starting, the
  next window trending.
- **Market Close** (since 22 Oct 2026) — on the day being traded, how often did the last 90 and the
  final 15 minutes of the cash session follow or reverse the day's 20SMA trend, on the six index
  rows (§12).

**The average is the simple one.** The owner's charts carry the 200, 20 and 8 SMA and never an EMA;
every trending flag, turn, tier, live state and table on the board is the 20SMA's since 22 Oct
2026. The board reads the 20 alone: the 8 is the owner's power-trend average and the 200 a bias, and
neither predicts trends (owner, 22 Oct 2026). From 16 Sep to 22 Oct 2026 it was a 20EMA, inherited from the pre-repo generator the first
pipeline was calibrated against and never chosen against the SMA. At a matched threshold the two
states never oppose each other and coincide on about three quarters of state bars; the SMA turns
15–25% less often (§1b). Figures in this file dated before 22 Oct 2026 were measured on the EMA and
say so where it matters.

Everything on the climatology side is precomputed into three literals near the top of the
`<script>` — `BOARDS` (three boards) and `LIVE` (the live layer's constants and lookup tables),
written by `tools/build_board.js` from 1-minute data (§1b), and `CLOSE` (the Market Close table),
written by `tools/close_study.js` (§12). The page derives every statistic from them at load.

**What the board is worth was measured, not assumed (§7).** On a held-out day the climatology has
small skill on any chart (Brier skill 0.06–0.11, AUC 0.65–0.72 on the 2-minute chart; about 0.01
on the 15-minute), a solid-orange turn window holds a turn on about one day in three, and nothing
on the board says which way price goes next. The live 20MA state carries three to five times the
information. That is why the dashboard leads with the live state and the climatology is context.
(Measured on the 20EMA on 13 Oct 2026; the weekday-pooled checks were re-run on the 20SMA on 22
Oct and agree, the forward-in-time study has not been re-run.)

---

## 1. Data contract

### `BOARDS` — `{ "15": board, "5": board, "2": board }`, each `{ ROWS, TURNC, GROUPS, from, to, th }`

`ROWS` — 25 entries per board, one per row:

```js
{
  group: "Indices" | "FX — USD pairs" | "FX — EUR crosses" | "FX — other crosses" | "Commodities",
  label: "EUR/USD",
  big:   true,            // drawn larger. NOT the same as "is a composite" — see §4
  closed: [bool × 52],    // true where this instrument is not trading in window k
  days:  { "0".."4": n, all: n },   // valid days behind each profile
  data:  { "0".."4": {s,t}, all: {s,t} }
}
```

- `s[k]` — share of days the 20SMA was trending in window `k`. A proportion, 2 decimal places.
- `t[k]` — **turn ratio**, normalised so its mean over that row's *open* windows is exactly 1.0.
  2 decimal places. It is a ratio to the row's own day, never a comparison between instruments.
- Profile keys: `"0"`–`"4"` are Mon–Fri, `"all"` is the row's whole sample. On this board the
  all-days profile holds 125–129 weekdays (Wall Street 95, §1b) and a weekday profile 24–26
  (Wall Street 17–20). **Only the all-days profile carries turn statistics on the page** (§3.3).

`GROUPS` — 5 entries `[name, guideLines, minutesPerBar]`; the guide lines are minutes from 08:00
and the third element is the board's chart, printed in each section heading ("5-minute chart").

`TURNC` — 25 × 6 integers: total turn count per row per profile, `[Mon, Tue, Wed, Thu, Fri, all]`.
`t` alone is a ratio and carries no sample size; `TURNC` is what makes the significance layer
possible (§2).

### `LIVE` — the live layer's constants (`data/live_tables.json` is the same object)

```js
{ built, ma: "sma20", th: {15, 5, 2}, L: {15: 1, 5: 3, 2: 8}, def: {agg, side, horizon},
  atr: { "EUR/USD": {atr, asOf}, ... },      // 14-day daily ATR at the end of the sample: the fallback scale
  regime: { "2": { "EUR/USD": {turns, share, days}, ... }, ... },   // last 4 weeks of the sample over the window, as ratios
  tables: { "2": { rEdges, ageEdges, r5Edges, turn, start, next, turnMarg, startMarg }, ... } }
```

- `turn[r][age][side]` = `{n, p15, p30}`: P(turn within 15 / 30 minutes | in a trend state), by
  slope-ratio bucket `r` (edges `[0, .5, .75, 1, 1.5, 2, 3)`), age in bars (`[1, 3, 6, 11, 21)`)
  and whether the close sits on the trend's side of the 20SMA (`side` 1) or against it (0).
- `start[r5][dir][age]`: P(a trend state starts within 15 / 30 minutes | flat), by `r` (edges
  `[0, .5, .75, 1, 1.5)`; a flat state has `r < 2` by construction), slope rising (1) or falling (0),
  and age.
- `next[r][tertile]` = `{n, p}`: P(the next window is trending | r now, the next window's all-days
  share tertile within the row).
- `turnMarg[r][side]`, `startMarg[r5][dir]`: the same pooled over age; the page falls back to them
  where a cell holds fewer than 300 bars (§4).

Pooled over the 20 histdata instruments and every valid day from 26 Jan 2026 to the end of the
sample: the tables describe the chart rule, not the quarter (the two halves of the year agree to
0.013 on average, §7).

### `CLOSE` — the Market Close table (`data/close_table.json` is the same object)

```js
{ built, sample: {from, to}, windows: [90, 15], ma: "sma20", th: {2, 5}, def: {...},
  rows: [ { label: "Europe", market: "Europe", pooled: 3, data: { "2": { "90": { all: cell, "0".."4": cell }, "15": {...} }, "5": {...} } },
          { label: "FTSE 100", market: "Europe", data: {...} }, ... ] }   // cell = [follow, reverse, closeFlat, noDayTrend, lo95, hi95]
```

Eight rows: the Europe and US pools, each followed by its three indices. A cell counts, over all
days or one weekday, the days on which the window's net price move had the sign of the day's 20SMA
trend-state balance (follow) or the opposite (reverse); the interval is Wilson for one index and
date-clustered for a pool (§12). Written by `tools/close_study.js`, which also keeps the per-day
records in `data/close_study.json`.

### Invariants — all hold on every board; a rebuild must preserve them

| # | Invariant | Status (22 Oct 2026, 20SMA) |
|---|---|---|
| 1 | `TURNC[i][5] === sum(TURNC[i][0..4])` | 25/25 on each board (`build_board.js` checks it) |
| 2 | Composite `TURNC` == sum of its constituents, in all 6 profiles | exact by construction |
| 3 | `sum(t[k])` over open windows == number of open windows | worst deviation 0.13 against a 2dp rounding budget of 0.26 |
| 4 | Open windows: 52 on every row | derived from the feed by the generator |
| 5 | `lambda < 100` on every row (count recovery exact, §2) | largest USD pairs 82.3 (2-minute); 54.8 (5-minute); 28.5 (15-minute) — recovered counts match `meta.counts` in all 7800 cells of each board (on the EMA they were 87.9 / 67.4 / 45.2) |

**Composite membership** (used by invariant 2, and derived at runtime — §3.5):

- `Europe` = FTSE 100 + Germany 40 + France 40
- `US` = Wall Street + US Tech 100 + US 500
- `USD pairs` = EUR/USD, GBP/USD, AUD/USD, USD/CAD, USD/JPY, USD/CHF, NZD/USD
- `EUR crosses` = EUR/GBP, EUR/AUD, EUR/JPY, EUR/CAD, EUR/CHF, EUR/NZD

A composite's `s` is the mean of its constituents' `s` (2dp), its counts are their **sum**, its
`days` is the **rounded mean** of their day counts, and it is closed only where every constituent
is. So `TURNC / days` for a composite is turns per day *across several instruments* and can
exceed 1 — USD pairs reaches 1.34 on the 2-minute chart, EUR crosses 1.21, US 0.90. Never read it as
a probability. See §3.6.

### 1b. The generator in `tools/`

**Sources.** histdata.com 1-minute bid bars for the 14 FX pairs, the five European and US index
CFDs (UKXGBP, GRXEUR, FRXEUR, NSXUSD, SPXUSD) and Spot Gold (XAUUSD). Dukascopy's datafeed for
**Wall Street** (USA30IDXUSD, 1-minute BID candles, UTC, prices ×1000), because histdata has no
Dow. Both are free and unauthenticated; Dukascopy is slow and unreliable (one day file per
request, long runs of 503s and handshake timeouts — a day range needs several resumable runs) and
pads closed markets with placeholder minutes, which `duka2bars.py` drops.

**histdata's clock — the trap that cost the first build.** The site calls its stamps EST, but
the offset follows the UK/European clock change, not the American one: a stamp is always
**Europe/London local time minus five hours**. A fixed +5 h lands every summer bar an hour late;
the first build (22 Sep 2026) was caught by review. `hist2bars.py` converts raw + 5 h as London
time with the UK rule written out (Windows Python ships no zone database); `gen_swing.py` has the
same fix. Check any new converter against NFP (12:30 UTC) or the London open.

**histdata's partial month — the trap that cost the second build.** A month zip fetched mid-month
stays partial on disk, and until 13 Oct 2026 the fetcher refetched only the last month of its plan;
every bar file lacked 21–30 Sep 2026 and the first October study ran on 27 test days instead of 35.
`fetch_histdata.js` now refetches the **last two months** of its plan on every run (an older zip is
kept only when histdata has nothing larger). Fri 25 Sep 2026 is absent from histdata itself.

**Missing instruments.** `build_board.js` names an instrument whose bar file is absent and leaves
it off that board; a composite then sums the constituents it has.

- **Chicago Wheat** — no free intraday source reaches back six months. The manifest entry points
  at `data/wheat_m{15,5,2}.json`; drop bar files of the same shape there and the row returns.
- **Wall Street** — on the board with 95 days (26 May – 9 Oct 2026) against the others' 125–129,
  because Dukascopy's feed starts on 25 May in this repo. Its server refused most of 21 Sep – 12 Oct
  for an hour on 13 Oct 2026; a loop of resumable re-runs with two-minute pauses got every weekday
  in the end. Expect the same on the next refresh. Re-run `tools/fetch_dukascopy.py` (it skips what is on disk and names what it
  could not get), convert, and rebuild.

**Bars.** `tools/hist2bars.py` and `tools/duka2bars.py` write `[utc_ms, o, h, l, c, real]` at 2, 5
or 15 minutes, buckets aligned to the UTC clock, gaps of up to 20 hours inside a trading week
filled flat at the previous close with `real = 0`.

**Definitions** (`tools/gen_row.js`; constants at its top, thresholds per chart in
`tools/build_board.js`). One rule for every chart, in units of the instrument's own daily range:

| Term | Rule |
|---|---|
| MA | 20-period **simple** moving average of the bar closes, on the continuous series (weekend gaps ignored). Never an EMA: the owner's charts carry the 200, 20 and 8 SMA (22 Oct 2026); the 20EMA of 16 Sep – 22 Oct 2026 was inherited, not chosen |
| scale | 14-day Wilder ATR of UK-calendar-day bars, from completed **trading** days only: Mon–Fri with at least six hours of real bars; the previous close in the true range is the previous *trading* day's |
| move | `d[t] = MA[t] − MA[t−L]`, the MA's move over the last 15 minutes of clock time: `L = round(15 / minutes)` — 1 bar on the 15-minute chart, 3 on the 5-minute, 8 (16 min) on the 2-minute |
| trending | bar: `abs(d) ≥ TH × scale`; window: any of its bars is trending (`agg: any`) |
| TH | **0.0105 on the 15-minute chart, 0.0204 on the 5-minute, 0.0365 on the 2-minute** — fitted, see below (the EMA's were 0.0101 / 0.0204 / 0.0357) |
| trend state | +1 / 0 / −1 with hysteresis: enter at `abs(d) ≥ 2 TH × scale`, hold while the sign is unchanged and `abs(d) ≥ 0.5 TH × scale`; a ±1 → ∓1 flip in one bar is one turn |
| turn | every bar at which the state differs from the bar before, counted in that bar's window |
| open window | at least half of the window's bars are real on at least half of the Mon–Fri days in range |
| valid day | Mon–Fri UK; every board bar on the grid; at least 90% of the bars in open windows real; at least half of those bars move |

`gen_row.js` also accepts `agg: majority | all`, `side` (close on the slope's side) and
`horizon` (the move over 2 × 15 minutes); the study measured them and the board uses none (§6).

**The thresholds are fitted to one intensity, and the intensity is a product choice.** `tools/fit_th.js`
solves, per chart, the threshold at which the chart calls a given pooled share of windows trending
over the 20 histdata instruments and every valid day from 26 Jan 2026 (the first 14 trading days of
the files have no ATR and must be excluded, or they deflate every share). The board ran at the
5-minute chart's share at 0.015 — about 0.59 on live days — until 13 Oct 2026; it now runs at
**0.45** (`node tools/fit_th.js --share 0.45`, which records the fit in **`data/th_fit.json`** under
`sma20`, where `build_board.js` and `close_study.js` read it; `--maLen` fits another length for
research only), so "trending" means a 20SMA move of 3.7%
of a day's range in 16 minutes on the 2-minute chart, 2.0% in 15 minutes on the 5-minute, 1.1% in a
bar on the 15-minute. The study found skill unchanged between shares 0.55 and 0.35 (§7); the rarer
definition was chosen so that a lit cell and a live "trending" mean a move worth the name, at the
cost of fewer cells at the 65–75% control and a lower absolute chance behind each orange bar (the
critic's reservation, §7). Per-instrument shares at the pooled threshold run 0.35–0.53 (USD/JPY,
EUR/JPY, AUD/JPY and Spot Gold lowest; FTSE 100, France 40, USD/CAD, EUR/CAD, EUR/GBP highest);
ratios 2-minute/5-minute 1.79, 15-minute/5-minute 0.51.

**Sample.** **13 Apr – 9 Oct 2026, 26 weeks**, on every row (Wall Street from 26 May, 95 days). 125–129
weekdays per histdata row (holidays and dead-feed days removed by the validity rule; Fri 25 Sep is
missing from histdata; US rows lose 3 Jul and 7 Sep), 24–26 per weekday. Twenty-six weeks because
the study found the profiles stationary across 2026 and skill still rising, slightly, from 13 to 26
weeks (§7); the rarer definition keeps every composite's `lambda` under 100 at this length
(USD pairs 82.3 on the 2-minute chart with the 20SMA, 87.9 with the EMA — at the old intensity it
would have been 119 and broken §2).

**Pipeline** — from the repo root, node ≥ 18 and python 3:

```bash
for s in ukxgbp grxeur frxeur nsxusd spxusd xauusd eurusd gbpusd audusd usdcad usdjpy usdchf \
         nzdusd eurgbp euraud eurjpy eurcad eurchf eurnzd audjpy; do
  node tools/fetch_histdata.js $s 2026 2026 10 data        # yearly/monthly zips; refetches the last two months
  for m in 15 5 2; do python tools/hist2bars.py $s data data/${s}_m$m.json $m 2026; done
done
python tools/fetch_dukascopy.py USA30IDXUSD 2026-05-25 2026-10-12 data   # hours; resumable; re-run until it names nothing
for m in 15 5 2; do python tools/duka2bars.py USA30IDXUSD data data/usa30_m$m.json $m 1000; done
node tools/fit_th.js --share 0.45 --from 2026-01-26 --to 2026-10-09      # only if the intensity or the sample changes materially; writes data/th_fit.json (sma20)
node tools/build_board.js [--from 2026-04-13 --to 2026-10-09]             # thresholds from data/th_fit.json unless --th15/--th5/--th2 override
node tools/close_study.js                                                 # the Market Close table (CLOSE literal, data/close_table.json) and data/close_study.json
node tools/board_stats.js                                                 # every board-level figure the comments cite, per chart
node tools/loo_harness.js                                                 # leave-one-weekday-out and null simulation, per chart
```

`build_board.js` writes `data/rows/m{15,5,2}/<slug>.json` (the committed record of every row, with
the exact per-window counts under `meta.counts`), `data/rows/_board.json`, `data/live_tables.json`,
and the `BOARDS` and `LIVE` literals; `close_study.js` writes the `CLOSE` literal. The zips, `.bi5`
files and bar files are not committed (`.gitignore`).

---

## 2. Counts are recovered, not stored per window

```js
lambda = TURNC[i][mode] / openWindows        // expected turns per window if the day were flat
c[k]   = Math.round(t[k] * lambda)           // the integer count behind the window
```

Exact wherever one count moves `t` by more than the 0.01 rounding step, i.e. `lambda < 100`.
Every row on every board is below that (invariant 5) and the recovered counts match the generator's
`meta.counts` in all 7800 cells per board (`board_stats.js` checks it). If a longer sample or a
busier definition ever pushes a composite past 100, shorten the window or raise the threshold:
the 12-month board once ran USD pairs at 258 and 57 of 7746 windows came back one turn off.

---

## 3. The algorithm, in order

The statistics layer is `analyse(ROWS, TURNC)` in `index.html`, run once per board; `B[ch]` holds
each board with its `TURN`, `COMPOSITE`, `AGG_CUT`, `ROW_INS` and `index` (label → row).

### 3.1 Dispersion `phi` — `dispersion(r, idx, TURNC)`

Pearson chi-square of the row's counts split across the five weekday columns, over
`4 × (used − 1)` degrees of freedom. Windows whose 5-weekday total is under 5 are skipped.

**It is not a dispersion estimator, despite the name.** It is a weekday × slot *interaction*
statistic: it diverges with sample length under fixed weekday structure (1.23 / 2.16 / 6.99 at
10 / 52 / 260 days per weekday on simulated data with a 15% pattern) and is blind to whole-day
clustering (0.96–1.01 against true dispersion 1.4–6.8). It survives in the significance tests only
because both errors push the same way there: a too-large `phi` widens the tail and under-flags.
**Do not reuse it anywhere that direction is not safe** — it was in `pTurn` once and understated
the printed figure by up to 17.9 points. Returns `phi` (clamped `>= 1`, for the per-window tail) and
`raw` + `dfPhi` (unclamped, for the omnibus); they are not interchangeable.

Observed on this board (26 weeks, 20SMA): singles 1.00–1.32 on the 15-minute chart (14 of 21 at
1.00), 1.00–1.18 on the 5-minute (14 at 1.00), 1.00–1.14 on the 2-minute (13 at 1.00); composites
Europe 1.12 / 1.34 / 1.40, US 1.45 / 1.32 / 1.53, USD pairs 1.57 / 1.69 / 2.47, EUR crosses 1.00 /
1.02 / 1.47 (15- / 5- / 2-minute). The longer history has inflated the composite values as §3.1
predicts (USD pairs was 1.68 on the 13-week board), which makes the composite tiers more
conservative; the critic of the October study flagged it, and it is accepted as the price of 26
weeks.

### 3.2 Per-window p-value — `poisUpper(c, lam, phi)`

`P(X >= c)` for a quasi-Poisson with `Var = phi·mu`, computed as `gammp(c/phi, lam/phi)` — the
regularized lower incomplete gamma, series below the crossover and continued fraction above.
Verified against direct tail summation to a relative error of 1.6e-10 (study F).

**Two bugs lived here historically; do not reintroduce either.** Summing the CDF and returning
`1 − s` loses the far tail to cancellation, and for integer `c` silently computes `P(X > c)`.

### 3.3 Tiers — the bar colours, on the all-days profile only

Within each **row** family (52 windows), on the all-days profile:

| Tier | Rule | Constant | Appearance |
|---|---|---|---|
| 2 | `p <= ` BH cutoff at 10% FDR | `FDR = 0.10` | solid bright orange |
| 1 | `p <= ` BH cutoff at 40% FDR, not tier 2 | `MID_FDR = 0.40` | dim bar with a light cap |
| 0 | neither | — | plain brown |
| — | `lambda < MIN_LAM` → no tier at all | `MIN_LAM = 1` | hatched, "too few to read" |

`bhCutoff` returns **−1** when nothing passes, so a legitimate cutoff of exactly 0 stays
distinguishable from "no rejections". Do not restore a `cut > 0` guard.

**Weekday profiles carry no tiers and no printed turn figure (13 Oct 2026).** The page computes them
(`TURN[i]["0".."4"]`, used by `board_stats.js` and `loo_harness.js`) but `applyMode` draws a weekday
profile's bars hatched, at their ratio height, with no tier colour and no figure; the chips, the
dashboard and the readout take their turn statistics from `TURN[i].all` whatever heat profile is
shown, and the "Turn spike now" row says "(all-days tiers)" on a weekday profile. The reason is
measured (§7): at 13 days per weekday the weekday tiers fired 0.29 windows per instrument-day
printing a 0.48 chance and delivering 0.33, with no lift at all on FX, and at 24–26 days they are
still a sparse, over-printed subset of the all-days tiers. The all-days profile is where the
statistics live; the weekday heat strip is an overlay with its ±17pp interval.

Current board (20SMA), all six profiles computed, all-days drawn: **15-minute 36 red / 54 capped
on all-days (48 / 101 over all profiles), 5-minute 77 / 95 (122 / 226), 2-minute 191 / 124 (336 /
439)**; every row marked on the 5- and 2-minute boards, 22 of 25 on the 15-minute (AUD/USD, EUR/AUD
and EUR/NZD blank). The FDR bound `sum(m × cut)` over firing families is 4.6% / 5.3% / 6.3% of the
red marks. The EMA board had more of everything (68 / 71, 131 / 99, 195 / 108 on all-days) because
the EMA turned 15–25% more often.

`MIN_LAM = 1` now guards only the all-days profiles, where the smallest `lambda` is 3.1 (Spot Gold,
15-minute), so it never fires there; the weekday families under it are hatched anyway — 74 of 105
single-instrument ones on the 15-minute chart, where a weekday column holds 0.4–1.3 turns per
window on the SMA, 9 on the 5-minute, 1 on the 2-minute. The null simulation (§7) shows the
false-mark rate under flat noise does not move with `lambda` (3.2–6.2 red marks per board across
all six profiles against 48–336 real).

`MID_FDR = 0.40` is kept for coverage of the summary chips: the 40% tier is what lets USD/CHF-type
rows, whose evidence is spread thinly, reach the chips at all.

### 3.4 Row-level structure — `omnibusP(c, open, lam, phiRaw, dfPhi)`

Pearson chi-square of the counts against a flat `lambda`, referred to **F(df, dfPhi)** with
`df = openWindows − 1`. The F reference and the unclamped `phi` are a matched pair (clamping drags a
nominal 0.10 test to 0.076; unclamping alone overshoots to 0.13). Only `out.all.omni` is read;
`out.flat = out.all.omni > OMNIBUS` (`OMNIBUS = 0.10`) feeds tooltip prose **only** — it must
never gate which windows get marked (§6). On this board eight rows are flat on the 15-minute chart
(AUD/USD 0.64, EUR/NZD 0.36, EUR/AUD 0.18, AUD/JPY 0.16, USD/JPY 0.14, EUR/GBP 0.13, Spot Gold 0.13,
EUR/CAD 0.10 — the SMA turns less, and the 15-minute chart has the fewest turns to begin with), one
on the 5-minute (AUD/JPY 0.13) and none on the 2-minute; on the EMA none was flat anywhere.

### 3.4b The summary chips

The three lists at the top follow **both** marked tiers of the **selected panel's chart**, sorted
strongest-first, tier 1 drawn as an outlined chip. They read `tier[k] > 0` on the all-days
profile. 25 of 25 rows can reach the chips on the 5- and 2-minute boards, 21 on the 15-minute.

### 3.5 Composite detection — `COMPOSITE`

Derived, not hardcoded: a `big` row is a composite exactly when the shortest run of non-`big`
rows following it in its group has turn totals summing to its own. This excludes **Spot Gold**,
which is drawn `big` but is a real instrument. It depends on invariant 2 and on constituents
immediately following their composite in `ROWS` order, which `build_board.js` guarantees. All four
composites are complete on every board (3× / 3× / 7× / 6×).

### 3.6 The printed percentage — chance of at least one turn

The figure on each bar is `P(at least one turn in this window on a given day)`, with
`mu = c[k] / days`:

```js
pTurn = 1 - Math.exp(-mu)     // Poisson; deliberately does NOT use phi
```

**It is not `c/days`** — that is a rate and exceeds 1 on the busiest composite windows.

**Why no `phi`.** See §3.1. `1 − exp(−mu)` is by Jensen an **upper bound** on P(at least one) for
any mixed-Poisson day model. The study measured it held out: on flagged all-days windows of single
rows it is on or slightly above the observed rate (printed 0.30 against 0.30 observed at 13 weeks,
0.27 against 0.29 at 26 — slightly conservative), on the composites it is visibly a bound (USD
pairs printed 0.72 against 0.62 delivered on tier-2 windows, because the seven pairs' turns
co-move), and only on unflagged low cells does the held-out rate run a few points above it. Keep
the "up to" wording. The largest printed figure is 83% (on the 2-minute chart); the charts' maxima
are 67% / 75% / 83% (15- / 5- / 2-minute; on the EMA 76% / 85% / 90%). The dashboard prints the
row's flat-day figure beside it ("turn 32% (row 15%)") because a tier is a relative claim.

### 3.7 Other constants

- `AGG_Q = 0.85` — composite rows only: bright orange fill where `pTurn` reaches that percentile
  of **that row's own** all-days spread. Current cuts (15 / 5 / 2-minute, 20SMA): Europe 15 / 28 /
  41%, US 17 / 31 / 45%, USD pairs 25 / 43 / 66%, EUR crosses 24 / 43 / 61%, lighting 8–10 cells
  each on the all-days profile. **Do not generalise this to single instruments** (§6).
- `MIN_N = 10` — days below which a heat cell is hatched as a thin sample; no profile is thin on
  this board (weekday profiles hold 16–26 days). The `±` the readout prints beside every share
  carries the width: ±17pp on a weekday profile, ±8pp on all-days.
- Wilson intervals carry the heat strip; Byar's Poisson interval carries the bar tooltip (spanning
  1.0× on 63–91% of all-days windows depending on the chart, 93–97% of weekday ones).
- `TURN_RISK = 0.40`, `START_LIKELY = 0.30` — the live-layer levels at which a dashboard cell is
  outlined amber ("turn risk") or green ("start likely"); the figures themselves are always printed.
- `FRESH_SEC = 180` — a live instrument is fresh when its last bar is within 3 minutes plus the
  feed's declared delay; otherwise the cell falls back to the climatology and says how old the bars are.

---

## 4. What the page draws

- **Overview dashboard** (`#dash`, `buildDash` / `updateDash`): a grid of the 21 instruments by the
  three charts plus a news column, under three summary rows (one per chart) and a key. Each cell
  carries three lines. With fresh live bars: the live state — `▲ trending 1.6×` (a trend state with
  the slope at or above the threshold), `▲ trending · forming` (slope above the threshold, state not
  yet entered), `▼ trend fading 0.7×` (state held, slope under the threshold) or `— flat 0.3×` —
  then the lookup figure for that state (in a trend: turn within 15 and 30 minutes and the state's
  age; flat: a trend starting within 15 and 30 minutes and, in hours, the next window trending),
  then this window's history. Without live bars: the window's climatology (share, the turn figure
  with the row's flat-day figure, tier marks), coloured with the strip's heat ramp. Cells are
  outlined amber when the turn figure reaches `TURN_RISK`, green when a start reaches
  `START_LIKELY`, tagged with the news phase in effect (below), and carry the feed's delay or
  staleness. The slope ratio is floored to one decimal so `1.0×` always means at or above the
  threshold. The key says what "trending" means here: the 20SMA is moving; it says nothing about
  which way price goes next (§7).
- **Market Close** (`#close`, `buildClose` / `updateClose`, since 22 Oct 2026): under the dashboard,
  a grid of the six index rows under their Europe and US pools, by chart (2- and 5-minute) and window
  (the last 90 and the final 15 minutes of the cash session). Each cell: `follows 44% · reverses 56%`
  with the larger in bold, then the days behind it (instrument-days on a pool) and the ± half-width,
  then on the all-days profile the Mon–Fri follow shares and on a weekday profile the all-days
  figure. It follows the Day profile like the strips do ("for the day I'm trading" is Auto); a cell
  is outlined amber when its 95% interval excludes 50% and hatched under `MIN_N` days; the note
  names the profile and the per-cell day range, the footer the definitions. Data: the `CLOSE`
  literal (§1, §12). The strings live in `MV.close`.
- **Three panels** behind tabs (15-, 5-, 2-minute; the choice is kept in `localStorage`), each the
  familiar board: composite rows on their own band with a `N×` badge, section headings naming the
  chart, right-hand mirror labels at ≥1500px, a cursor readout and crosshair, `--pv` from the real
  column width, numbers only at `colWidth >= 26px`. The tab note prints the panel's sample, its
  threshold, the profile, and how the last four weeks of the sample compared with the window
  (`LIVE.regime`, shown and never applied — §6); on the 15-minute panel it adds that the
  time-of-day profile predicts little of a given day.
- **Day profile** defaults to **All**. `Auto` follows the real UK weekday (re-derived every tick,
  weekends fall back to all-days) and the Mon–Fri buttons pick a day; on any weekday profile the
  heat strip changes and the turn statistics stay on all-days (§3.3).
- **Trend if ≥** outlines every heat cell meeting the threshold, in every profile. Default **65%**
  since 13 Oct 2026 (it was 75% at the old intensity): at a pooled share of 0.45 a 65% cell is about
  1.45× the base, and the all-days 2-minute board holds 17 single-instrument cells at or above 75%,
  the 5-minute 5, the 15-minute none (27 / 9 / 0 on the EMA).
- **Preview time** with − and + buttons stepping one window; the dashboard shows the climatology of
  the previewed window and hides the live state while previewing.
- **Mini brief** (`#mini`): the greeting, what is trending at the threshold on the selected chart,
  which rows carry a turn spike now and next, the live sentence (what the live chart is trending on,
  where the slope is fading and how likely a turn is, where a trend may be starting; or that the
  live layer is dark), and the news calendar. Strings live in `MV`, chosen by weekday.
- **News on the board.** `news.js` fetches `data/ff_week.json`; today's high and medium windows are
  bands on every row the event hits (a composite carries its constituents'), two header rows list
  the windows overlapping now and next, and the dashboard's news column lists each instrument's
  phase in effect, then its next two events. **News phases** (`NEWS_RULES`, measured in §9b and
  kept only where they replicated): after a high-impact data print or a rate decision, `0–15 min`
  "turn risk ×3" (the 20MA turned 3.3–3.4× as often as usual and turned at all on 63–72% of charts)
  and `15–30 min` "post-release trend" (trending bars 1.6× usual, turn risk ordinary); during a
  speech, `0–15` no change and `15–30` "headline risk ×1.7" (one three-week sample); after a
  medium-impact release, `0–10 min` "release quiet ×0.5" (one sample). Minutes, statements and
  assessments are treated as speeches whatever the feed calls them. A phase is a tag and a tooltip
  sentence; it never alters the live figures, which are calibrated on all days. The multipliers were
  measured on the 20EMA state (§9b) and have not been re-measured on the SMA.
- **Live layer** (`loadLive`, `liveState`): every 20 s the page fetches `live.json` from its own
  origin when served by the helper, else `http://localhost:8787/live.json`. For each instrument and
  chart it takes the last 120 bars, computes the 20SMA, the slope `d = MA[t] − MA[t−L]`, `r = |d| / (th × ATR)`
  with the helper's ATR (fallback `LIVE.atr`), replays the hysteresis state and its age, reads the
  price side and whether `r` rose over the last `L` bars, and looks up `LIVE.tables` (§1). A lookup
  cell with fewer than 300 historical bars falls back to its age marginal, because the fresh-flat
  cells (a state a few bars old with the slope already at 1.5–2×) are V-reversals read through an
  unsigned slope and print figures no bar delivers. The header shows the feed's source, instrument
  count and oldest bar; a feed older than 15 minutes is "stale" and the cells fall back.
- `favicon.svg` is the board's own.

---

## 5. Refreshing the data

The sample is **13 Apr – 9 Oct 2026** on every row (§1b). histdata serves the current month a few
days behind and fills it in as the month goes on; the window can be moved forward whenever a new
full week is in.

### Step 1 — rebuild the rows

Run the pipeline in §1b with new `--from`/`--to` dates (keep whole weeks, Monday to Friday).
`build_board.js` checks invariants 1 and 3 and prints each row's days, turns a day and mean share;
read that output. A row with fewer days than the others has lost them to the validity rule or to a
feed gap — check the bars (the September 2026 hole was found by the study, not by the build) before
accepting it. Wall Street needs the Dukascopy pull to have reached the end of the window.

### Step 2 — what changes with the sample

Every statistic is derived at load. The thresholds need refitting only if the intensity is changed
or the sample moves materially (`fit_th.js` prints the per-instrument shares, which should stay
near 0.45 pooled, and writes `data/th_fit.json`, which `build_board.js` and `close_study.js` read).
A longer sample raises `lambda` (watch invariant 5) and the composite `phi` (§3.1). The live tables
are rebuilt from every valid day on disk by the same run; `close_study.js` must be re-run for the
Market Close table to follow the new bars.

### Step 3 — recompute every hardcoded figure

**This is where a refresh goes wrong.** The code comments and this file carry specific numbers
describing *this* sample. `node tools/board_stats.js` prints every board-level figure per chart
(tiers by class, the FDR bound, `lambda` and turns-per-day ranges, Wilson widths, the trending
share, `AGG_CUT`, the live tables and the regime ratios, count recovery); `node tools/loo_harness.js`
prints the held-out and null-simulation figures. A refresh is a diff against their output. The
figures in §3, §4 and §7 of this file are the ones to recompute; the study's out-of-sample
figures (§7) describe the method on the data of 2026 and should be re-run, not edited, if the
definition or the sample changes materially (`tools/eval_lib.js`).

---

## 6. Rejected approaches — do not reintroduce

Each was built, measured, and removed. The measurements are in §7 or in the code comments.

- **The weekday profile as the default, or weekday turn tiers.** Out of sample the same-weekday
  share predicts worse than the all-days share on 21 of 21 instruments in both test blocks (skill
  0.022 against 0.074), is over-confident by 13–21 points in its top bin, and no pseudo-count toward
  all-days ever beats plain all-days (m = 50 is a wash). Its tiers printed 0.48 and delivered 0.33.
- **A single pooled amplitude cutoff** for turn marks (the original rule): because `t` is
  normalised to mean 1.0 it ranks rows by dispersion, which is mostly sample noise. A single
  absolute level for the composite bright fill, and top-of-own-range highlighting on single
  instruments, fail the same way (the 12-month measurements are in the code comments).
- **Colouring single rows by `pTurn` instead of the tier.** An amplitude ranking (0.169 held-out lift
  against 0.399 for the test on the 12-month board), and `pTurn` is exactly the figure that over-prints
  where it would be read (weekday cells, composites). Print the base rate beside the tier instead.
- **An omnibus gate licensing bare per-window tests** (~312 uncorrected tests per gated row; 201
  false marks on the 12-month board against 20 for BH).
- **Using `phi` in the printed probability**, **`P(X > c)` as the p-value**, **summing the CDF**,
  **clamping `phi` inside the omnibus** — see §3.
- **One threshold on every chart.** The faster average moves more over 15 minutes; the thresholds
  are fitted to one pooled share per chart (§1b).
- **An EMA anywhere.** The owner's charts carry the 200, 20 and 8 SMA; a 20EMA defined the board
  from 16 Sep to 22 Oct 2026 by inheritance, and its turns came earlier and 15–25% more often than
  the turns on the owner's chart. `eval_lib.js` has no EMA path any more; do not add one back.
- **The 8SMA or the 200SMA in the trend definition.** The owner predicts trends on the 20SMA alone
  (22 Oct 2026): the 8 is a power-trend average, used only once a strong trend is running, and the
  200 a bias. Measured once in the close study before the ruling, an 8SMA state read the close no
  better than the 20's and the side of the 200 moved the price reading by at most two points (§12).
- **`majority` or `all` bars in the window, the price-side rule, or a 30-minute move** as the
  definition of trending. At matched rarity `any` is more predictable on every chart (2-minute skill
  0.095 against 0.053 for `majority` and 0.002 for `all`); `side` changes under 2% of windows and is
  an identity on the 15-minute chart; the 30-minute horizon is less predictable on every chart.
- **Recency weighting** — a 6-week window, a blend of 6 and 26 weeks, or scaling the profile's level
  or the turn rate by the last four weeks. The profiles are stationary across 2026 (temporal and
  interleaved split correlations within 0.03), a 6-week window loses to 13 on every chart (t 5–7),
  and a level adjustment lowers skill in 12 of 12 configurations: the recent deviation does not
  predict the next week's (r −0.12 to +0.20). `LIVE.regime` is shown, never applied.
- **Reading the 15-minute heat strip as a prediction, or the 15-minute turn tiers as a mark.** The
  15-minute time-of-day profile has skill 0.003–0.024 and AUC 0.56–0.57, its 75% cells deliver 0.70,
  and its tiers are right one time in five; the 15-minute state adds at most 0.005 to the 2-minute
  live read. The panel is a separate view; its value is the live state as context.
- **Treating the three panels as a confirmation stack.** The 15- and 5-minute states add at most
  0.015 to the 2-minute state's out-of-sample skill, and a 2-minute trend running *against* the
  15-minute state is more, not less, likely to show a trending next window (0.894 against 0.826),
  because "trending" is unsigned.
- **The pre-release lull and the post-release "turn risk ×0.4"** from the three-week news study:
  on the year's eight NFP releases the quarter-hour before a print ran at 0.68× turns (not a lull
  worth drawing) and minutes 15–30 at 1.18× (not 0.4×). The 15-minute news band as a turn signal:
  1.11× over 547 cells.
- **Requiring the hour before 08:00 on the grid**; **every UK calendar day in the ATR**; **a
  fixed +5 h on histdata's stamps**; **treating Dukascopy's placeholder minutes as bars**;
  **keeping old-definition rows alongside rebuilt ones**; **a 5-minute ATR(14) as the scale**;
  **scaling the threshold by `sqrt(minutes/15)`** — each is explained at the function or in §1b.

---

## 7. Verification, and what the board is worth out of sample

### 7a. The accuracy study of 13 Oct 2026

**Measured on the 20EMA the board carried at the time.** The 20SMA that replaced it on 22 Oct 2026
coincides with it on about three quarters of state bars at a matched threshold and never opposes
it, so these conclusions are expected to hold; the weekday-pooled checks at the end of §7 were
re-run on the SMA and agree, the walk-forward figures below have not been re-run.

Six studies on `tools/eval_lib.js` (A: the current board; B: definitions; C: history and profile;
D: the live state; E: news; F: an adversarial re-implementation that reproduced the committed rows
and every harness figure from the prose alone), then a critic who re-ran eleven analyses of his own.
Walk-forward: each test week predicted from the weeks before it; test blocks 24 Aug – 9 Oct and
15 Jun – 31 Jul 2026; 20 histdata instruments; Brier skill over a flat row, AUC, the observed rate
behind cells printed at or above 75%, and the held-out rate of at least one turn behind each tier.
Pooled figures carry day-clustered bootstrap intervals. The conclusions, in order of weight:

1. **The live state carries the information.** P(turn within 15 min | in a trend) from the slope
   ratio alone has out-of-sample Brier skill 0.175 / 0.228 / 0.154 (2 / 5 / 15-minute); adding the
   price side 0.251 / 0.259; the climatology tier alone 0.000. Price on the wrong side of the slope
   ends a 2-minute trend within 15 minutes 90–95% of the time. At window level the previous window's
   state scores 0.261 against the climatology's 0.074. The 15- and 5-minute states add ≤ 0.015.
2. **Nothing says which way price goes next.** Over 353,958 2-minute trend-state bars the close
   moved in the trend's direction over the next 30 minutes 49.3% of the time (48.3% at r ≥ 3, 48.9%
   in tier-2 windows, 49.0% with the 15-minute chart agreeing); MFE +0.081 ATR against MAE −0.079.
   "Trending" means the average is moving. The page says so in the dashboard key.
3. **The weekday profile was the one avoidable fault** (§6).
4. **A solid orange bar is a one-in-three event on the indices and one-in-four on FX.** Tier-2 hit
   0.318 against a base of 0.147 (n 1,383); held-out turn ratio 2.29. Tightening the FDR to 0.02
   raises the hit to 0.348 and cuts the flags by 45%; nothing lifts it above ~0.36–0.40 on an index.
   The enrichment is mostly trend **starts**: entries double in flagged windows at every slope ratio,
   while the flag adds nothing to whether a trend in progress ends.
5. **The climatology's ceiling is low and already reached.** All-days skill 0.074 (AUC 0.674); a
   profile fitted on the test weeks themselves reaches only 0.124 / 0.700; 75% cells deliver 0.80
   (indices 0.86, FX 0.75); the profile shape is stable (split-half 0.88 on the 2-minute chart, 0.73
   on the 5-minute).
6. **The 2-minute chart carries the most time-of-day signal for every class, FX included** (the 14
   FX pairs 0.085 mean skill on the 2-minute chart against 0.058 on the 5-minute, higher on 14 of 14);
   the 15-minute chart has essentially none.
7. **The definition is a presentation choice, not an accuracy one** (§1b, §6).
8. **History: 13 weeks is within 0.006 skill of anything longer; 6 weeks is not** (printed turn
   figures overstated by 4–14 points below 13 weeks); no recency weighting helps.
9. **News: the post-print burst replicates** (3.44× on eight NFPs, a turn on 72% of charts within 15
   minutes, 79% of those flat going in); the band and the "hold" do not (§4, §9b).
10. **Composites print high on FX** (USD pairs 0.72 printed against 0.62 on tier-2 windows); the
    average of a row's own profile and its group's beats its own by 0.003–0.008 (not implemented).

The critic's overrules that shaped the shipped design: no regime scaling; no weekday tiers or
printed figures; news rules trimmed to what replicated; lookup cells under 300 bars merged into
their marginals; 26 weeks kept only because the rarer definition keeps `lambda` under 100 (it would
not have at the old intensity). Not yet done, and worth knowing: a trade rule with stops and targets
on the live state (close-to-close shows no directional edge; a rule could still have one);
validation of the state shares on IG/ProRealTime bars; the UK/US clock-gap weeks (9–27 Mar 2026),
where the US rows' features land four windows early under the UK bucketing.

### 7b. The harness — `tools/eval_lib.js`

`load(sym, minutes, from, to)` prepares a bar file (cached); `outcomes(P, def)` gives per-day ×
per-window trending flags and turn counts under a definition; `fitTh(Ps, def, share)` solves a
threshold; `walkForward(O, {trainWeeks, testFrom, testTo, shrink, thr})` scores held-out weeks
(Brier skill, AUC, reliability, precision at the threshold, the tiers' held-out hit rates);
`splitHalf(O)` is the profile's reliability; `stateRows(O, {hBars})` tabulates the bar-level state
against the next 15 or 30 minutes; `bucket()` groups it. `node tools/eval_lib.js eurusd 5` prints a
demonstration. Start day ranges on or after 26 Jan 2026 (the first ATR); `walkForward` skips a test
week with no days without counting it, so read `weeksScored` and the day counts, not the brief.

### 7c. Load the statistics layer in node

`tools/page_stub.js` loads `index.html`'s script with a DOM stub and returns
`{BOARDS, LIVE, CLOSE, B, CHARTS, LABELS, ..., buildClose, updateClose}`; `board_stats.js`,
`loo_harness.js` and `gen_row.js --compare` use it. The stub drops the kick-off line `build();
buildDash(); tick(); setInterval(tick, 1000);` — keep that line exactly, or update the stub
(`buildClose()` is called from inside `buildDash()` for that reason).

### 7d. Render and inspect

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
node tools/live.js                      # optional: the live layer; then open http://localhost:8787/
"$CHROME" --headless --disable-gpu --dump-dom --virtual-time-budget=10000 \
  --window-size=2560,1400 "http://localhost:8787/index.html" > dom.html
```

To see a live weekday board out of hours, prepend a `<script>` that replaces `Date` with a
subclass whose no-argument constructor returns a fixed instant (the rig used on 13 Oct 2026 froze it
at Tuesday 13 Oct, 10:07 UK, and appended a probe that clicked the Auto profile and the 5-minute
tab before dumping the state; the 22 Oct rig did the same and wrote the Market Close section's cells
into a `<pre id="probe">`). Without the helper, `python -m http.server 8790` serves the repo well
enough for the dump. Opened from `file://` the news and live fetches are refused; the page then says
so rather than nothing.

### Checks that should pass after any change

| Check | Expected |
|---|---|
| Script parses | `new Function(scriptBody)` throws nothing |
| No runtime errors | dumped DOM contains no `Uncaught` / `ReferenceError` / `TypeError`; no `NaN` / `undefined` in the dashboard cells |
| Tooltips | 3900 bar tooltips and 3900 heat tooltips (3 boards × 25 × 52) |
| Weekday profile | 0 tier classes, 0 printed figures, every bar hatched on the selected panel; the turn chips carry "(all-days tiers)" |
| Printed % | every value `< 100%` |
| Tiers on closed/weak | **0**; tier 2 ⊂ tier 1's cut |
| CI vs verdict | **0** windows whose printed interval excludes 1.0× while the text says "within ordinary variation" |
| Dashboard | 63 cells, none `na` on a complete board; 63 live cells with the helper streaming; each live cell has three lines |
| Market Close | 32 cells, none `na`, no `NaN`; on a weekday profile the note names the weekday and each cell's third line carries the all-days figure; the `CLOSE` literal is found by `^const CLOSE = {...};$` |
| Section headings | each panel's sections name its chart |
| Composite badges | Europe 3×, US 3×, USD pairs 7×, EUR crosses 6× on every panel |
| Invariants | `build_board.js` prints invariant 1 ok and invariant 3 worst ≤ 0.26 on each chart; `board_stats.js` prints count recovery 0 of 7800 differ per chart and max `lambda` < 100 |
| Event clock | in the converted bars, NFP (first Friday, 12:30 UTC) and the London open (07:00 UTC in summer, 08:00 in winter) are the largest bars of their day |
| Live helper | `/live/status` shows 21 instruments streaming; the page's header reads "live tradingview · 21 instruments" |

### Held-out and null figures (`tools/loo_harness.js`, 22 Oct 2026, 20SMA)

Leave-one-weekday-out (train on 4 weekday columns, score on the 5th; `phi` from the training
columns only): tier 2 hit rate 84.5% / 85.0% / 86.3% (15 / 5 / 2-minute; 148 / 320 / 790 flags)
against 43–45% for a random window; mean lift 0.80–1.13; a budget-matched amplitude cutoff scores
73–84%. Null board (flat Poisson counts at each profile's real `lambda` through the real pipeline,
Mulberry32 PRNG): 3.2 / 6.1 / 6.2 red and 19 / 37 / 44 capped false marks per board over all six
profiles, against 48 / 122 / 336 red and 101 / 226 / 439 capped real. On the EMA (13 Oct) the same
check gave 81.7% / 84.2% / 87.5% on 262 / 474 / 833 flags and 5.2 / 6.8 / 6.6 red false marks
against 115 / 214 / 410 real. This is the weekday-pooled check the board has always had; the
forward-in-time figures are §7a.

---

## 8. Conventions

- Three pages, cross-linked in the header: `index.html` the board and dashboard, `brief.html` the
  news spikes, `swing.html` the overnight session (§10).
- All times are **UK clock time**. Slot `k` starts at `08:00 + 15k`. The EST toggle shifts labels
  only; the data is not re-bucketed. For the ~4 weeks a year when UK and US clocks are out of step,
  US-session features land four slots earlier than labelled (the study measured it: US Tech 100
  trends in the 13:30 window on 11 of 11 gap days against 0.67 of other days).
- Editing files from a shell: template literals, `×`/`—`, apostrophes and backslashes get mangled by
  bash quoting and heredocs in this harness. Put edit scripts in a file (the editor's write tool)
  and run them with node; `node tools/apply_edits.js edits.json` applies `{old, new}` pairs.
- Line endings: `.gitattributes` keeps every text file LF. The tools find the `BOARDS`, `LIVE` and
  `CLOSE` literals by exact anchors (`^const BOARDS = {...};$`, `^const LIVE = {...};$`, `^const CLOSE
  = {...};$`, one line each) and normalise CRLF on the way in. The `.vs/` workspace files are tracked
  and binary.
- Commits: local commits at each verified step, **one push per job** — every push costs the owner a
  Pages deploy and Actions minutes (22 Oct 2026). Pull with rebase before that push; the calendar
  workflow commits up to hourly in the trading day (§9).
- Prose is deliberately specific about uncertainty. If a change makes a stated number wrong,
  change the number — do not soften the sentence into something unfalsifiable.
- `README.md` is empty; this file is the documentation.

---

## 9. `brief.html` — news spikes for the week

A second static page, sharing `news.js` with `index.html` and linked from its header. It draws the
Mon–Fri news calendar as news-spike windows on a UK-time axis, one row per day, for the 22
instruments (its own list in `news.js`; it keeps Chicago Wheat), with a next-spike countdown,
today's windows, a compact line per other day, and a list of high-impact times for the
ProRealTime News Blackout indicator (12 slots).

**A spike window is not a blackout** (renamed 21 Sep 2026, at the owner's request): the window is
where the move is likely to fall, and the page exists so the owner knows it is coming. The one
place the old word survives is the heading **For the News Blackout indicator**, the indicator's own
name.

**Data.** `data/ff_week.json` is the Forex Factory weekly feed
(`nfs.faireconomy.media/ff_calendar_thisweek.json`), filtered to USD EUR GBP JPY CHF CAD AUD NZD CNY
and written by `tools/fetch_ff.js`. `.github/workflows/ff-calendar.yml` runs it **hourly from 08:00
to 16:00 UK on weekdays and twice in between, about 22:00 and 06:00 UK, every day** (since 22 Oct
2026; it ran every two hours around the clock before, 16 commits between 13 and 22 Oct), and commits
only when the events change — pull before pushing. GitHub's cron is UTC, so the file carries a BST
line for April–October and a GMT line for November–March; the clock-change weeks are off by an hour
for a few days. The pages re-read the committed file every 30 minutes, which costs nothing on GitHub.
The feed rate-limits frequent pulls. Feed times carry a US Eastern offset; the pages
convert with `Intl` to `Europe/London`.

**Shared module.** `news.js` (`window.NewsFeed`) holds the currency-to-instrument map `CCY`, the
window rules `windowFor`, `instrumentsFor` (in the caller's board order), UK-time conversion, the
recurring USDA slots and `fetchWeek()`. Edit a rule once, there.

**Rules the page applies:**

| Thing | Rule |
|---|---|
| Spike window | high 5 before / 20 after; medium 5 / 15; low 0 / 5; high-impact policy-rate decisions 10 / 30; speeches, press conferences, testimony 0 / 30 |
| Instruments hit | fixed map by currency in `CCY`: USD also maps to US 500, US Tech 100, Wall Street, Spot Gold; EUR to Germany 40, France 40; GBP to FTSE 100; CNY to AUD/USD, AUD/JPY, NZD/USD; crude oil titles add USD/CAD, EUR/CAD |
| Chicago Wheat | synthetic USDA slots: Crop Progress Mondays 16:00 ET (April–November), Export Sales Thursdays 08:30 ET; unverified |
| Week shown | the UK Mon–Fri containing today; at weekends, the week the feed covers |
| Holidays | feed items with impact `Holiday` print as a row note, not a bar |

**Voice.** Every string a person reads lives in the `VOICE` object (brief.html) and `MV`
(index.html), in a courteous, dry register: facts first, variants chosen by the UK date so wording
holds all day and differs tomorrow, the owner addressed by name once in the salutation, no
exclamation marks, British spelling, "say what is, not what is missing", unknown never dressed as
quiet. The layout, briefing panel, state-driven quirks and the verification states are as built on
20–21 Sep 2026 (see the git history of this section for the full list); nothing in brief.html
changed on 13 Oct 2026.

### 9b. What news does to the chart — the evidence behind the dashboard's phases

Three weeks (21 Sep – 9 Oct 2026, 36 high- and medium-impact releases, 20 instruments) at the old
intensity and on the 20EMA state (not re-measured on the SMA), with the critic's out-of-sample check
on the year's eight NFP releases (76 instrument-releases). The 15-minute band as drawn carries no turn information (1.11× the same
clock windows on other days, 547 cells); the signal is at the bar level. A **high-impact data
print** multiplies turns 3.3× in the fifteen minutes from the release (3.4× on the NFPs; a turn on
63–72% of charts, 79% of those flat going in), almost all of it in the first ten minutes; in the
following quarter-hour trending bars run 1.6× usual (both samples) while turn risk is ordinary
(1.2× on the NFPs; the three-week sample's 0.4× did not replicate). The quarter-hour before a print
is not a reliable lull (0.68× on the NFPs). A **speech** moves the chart in its second quarter-hour
(1.7×, 2.2× on the 2-minute index rows), not its first (0.8×) — 16 speeches, one sample. A
**medium-impact release** is a quiet, not a spike (0.55× turns in its first fifteen minutes,
interval 0.3–0.9; a flat chart entered a trend 4 times in 73) — 15 releases, one sample. The board
already marks the fixed US slots (13:30, 15:00) through time of day; what the calendar adds is the
event-specific phase, so the dashboard keeps the tier and the phase separate. The three weeks ran
1.36× the year's turn rate, which is why a regime multiplier was tried and rejected (§6).

---

## 10. `swing.html` — the overnight session, 00:00–08:00 UK

A third static page, added 20 Sep 2026 for swing entries taken before London opens: the same
instruments on the 4-hour, 1-hour and 30-minute charts over the eight hours the board does not
cover. Cell colour is the share of nights the bar was trending, the figure the share of a day's
range the bar typically covers, the bar beneath the turn spikes (tiers precomputed in the
generator), grey where the instrument does not trade, hatched under 30 nights.

**Data.** `data/swing.json`, written by `tools/gen_swing.py` from the histdata M1 zips: 20
instruments, 22 Jan 2024 to 9 Oct 2026, cut on UK local time; `trending` uses the trading-day ATR
and a per-timeframe median threshold on the **20SMA**'s bar-to-bar move (0.0362 / 0.0178 / 0.0096 of
a daily ATR on the 4-hour / 1-hour / 30-minute charts), turns use the board's hysteresis with the
baseline over the slots the instrument has nights in. Wall Street and Chicago Wheat are absent (no
histdata symbol); France 40 carries nothing before 07:00 UK. Each section stretches the colour ramp
to its own 2nd–98th percentile. Refresh: `node tools/fetch_histdata.js <symbol> 2024 2026 10 data`
then `python tools/gen_swing.py data data/swing.json` (a few minutes). Rebuilt on 22 Oct 2026 on
the 20SMA (a rolling sum, re-summed every 4096 bars), with the sample extended to 9 Oct 2026 by the
zips the October refresh fetched; until then it was a 20EMA to 18 Sep 2026 with thresholds 0.0334 /
0.0141 / 0.0089. **Trap:** `top` is a read-only global in browsers; the helper is `topBy()`.

---

## 11. `tools/live.js` — the live-bars helper

A dependency-free Node (≥ 18) process the owner runs during the day:

```bash
node tools/live.js [--port 8787] [--source tradingview|yahoo] [--poll 30]
```

It serves the repo (so `http://localhost:8787/` is the board with news and live state both working)
and `GET /live.json` with `Access-Control-Allow-Origin: *`, so the GitHub Pages copy of the board can
read it too. `GET /live/status` is a plain-text summary.

**Sources.** `tradingview` (default): TradingView's public websocket
(`wss://data.tradingview.com/socket.io/websocket`, no login, `unauthorized_user_token`), one
connection, two chart sessions per instrument — a 1-minute series (~7 days) feeding the minute store
and a 15-minute series (~75 days) for the ATR — for the OANDA CFD symbols (UK100GBP, DE30EUR,
FR40EUR, US30USD, NAS100USD, SPX500USD, XAUUSD and the 14 pairs), all of which stream in real time
on 24-hour CFD sessions that match the histdata feeds. One series per chart session (a second one
kills the session), resolution "2" refused (2-minute bars are built from the minute store),
heartbeats echoed, a socket silent for 60 s reconnected with backoff. **It is unofficial and
undocumented and may change or block at any time**, which is why `yahoo` stays: Yahoo's v8 chart
API gives FX and the US cash indices within a minute of live, the European cash indices 15 minutes
delayed and cash hours only, gold futures 10 minutes delayed, and the 5-minute history for the ATR;
AUDUSD=X and NZDUSD=X carry null closes on alternate minutes. With no `--source` the helper falls
back to Yahoo automatically if the stream never comes up or fails three reconnects, and reports
`source: "yahoo (fallback)"`.

**What it serves per instrument:** `symbol`, `delayMin`, `updateMode`, `lastBar` (UTC ms, open of
the latest minute bar), `updated`, `ageSec` (now − (lastBar + 60 s)), `atr` (the generator's rule:
Europe/London trading days with at least six hours of bars, completed days only, Wilder 14 —
`atrDays` is the number of days in the recursion, 73–85 on TradingView, 21 on Yahoo), `atrAsOf`,
`bars` = the last 120 bars on each chart as `[t, o, h, l, c]`, and `error`. Measured on 13 Oct
2026 the live ATR sat within 5% of the generator's on the indices and within 10–18% on FX (the
histdata ATR runs high on USD/CAD, AUD/USD and NZD/USD against both feeds). Prices are CFD quotes,
fine for the ATR-normalised state, not for quoting an index level. Only one helper should run at a
time; `TV_TEST_DROP=<seconds>` is a test hook that closes the socket once. The 120 bars suit the
20-period average, the only one the board reads (§6).

---

## 12. The market-close direction study — `tools/close_study.js` (22 Oct 2026)

A question about the six index rows only, on the 2- and 5-minute charts: over the **last 90 minutes
of the cash session, and over its final 15**, does the market follow the day's dominant trend
direction or reverse it? Same or opposite only — nothing here reads up or down. On the page since
22 Oct 2026 as the **Market Close** section (§4), below.

**The averages.** The owner's charts carry the **200, 20 and 8 simple moving averages and never an
EMA**, and **the 20 alone predicts trends**: the 8 is the owner's power-trend average, used only once
a strong trend is running, and the 200 a bias (both stated 22 Oct 2026). The study was first run on
the board's 20EMA (commits 1485c61 and e51ced0, same conclusions), rebuilt the same day on the SMA —
for one evening with an 8SMA state and a 200SMA side reading beside the 20 (commit db69614; they
added nothing, see below) — and the board, the live state and the overnight page followed the same
evening (§1b, §10). `eval_lib.outcomes` takes `maLen` (always a
simple average); `tools/fit_th.js --maLen N` fits the thresholds and records them in
**`data/th_fit.json`**, which this script reads. At the pooled share of 0.45 over the 20 histdata instruments, 26 Jan – 9 Oct
2026: **SMA20 0.0365 / 0.0204 / 0.0105** (2- / 5- / 15-minute; the EMA's were 0.0357 / 0.0204 / 0.0101). Per-instrument shares 0.35–0.53, the
same spread as the EMA's. (The 8SMA was fitted the same way that evening — 0.0578 / 0.0329 / 0.016,
about 60% more move for the same share — and the fit was removed with the reading.)

**Definitions** (the script's header). Cash session: FTSE 100 08:00–16:30 UK; Germany 40 and
France 40 09:00–17:30 CET (16:30 UK — the EU and UK clocks change on the same dates); the three US
rows 09:30–16:00 New York, converted per day with `Intl`, so the clock-gap weeks (9–27 Mar 2026)
land an hour earlier in UK time. Two close windows: the last 90 minutes (15:00–16:30 UK /
14:30–16:00 ET) and the last 15 (16:15–16:30 / 15:45–16:00) — 8 bars = 16 minutes on the 2-minute
chart, as the board's 15-minute move is. Four references: `day`, the session up to the window;
`day90`, the session up to 15:00 UK / 14:30 ET (the 15-minute window only); `pre`, the 75 minutes
before the final window; `full`, from 08:00 UK (US rows only). Three readings of direction:
**state20** — sign of (bars in the +1 state − bars in the −1 state), the board's trend-state rule with
the 20SMA in place of the EMA; **fresh20** — the window's balance counting only trend states that begin
inside it, because a state carried in from before the window follows the segment that produced it by
construction; **price** — sign of the net move, in ATR units. follow = same sign, reverse = opposite,
none = the window has no direction. Days: the board's valid days from 26 Jan 2026 (the first ATR) to
9 Oct (Wall Street 15 Jun – 12 Oct, 83 days), with at least 90% real bars in both segments, half the
window's bars moving, and the exchange's holidays removed by list (LSE 5, Xetra 4, Euronext 3, NYSE 6
in range — the CFD feeds print bars on cash holidays, and four of the LSE's and three of Xetra's
passed the board's validity rule). 174–180 days per histdata row.

**Data.** `data/close_study.json` (2.1 MB, committed): `records[label][chart][window]` holds one
record per day — the three prices, the day and window moves and ranges in ATR units, the 90-minute
window's price move in three 30-minute parts, the 15-minute window's bar-by-bar closes against its
start, the other reference segments under `refs`, and under `ma["20"]` the
state bar counts over the day and the window, turns and trending bars, the state and slope ratio on
the last bar before the window and the state on the final bar, the average's move over each segment,
the state of every window bar as a `+0-` string, and the same counts over the other references — so
any later aggregation reads the file and never the bars. `summary[window]` carries the tallies per
instrument, per market (date-clustered intervals) and a strong/weak split at the median reference
strength, for every reading × reference; `meta` the days used and dropped per row. Re-run `node
tools/close_study.js` only to change the definition or extend the sample.

**What it found** — the share of decided windows that follow the reference, with the clustered 95%
interval (2- / 5-minute where the charts differ; the 8SMA and 200SMA rows were measured on 22 Oct
before the owner ruled both out of trend prediction, and are no longer in the file):

| Window, reading, reference | Europe (3 rows pooled) | US (3 rows pooled) |
|---|---|---|
| last 90 min, price, the day | **45%** follow, n 531, 40–50%; move with the day −0.02 ATR ± 0.01 | 49%, n 431, 44–55%; +0.00 ATR |
| last 90 min, 20SMA state, whole window | 55% / 61%, n 317 / 284, 48–61 / 54–68% | 50% / 53%, n 136 / 141 |
| last 90 min, 20SMA states beginning inside | **49% / 48%**, n 217 / 157, 42–57 / 39–57% | 56% / 40%, n 98 / 70 |
| last 90 min, 8SMA whole / fresh | 53% / 57% whole; 51% / 55% fresh | 48% / 43%; 52% / 45% |
| last 90 min, price, side of the 200SMA | 44% / 46%, 39–49 / 41–51% | 47% / 51% |
| last 15 min, price, the day | **42%** follow, n 533, 36–47%; −0.02 ATR | **41% / 43%**, n 431 / 430, 36–47 / 38–49%; −0.02 ATR |
| last 15 min, 20SMA state, whole window | 63% / 65%, n 187 / 218 — carry-over, see 3 | 64% / 60%, n 77 / 92 |
| last 15 min, 20SMA states beginning inside | 49% / 47%, n 49 / 30 — too few | 57% / 64%, n 21 / 11 |
| last 15 min, price, side of the 200SMA | 46% / 43% | 44% / 46% |

In order of weight:

1. **The final 15 minutes go against the day on every index.** On price all six rows follow less
   than half the time on both charts (FTSE 100 42–43%, Germany 40 45–46%, France 40 37%, Wall
   Street 42–44%, US Tech 100 44–45%, US 500 38–42%); both halves of the year agree (Europe 43%
   then 40%, US 46% then 38% on the 2-minute chart); no weekday goes above 49%. The tilt is against
   the *day*, not the run-in: against the 75 minutes before, the final window follows 49–52%;
   against the session to 15:00 it follows 42–44%, as against the session to 16:15; against the side
   of the 200SMA, 43–46%. A day with no direction to speak of (net move under 0.15 ATR) is a coin
   flip (47–48%); any clearer day move reverses 56–64% of the time, and the tilt is strongest in the
   last five minutes (follow 42% in Europe, 39% in the US). The size is small: the final window moves
   0.07 ATR on a typical day and gives back 0.02 ATR against the day on average. None of this involves
   an average: the price reading is the same under the EMA and the SMA.
2. **The last 90 minutes lean the same way in Europe, and not at all in the US.** Price: Europe 45%
   follow on every row (46 / 45 / 43–44%), US 46–51%; against the side of the 200SMA 44–46% and
   47–51%. The whole-window 20SMA reading's 55–61% "follow" in Europe is the state in force at 15:00
   carried into the window: trend states that *begin* inside the last 90 minutes lean nowhere (Europe
   49% / 48%, US 56% / 40%), and the 8SMA says the same (fresh 51–55% Europe, 45–52% US). A trend
   state at the window's start predicts the window's price direction on 44–57% of days. The strength
   of the day trend changes nothing on price (45% against 45%); the halves of the sample give 48% then
   42%.
3. **No 20-period average can read a 15-minute window.** A 20SMA trend state is present in the final
   window on 36–42% of European days and 19–22% of US days (the 8SMA 34–39% and 15–19%), and its
   direction agrees with that window's own price move only 54–59% of the time (the 8SMA 56–57% in
   Europe, 61–75% in the US on 63–82 cases) — the average lags the window. Its 60–65% "follow" is
   carry-over (against the 75 minutes before it "follows" 73–91%, by construction); states beginning
   inside the window occur on 3–11% of days. Over 90 minutes the state does describe the window
   (agreement 69–79%, fresh states 84–88%). For the final 15 minutes only the price reading means
   anything.
4. **How quiet the US close is on this rule is real**, not an artefact: the board's own climatology
   has a trending bar in 33–42% of the US rows' 19:30–21:00 UK windows against 59–65% of Europe's
   15:00–16:30; on the 20SMA a trend state appears somewhere in the last 90 minutes on 58–65% of
   European days and 33–35% of US days.

The honest summary: **the day's direction does not foretell its last 90 minutes; its final 15
minutes go against it about 58% of the time on every index, by about two hundredths of a day's
range.** A tilt in frequency, not a move worth trading on its own — and the same on the SMA as on
the EMA, because the finding is in the price.

**The Market Close section** (`#close`, 22 Oct 2026). The owner asked for it "day by day: for the
day I'm trading, the percentage that the close follows and disagrees with the dominant trend of that
day", for both windows. The page's reading is the one the chart shows: the **day's trend is the
20SMA trend-state balance** over the cash session up to the window (a day with a zero balance is
left out — 3–8% of days over 90 minutes, 2–16% over the final 15), and the **close is the window's
net price move**, because a 20-period average cannot read the window itself (point 3). It is not
the pure-price pairing of the table above, so the figures differ a little: over all days the pools
follow 48% / 48% in the last 90 minutes and 45% / 42% in the final 15 (Europe, 2- / 5-minute),
48% / 48% and 41% / 42% (US); per index the final window runs 33–52% follow and the 90-minute one
44–54%. Weekday cells rest on 11–37 days (16 on Wall Street, 28–37 elsewhere) with ±15–30 points,
and they swing accordingly (Europe final 15, 5-minute: Mondays 28%, Fridays 51%); the section
prints the ± and keeps the all-days figure on every weekday cell for that reason, and outlines a
cell only when its interval excludes 50% (five cells on the Tuesday profile, mostly pools). The
counts are the `CLOSE` literal (§1) and `data/close_table.json`, both written by `close_study.js`
from the records, so re-running it after a bar refresh updates the page.

**Decided (22 Oct 2026):** the 20SMA alone predicts trends, on the board and on the page. The owner
uses the 8 only in a strong power trend and the 200 as a bias; neither goes on the panels or the
dashboard, and the study's records now carry the 20 alone (§6). Before the ruling the study had
measured both: an 8SMA state read the close no better than the 20's (fresh states 45–55% follow over
90 minutes, too few over 15) and the side of the 200 moved the price reading by at most two points.
