# TrendClock

A single static file, `index.html`. No build, no dependencies, no server. Open it in a browser.

It answers two questions about 25 instruments across the 08:00–21:00 UK trading day, cut into
52 fifteen-minute windows:

- **Blue heat strip** — on what share of days was the 20-period moving average
  *trending* in this window?
- **Orange bar strip** — how often did a trend *start or stop* here (a "turn"), and is that
  more than ordinary variation for this instrument?

Each group is read on the chart the owner trades it on: **indices and commodities on the
2-minute chart, FX pairs on the 5-minute chart**, over the **last three months** (22 Jun – 18 Sep
2026). Everything is precomputed into three literals near the top of the `<script>` — `ROWS`,
`GROUPS`, `TURNC` — and the page derives all statistics from them at load. Since 22 Sep 2026
every row is built in this repo by the scripts in `tools/` (§1b) from 1-minute data; the
external 12-month blob the board used to carry, whose generator was never in the repo, is gone.
The data contract below is what the generator satisfies and what the page assumes.

---

## 1. Data contract

### `ROWS` — 25 entries, one per board row

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

- `s[k]` — share of days the 20MA was trending in window `k`. A proportion, 2 decimal places.
- `t[k]` — **turn ratio**, normalised so its mean over that row's *open* windows is exactly 1.0.
  2 decimal places. It is a ratio to the row's own day, never a comparison between instruments.
- Profile keys: `"0"`–`"4"` are Mon–Fri, `"all"` is the row's whole sample — 61 to 65 weekdays,
  11 to 13 per weekday. Every row is on the same three-month window.

### `GROUPS` — 5 entries: `[name, guideLines, minutesPerBar]`

The guide lines are minutes from 08:00 (London open, US open, etc.); the third element is the
chart the group is scored on — `2` for Indices and Commodities, `5` for the three FX groups —
and `build()` prints it in each section heading ("2-minute chart"). `tools/build_board.js`
writes this literal with the rows; `tools/inject_row.js` preserves it.

### `TURNC` — 25 × 6 integers

Total turn count per row per profile, ordered `[Mon, Tue, Wed, Thu, Fri, all]`. This is what
makes the whole statistical layer possible: `t` alone is a ratio and carries no sample size, so
without `TURNC` there is no way to tell a 1.5× built on 10 turns from one built on 50.

### Invariants — all four currently hold exactly; a rebuilt board must preserve them

| # | Invariant | Status |
|---|---|---|
| 1 | `TURNC[i][5] === sum(TURNC[i][0..4])` | 25/25 (`build_board.js` checks it) |
| 2 | Composite `TURNC` == sum of its constituents, in all 6 profiles | exact by construction |
| 3 | `sum(t[k])` over open windows == number of open windows | worst deviation 0.130 against a 2dp rounding budget of 0.26 |
| 4 | Open windows: 52 on every row (no wheat row on this board — §1b) | derived from the feed by the generator |

**Composite membership** (used by invariant 2, and derived at runtime — see §3.5):

- `Europe` = FTSE 100 + Germany 40 + France 40
- `US` = Wall Street + US Tech 100 + US 500
- `USD pairs` = EUR/USD, GBP/USD, AUD/USD, USD/CAD, USD/JPY, USD/CHF, NZD/USD
- `EUR crosses` = EUR/GBP, EUR/AUD, EUR/JPY, EUR/CAD, EUR/CHF, EUR/NZD

A composite's `s` is the mean of its constituents' `s` (2dp), its counts are their **sum**, its
`days` is the **rounded mean** of their day counts, and it is closed only where every
constituent is. So `TURNC / days` for a composite is turns per day *across several instruments*
and can exceed 1 — USD pairs reaches 1.97, Europe 1.88, US 1.84. Never read it as a probability.
See §3.6.

### 1b. The generator in `tools/`

**Sources.** histdata.com 1-minute bid bars for the 14 FX pairs, the five European and US index
CFDs (UKXGBP, GRXEUR, FRXEUR, NSXUSD, SPXUSD) and Spot Gold (XAUUSD). Dukascopy's datafeed for
**Wall Street** (USA30IDXUSD, 1-minute BID candles, UTC, prices ×1000), because histdata has no
Dow. Both are free and unauthenticated; Dukascopy is slow (one day file per request, frequent
503s and dropped connections — leave it running, it resumes) and pads closed markets with
placeholder minutes (1440 flat, zero-volume records on a Saturday), which `duka2bars.py` drops.

**histdata's clock — the trap that cost the first build.** The site calls its stamps EST, but
the offset follows the UK/European clock change, not the American one: a stamp is always
**Europe/London local time minus five hours**. The evidence, from the zips on disk: the FX week
opens at raw Sunday 17:00 in January and July alike but at raw 16:00 in the three March weeks
when New York was on summer time and London was not; the London cash open sits at raw 03:00
the year round; NFP on 7 Aug 2026 (12:30 UTC) is the largest minute at raw 08:30. A fixed +5 h
therefore lands every summer bar an hour late — the first build (22 Sep 2026) drew every
window's statistics under the label of the quarter-hour an hour later, FTSE's open spike at
09:00 instead of 08:00, and was caught by review before it was committed. `hist2bars.py`
converts raw + 5 h as London time with the UK rule written out (Windows Python ships no zone
database, so `zoneinfo` cannot be relied on); `gen_swing.py` has the same fix. Check any new
converter against NFP or the London open before trusting it.

**Missing instruments.** `build_board.js` names an instrument whose bar file is absent and leaves
it off the board; a composite then sums the constituents it has. On this board:

- **Chicago Wheat** — no free 2-minute source reaches back three months (histdata and Dukascopy
  do not carry CBOT wheat; Yahoo's 2-minute history stops about five weeks back, 5-minute at 60
  days; the Store build of TradingView Desktop exposes no debugging port). The manifest entry
  points at `data/wheat_m2.json`; drop a bar file of the same shape there and the row returns,
  with its pre-open gap and evening drawn closed by the open-window rule below.
- **Wall Street** — sourced from Dukascopy and on the board, but with fewer days than its
  neighbours: the pull never got 3 and 4 Aug 2026 (and two days before the window) through the
  server's timeouts, and a day with no file is a day the generator cannot see. Re-run
  `tools/fetch_dukascopy.py` (it skips what is on disk and names what it could not get) and
  rebuild to close the gap.

**Bars.** `tools/hist2bars.py` and `tools/duka2bars.py` write `[utc_ms, o, h, l, c, real]` at 2 or
5 minutes, buckets aligned to the UTC clock (also the UK clock's alignment), gaps of up to 20
hours inside a trading week (an overnight cash close, never a weekend) filled flat at the
previous close with `real = 0`. The fill keeps the day grid complete for the indicator math; the
flag lets the generator see where the feed had nothing.

**Definitions** (`tools/gen_row.js`; constants at its top, thresholds per chart in
`tools/build_board.js`). One rule for every chart, in units of the instrument's own daily range:

| Term | Rule |
|---|---|
| MA | 20-period EMA of the bar closes, on the continuous series (weekend gaps ignored) |
| scale | 14-day Wilder ATR of UK-calendar-day bars, from completed **trading** days only: Mon–Fri with at least six hours of real bars, so the FX feeds' Sunday-evening hour is not a day (counted as one, it deflated the FX scale by ~13% against the index and gold feeds, which open at midnight and have no such stub) |
| move | `d[t] = EMA[t] − EMA[t−L]`, the MA's move over the last 15 minutes of clock time: `L = round(15 / minutes)` — 3 bars on the 5-minute chart, 8 (16 min) on the 2-minute |
| trending | bar: `abs(d) ≥ TH × scale`; window: any of its bars is trending (3 bars at 5 minutes, 7 or 8 at 2) |
| TH | **0.015 on the 5-minute chart, 0.027 on the 2-minute chart** — see the fit below |
| trend state | +1 / 0 / −1 with hysteresis: enter at `abs(d) ≥ 2 TH × scale`, hold while the sign is unchanged and `abs(d) ≥ 0.5 TH × scale` |
| turn | every bar at which the state differs from the bar before, counted in that bar's window |
| open window | at least half of the window's bars are real on at least half of the Mon–Fri days in range; otherwise closed and excluded from every statistic |
| valid day | Mon–Fri UK; every board bar on the grid; at least 90% of the bars in open windows real; at least half of those bars move (drops holidays and dead feeds) |

No warm-up hour is demanded before 08:00. The rule that required one on the 12-month generator
dropped every Monday of France 40, whose feed starts the week at 08:00 while other days carry
filled bars before the open; the EMA runs on the continuous series either way.

**The 5-minute threshold** is the value calibrated on 16 Sep 2026 against seven of the original
rows over their 12-month window (share-of-days profiles reproduced to a correlation of 0.89–0.96
and RMSE 0.04–0.07 on FX and gold; turn rates within about 15% — a calibration made, it turned
out, on bars an hour late in summer, so it is approximate twice over). It is kept because the FX
rows keep their chart, and because on this sample it lands the 5-minute index rows near where the
old board had them (US 500: 57% of windows trending, 6.9 turns a day, against 49% and 5.7).

**The 2-minute threshold is fitted, not chosen.** The 2-minute 20EMA has 40 minutes of memory
against the 5-minute one's 100, so over the same 15 minutes it moves more, and the same
threshold calls far more windows trending — US 500 at 0.015 on 2-minute bars: 82% of windows,
17.6 turns a day. `tools/fit_th.js` finds the 2-minute TH at which the 2-minute chart calls the
same pooled share of windows trending as the 5-minute chart does at 0.015, on the same
instruments and days. Every instrument fits within a hair of the same value — FTSE 100 0.0271,
Germany 40 0.0265, France 40 0.0279, US Tech 100 0.0273, US 500 0.0271, Spot Gold 0.0265; pooled
0.0271, a ratio of 1.80 — so the ratio is a property of the faster average, not of any
instrument, and 0.027 is used. "Trending" therefore carries one intensity on both charts and only
the MA being read differs: the 2-minute rows keep their finer time-of-day structure (their
all-days shares run 0.59 on average against 0.57 for the 5-minute singles) and about 7–12 turns
a day on the indices against 6–8 on FX. The turn thresholds scale with TH, so the 2-minute rows
enter a trend at 0.054 of a day's range and hold above 0.0135.

**Sample.** 22 Jun – 18 Sep 2026, the 13 full weeks ending on the last complete week histdata
served on 22 Sep. 65 weekdays on the FX rows and the European indices, except France 40 (64),
EUR/CHF (64) and AUD/JPY (64); 63 on US Tech 100, US 500 and Spot Gold (Fri 3 Jul and Mon 7 Sep
fail the movement test); 61 on Wall Street (the two Dukascopy days above, plus the same two
holidays). Weekday profiles hold 11 to 13 days each, which is what §3.3 and §3.7 are about.

**Pipeline** — from the repo root, node ≥ 18 and python 3:

```bash
for s in ukxgbp grxeur frxeur nsxusd spxusd xauusd eurusd gbpusd audusd usdcad usdjpy usdchf \
         nzdusd eurgbp euraud eurjpy eurcad eurchf eurnzd audjpy; do
  node tools/fetch_histdata.js $s 2026 2026 9 data          # monthly zips; re-runs skip what is on disk
done
for s in ukxgbp grxeur frxeur nsxusd spxusd xauusd; do python tools/hist2bars.py $s data data/${s}_m2.json 2 2026; done
for s in eurusd gbpusd audusd usdcad usdjpy usdchf nzdusd eurgbp euraud eurjpy eurcad eurchf eurnzd audjpy; do
  python tools/hist2bars.py $s data data/${s}_m5.json 5 2026; done    # last argument: earliest zip year to read
python tools/fetch_dukascopy.py USA30IDXUSD 2026-05-25 2026-09-20 data   # hours; resumable; names what it could not get
python tools/duka2bars.py USA30IDXUSD data data/usa30_m2.json 2 1000
node tools/fit_th.js --from 2026-06-22 --to 2026-09-18                     # only if the 5-minute TH or the sample changes
node tools/build_board.js --from 2026-06-22 --to 2026-09-18                # writes data/rows/*.json and the three literals
node tools/board_stats.js                                                  # every board-level figure the comments cite
node tools/loo_harness.js                                                  # held-out and null-simulation figures
```

`gen_row.js` also runs alone (`--sweep 0.01,0.02,0.03` prints the share and turn profile at each
threshold; `--compare` scores a run against the row of the same label in `index.html`).
`data/rows/<slug>.json` is the committed record of every row, with the exact per-window counts
under `meta.counts` and the day validity under `meta`; `data/rows/_board.json` records the dates,
thresholds, sources and what was left off. The zips, `.bi5` files and bar files are not committed
(see `.gitignore`).

---

## 2. Counts are recovered, not stored per window

```js
lambda = TURNC[i][mode] / openWindows        // expected turns per window if the day were flat
c[k]   = Math.round(t[k] * lambda)           // the integer count behind the window
```

Exact wherever one count moves `t` by more than the 0.01 rounding step, i.e. `lambda < 100`.
Every row on the three-month board is below that — USD pairs, the largest, is 56.1 — and the
recovered counts match the generator's `meta.counts` in all 7800 cells. On the 12-month board
USD pairs and EUR crosses ran at 258 and 212 and 57 of 7746 windows came back one turn off; if a
longer sample ever pushes a row past `lambda = 100` again, re-check the tiers on `meta.counts`.

---

## 3. The algorithm, in order

### 3.1 Dispersion `phi` — `dispersion(r, idx)`

Pearson chi-square of the row's counts split across the five weekday columns, over
`4 × (used − 1)` degrees of freedom (4 df per used window, less the 4 spent estimating the
weekday column proportions). Windows whose 5-weekday total is under 5 are skipped.

**It is not a dispersion estimator, despite the name.** It is a weekday × slot *interaction*
statistic, and it fails as a measure of clustering in both directions:

- **It diverges with sample length.** On simulated days with zero clustering but a fixed 15%
  weekday × slot pattern it returns 1.23 / 1.62 / 2.16 / 3.52 / 6.99 at 10 / 25 / 52 / 104 / 260
  days per weekday. A Pearson statistic under a fixed alternative grows without bound; only the
  no-pattern control stays at 1.0.
- **It is blind to whole-day clustering** — the thing the old comments claimed it measured.
  Against genuine day-level dispersion of 1.4, 2.8 and 6.8 it returns 0.96, 1.00 and 1.01, because
  its expected values come from the row's own weekday totals and absorb any common day multiplier.

It survives in the significance tests only because both errors push the same way there: a
too-large `phi` widens the tail and under-flags. **Do not reuse it anywhere that direction is not
safe** — it was in `pTurn` once and understated the printed figure by up to 17.9 points.
**Refresh hazard:** a longer history inflates it and will quietly suppress flags.

Returns **both** forms and they are not interchangeable:

- `phi` — clamped to `>= 1`. Used for the per-window tail, where staying conservative is
  deliberate.
- `raw` + `dfPhi` — unclamped. Used by the omnibus, which references F.

Observed range on the three-month board: 1.0 for 19 of the 21 single instruments (USD/CAD 1.02,
EUR/AUD 1.07 — 13 days per weekday leaves the interaction statistic at or near 1), 1.28 EUR
crosses, 1.34 Europe, 1.39 US, 1.68 USD pairs. It reached 2.5 on USD pairs over 12 months. Under
a pure null it is unbiased (simulated 0.98–1.00), which is what §3.4 leans on to calibrate test
size; it is only under structure that it inflates.

### 3.2 Per-window p-value — `poisUpper(c, lam, phi)`

`P(X >= c)` for a quasi-Poisson with `Var = phi·mu`, computed as `gammp(c/phi, lam/phi)` — the
regularized lower incomplete gamma, series below the crossover and continued fraction above.

**Two bugs live here historically; do not reintroduce either.** Summing the CDF and returning
`1 − s` (a) loses the far tail to cancellation — at `lambda` 258, `c` 400 it returned 1.5e-10
against a true 2.2e-16 — and (b) for integer `c` silently computes `P(X > c)`, excluding the
observed count from its own tail and understating every p-value by ~1.7×.

### 3.3 Tiers — the bar colours

Within each **row × profile** family (52 windows on every row of this board):

| Tier | Rule | Constant | Appearance |
|---|---|---|---|
| 2 | `p <= ` BH cutoff at 10% FDR | `FDR = 0.10` | solid bright orange |
| 1 | `p <= ` BH cutoff at 40% FDR, not tier 2 | `MID_FDR = 0.40` | dim bar with a light cap |
| 0 | neither | — | plain brown |
| — | `lambda < MIN_LAM` → no tier at all | `MIN_LAM = 1` | hatched, "too few to read" |

`bhCutoff` returns **−1** when nothing passes, so a legitimate cutoff of exactly 0 (an
underflowed p) stays distinguishable from "no rejections". Do not restore a `cut > 0` guard.

Current board: **186 red, 243 capped, every one of the 25 rows marked**. Red splits 71 weekday /
115 all-days, capped 167 / 76. By class: composites 85 red and 79 capped, 2-minute singles 77 and
101, 5-minute singles 24 and 63 — the 2-minute rows carry the most structure per row, the
composites the most power, and the 5-minute FX rows the least of either. The FDR bound
`sum(m × cut)` over the 60 firing families is 11.5 expected false of 186 red, 6.2%.

**`MIN_LAM` was 3, then 1.5, and is 1 on the three-month board.** A single instrument's weekday
profile holds 13 days and 1.1–3.2 turns per window; at 3 the guard hatched all 105 of those
families and the weekday view carried no turn statistics at all, and at 1.5 it still hatched 25
FX families once the ATR fix (§1b) lowered the FX turn rates. Measured by pushing flat Poisson
counts through the real pipeline, the false-mark rate does not move with `lambda`: 0.061 red and
0.36 capped per family at `lambda` 1.0, 0.050 and 0.41 at 1.5, 0.067 and 0.63 at 9, with 4–7% of
families showing any spurious red throughout. So the tests hold their promise down here, and the
guard only needs to catch a profile with fewer expected turns than windows — none on this board.
At 1 the real weekday profiles show 30 red on the single rows against 6.4 expected from noise, on
19 of the 21. Weekday flags still run about 8× rarer per window than all-days ones.

`MID_FDR` was 0.30 and was raised to 0.40 on the 12-month board for coverage of the summary
chips. On this board no row is flat (the largest omnibus is USD/CHF at 0.012); 0.30 would give
every row a mark on some profile but leave USD/CHF and EUR/CHF (omnibus 0.012 and 0.0007) off the
all-days chips, and 0.40 brings them in with three and five capped windows, at 429 marks
board-wide against 349 — the 40% tier doing exactly what it says, on rows whose day is measurably
not flat. Past roughly 0.40 the tier stops carrying a claim worth making.

### 3.4 Row-level structure — `omnibusP(c, open, lam, phiRaw, dfPhi)`

Pearson chi-square of the counts against a flat `lambda`, referred to **F(df, dfPhi)** with
`df = openWindows − 1`, computed via the regularized incomplete beta.

The F reference and the unclamped `phi` are a matched pair. `phi` is unbiased, so clamping it
truncates half its sampling distribution and drags a nominal 0.10 test down to a realised 0.076;
unclamping alone overshoots to 0.13. Together they land on 0.10 (measured 0.099/0.092/0.105/0.094
across `lambda`). Change one and you must change the other.

Only `out.all.omni` is read. `out.flat = out.all.omni > OMNIBUS` (`OMNIBUS = 0.10`) feeds
tooltip prose **only** — it must never gate which windows get marked (§6). On this board no row
is flat: 21 of 25 sit at p < 0.001 and the largest is USD/CHF at 0.012 — and a non-flat row can
still clear the per-window bar not once: USD/CHF's best window (17 turns against 8.8) is at
p = 0.009 where the cut needs 0.002.

### 3.4b The summary chips

The three lists at the top follow **both** marked tiers, sorted strongest-first, with tier 1
drawn as an outlined chip against tier 2's filled one. They read `tier[k] > 0`, not `spike[k]`.

Keyed to tier 2 alone, 21 of the 25 rows could appear on the all-days profile — USD/CHF, EUR/JPY,
EUR/CHF and AUD/JPY carry only capped windows there. With tier 1 it is 25 of 25 on the all-days
profile; a row that stayed out would be one carrying no mark, and its absence the honest reading
rather than a gap.

### 3.5 Composite detection — `COMPOSITE`

Derived, not hardcoded: a `big` row is a composite exactly when the non-`big` rows following it
in its group have turn totals summing to its own. This correctly excludes **Spot Gold**, which is
drawn `big` but is a real instrument. It self-maintains if rows are added — but it depends on
invariant 2 and on constituents immediately following their composite in `ROWS` order, which is
why `build_board.js` emits each group's composites first, each followed by its constituents
(a group can hold several: Europe then US). All four composites are complete on this board
(3× / 3× / 7× / 6×); with a constituent's bar file missing the badge drops and the row sums the rest.

### 3.6 The printed percentage — chance of at least one turn

The figure on each bar is `P(at least one turn in this window on a given day)`, with
`mu = c[k] / days`:

```js
pTurn = 1 - Math.exp(-mu)     // Poisson; deliberately does NOT use phi
```

**It is not `c/days`** — that is a rate, exceeds 1 on the busiest composite windows (USD pairs
1.97, Europe 1.88, US 1.84, EUR crosses 1.45), and cannot be a percentage.

**Why no `phi`.** It used the negative-binomial form `1 - phi^(-mu/(phi-1))`, which is correct
for a genuine dispersion `phi` but wrong with the statistic §3.1 actually computes. Because
`ln(phi)/(phi−1) < 1`, an inflated `phi` always biases this *downward* — measured on the 12-month
board at up to 17.9 points on USD pairs, 8.8 on Europe, 7.8 on US — and since `phi` grows with
sample length, a longer history would have shrunk the printed probability rather than sharpened it.

`1 - exp(-mu)` is by Jensen an **upper bound** on P(at least one) for any mixed-Poisson day
model, so it cannot mislead optimistically and does not drift with sample size. The UI says
"up to" for exactly this reason — keep that wording if you touch it. The largest printed figure on
the board is 96% (a composite on a weekday profile; 86% on all-days); singles top out at 55%
(Wall Street).

### 3.7 Other constants

- `AGG_Q = 0.85` — composite rows only: bright orange fill where `pTurn` reaches that percentile
  of **that row's own** all-days spread. `AGG_CUT[i]` holds the level, `Infinity` for
  non-composites so the test carries its own guard.

  A flat 50% preceded it and was miscalibrated at both ends on the 12-month board (above the
  whole of Europe's 19–42% and US's 16–42%, below the whole of USD pairs' 50–72%); the three-month
  board spreads the rows further still — Europe 6–85%, US 6–84%, USD pairs 24–86%, EUR crosses
  17–76% — because a composite's baseline is set by how many instruments it sums and by their
  chart. Current cuts: Europe 63%, US 61%, USD pairs 72%, EUR crosses 67% — lighting 9/8/8/9 cells
  on the all-days profile and 208 across all six.

  One level per row serves all six profiles because the row's *mean* turn rate moves little
  between them (Europe 0.58–0.69 a day per window, US 0.43–0.59, USD pairs 0.74–0.97, EUR crosses
  0.73–0.84), though a 13-day weekday profile is noisy enough window by window to light anything
  from 5 to 13 cells. It shares the bright fill with tier 2, so on those four rows bright means
  "high for this row, or flagged, or both".

  **Do not generalise this to single instruments as a top-of-own-range rule.** Measured on the
  12-month board: a ≥80%-of-row-max rule lit 356 cells including 27 on AUD/USD and 24 on USD/CHF,
  both statistically flat there (omnibus 0.73 and 0.24). Amplitude ranking scored 0.169
  out-of-sample lift against 0.399 for the significance test, and per-instrument amplitude
  normalisation measured worse still at 0.140. The tier colours are already row-relative — that
  is what `lambda` is.
- `MIN_N = 10` — days below which a heat cell is hatched as a thin sample. It was 30 on the
  12-month board, where a weekday profile held ~52 days; on this board a weekday profile holds
  11–13 by design, so 30 would hatch every weekday cell and the hatch would say nothing. 10 marks
  a profile that has lost a quarter of its days (none has); the `±` the readout prints beside every
  share — ±22pp on a weekday profile, ±11pp on all-days — is what carries the width of the sample.
- Wilson intervals carry the heat strip; Byar's Poisson interval carries the bar tooltip.

---

## 4. What the page draws

- Composite rows sit on their own band with a rule beneath, a `N×` badge, larger figures, and
  clear air before their constituents.
- Each section heading names its chart from `GROUPS[2]` — "Indices 2-minute chart", "FX — USD
  pairs 5-minute chart" — as a `<small>` after the group name.
- Right-hand mirror labels appear at ≥1500px so a row can be named from either end.
- A cursor readout names the row and window; a crosshair marks the column.
- `--pv`, set per section by `tick()` from the **real column width** as
  `clamp(9, colWidth × 0.32, 32)px`, drives the cell figure, bar height, heat height and both
  labels. Fixed breakpoints cannot do this — the same viewport gives different columns once the
  right label appears. Numbers are drawn only at `colWidth >= 26px`.
- The **Trend if ≥** control outlines every heat cell meeting the threshold, in every profile,
  whether or not the market is open. Default 75%. On the all-days profile 92 of the 364 2-minute
  single cells and 88 of the 728 5-minute ones reach it.
- The **Auto** day profile follows the real UK weekday and is re-derived every tick, so it moves
  to the new day at midnight without a reload; Saturday and Sunday fall back to all-days. The
  button reads `Auto (Tue)` / `Auto (all days)` so the pick is visible. `All` is the pooled
  three-month read (61–65 days), the steadier one for confirmation; Auto is what the user asked to
  trade from (20 Sep 2026), reversing an earlier default of all-days. On this board a weekday
  profile is 11–13 days: the heat cells carry ±22pp and the turn tiers on single rows rest on
  1.1–3.2 turns per window, so the all-days profile is where the sharper statistics live.
- A **mini brief** sits under the header (`#mini`): the greeting by name (`greeting()`, `GREET`,
  `NAME`), then one sentence each on what is trending at the threshold in the current window,
  which rows carry a turn spike now and next, and the news calendar — the window in effect, else
  the next to start, else nothing left. Strings live in `MV.mini`, chosen by weekday so the line
  holds all day and differs tomorrow; it re-renders every tick from the same lists the chips use.
  Outside 08:00–21:00 and at weekends it carries the greeting and one sentence saying so; the
  banner's notices come from `MV.banner`. It is drawn as a panel of its own — the sections'
  background lifted a little, an amber left edge and an uppercase `BRIEF` label, so it reads as
  one of the board's sections rather than a caption — and the BOX is centred on a 1100px reading
  measure while its text stays left-aligned; the banner below shares that measure so the two
  align. `setMini` writes `#minitext` rather than `#mini`, because the label is a sibling element
  and `textContent` on the parent would erase it. It is the only prose on the page since the footer went.
- **News on the board (added 20 Sep 2026).** `news.js` — shared with brief.html — fetches
  `data/ff_week.json`; today's news-spike windows are drawn as a 3px band along the top of the heat
  strip on every row the event hits (orange high, light medium, faint low; `.news i`, tooltip data
  only), with a composite row carrying its constituents' news (`ROW_INS`). Two header rows, **News
  now** and **News next**, list the high and medium windows overlapping the current and the next
  fifteen minutes, one chip per time-and-country (two German PMIs at 08:30 collapse to one). The
  band's minutes run on the board's own axis (`e.s`, `e.f` = minutes from 08:00) and follow the EST
  toggle through `slotTime()`. Opened from `file://` the fetch is refused; then there are no bands
  and the chips say the calendar is unavailable rather than nothing. The feed is re-read every 30
  minutes. The node stub in `tools/board_stats.js` has no `NewsFeed`, so the kick-off is guarded.
  An event that hits no row on the board — the USDA slots `news.js` adds for Chicago Wheat while
  wheat is off it — is dropped in `loadNews()` (`e.ins.length`), so it reaches neither the chips
  nor the mini brief; brief.html still lists it.
- `favicon.svg` is the board's own: a dark tile, an amber ring, a white hour hand and an orange
  minute hand that is the trend line. Both pages link it.

---

## 5. Refreshing the data (the three-month window going stale)

The sample is currently **22 Jun – 18 Sep 2026** on every row (§1b). histdata serves the current
month a few days behind, so the window can be moved forward whenever a new full week is in.

### Step 1 — rebuild the rows

Run the pipeline in §1b with new `--from`/`--to` dates (keep whole weeks, Monday to Friday, so
each weekday holds the same number of days). `build_board.js` checks invariants 1 and 3 and prints
each row's days, open windows, turns a day and mean share; read that output before going further.
A row with fewer days than the others has lost them to the validity rule — check the feed before
accepting it. Wall Street needs the Dukascopy pull to have reached the end of the window.

### Step 2 — nothing in the algorithm changes

Every statistic is derived at load. No thresholds need retuning unless the sample size or the
chart changes materially. A longer sample raises every `lambda` and the weekday × slot statistic
`phi` with it (§3.1); if the weekday profiles grow past ~30 days, revisit `MIN_N` and `MIN_LAM`
(§3.3, §3.7) and re-run `tools/loo_harness.js` before touching `FDR` or `MID_FDR`. A change of
chart for a group means re-running `tools/fit_th.js`.

### Step 3 — recompute every hardcoded figure

**This is where a refresh goes wrong.** The code comments carry dozens of specific numbers
describing *this* sample. They are prose, not computed, and will silently become false.
Recompute or delete each one.

**The footer was dropped on 20 Sep 2026**, at the owner's request, from both pages. It carried
most of these claims plus the sample dates, the meaning of red and capped bars, the confidence
intervals and the "up to" caveat on the printed percentage. What survives on screen is the
tooltips, the readout and the chart named in each section heading, which are computed from the
data and cannot go stale; what was lost is the page's self-description, so a reader who has not
seen this file no longer learns from the page what the sample is or what the colours mean. If that
ever matters, the text is in the history at `git show b2678fa:index.html`, and the figures below
are how to rebuild it.

**`node tools/board_stats.js` prints the current value of every board-level figure** in this
table (tiers by class, CI spans, `lambda` and turns-per-day ranges, Wilson widths, trending-share
means, autocorrelations, FDR bound, `AGG_CUT`, the flat-yet-marked and non-flat-yet-few examples),
and **`node tools/loo_harness.js` prints the held-out and null-simulation figures**, so a refresh
is a diff against their output rather than a hunt.

The rows marked *(was footer)* are no longer displayed anywhere. Keep them: they are the
specification of what the board means, they are quoted in the code comments, and they are what a
rebuilt footer or a README would have to say.

| Where | Claim | How to recompute |
|---|---|---|
| (was footer) | `76%` of all-days windows / `96%` of weekday windows have a CI spanning 1.0× | Byar interval per window, count those with `lo <= 1 <= hi` |
| (was footer) | quasi-Poisson dispersion `1.0` for 19 of 21 singles, `1.28–1.68` composites | `TURN[i].phi` range |
| (was footer) | FDR bound "works out at about 6%", "roughly 12 of the 186 red" | `sum(m × cut)` over firing families ÷ total flags |
| (was footer) | `243` capped against `186` red; `71 of the 186` weekday; `167 of the 243`; by class composites 85/79, 2-minute singles 77/101, 5-minute singles 24/63 | count tiers across all profiles |
| (was footer) | held-out lift `0.95` at an `86%` hit rate for tier 2 (460 flags), `0.46` / `70%` for tier 1, `0.95` / `82%` for an amplitude cutoff at the same budget, `43%` for a random window | `tools/loo_harness.js` |
| (was footer) | `7` red and `40` capped false marks on a pure-noise board against `186` and `243` real | `tools/loo_harness.js` |
| (was footer) | rate "about 8 times lower per window" for weekday flags | weekday flags/windows ÷ all-days flags/windows |
| (was footer) | `~1.4–3.2` turns/window weekday vs `~8.3–14.7` all-days on the 2-minute singles, `1.1–2.2` / `6.8–9.9` on the 5-minute; composites `5.1–12.6` / `31–56`; turns a day `7–12` / `6–8` / `26–45` | `lambda` and turns-per-day ranges by row class |
| (was footer) | blank rows named — **none** | `TURN[i].marked`, `TURN[i].all.omni`, `TURN[i].needs` |
| (was footer) | USD/CHF "not flat at p = 0.012 yet clears the per-window bar not once" | `TURN[i].all.omni` + its tier counts |
| (was footer) | Wilson half-widths `±22pp` weekday, `±11pp` all-days | mean `ciHalfPP` by profile class |
| (was footer) | lag-1 autocorrelation `−0.05` day-specific vs `+0.55` all-days | pooled lag-1 over `t_weekday − t_all` and over `t_all` |
| (was footer) | bar height cap `1.8×` | matches `Math.min(d.t[k]/1.8, 1)` in `applyMode` |
| Comment, turn-spikes header | FTSE 100 `~5 turns vs 3` weekday, `~22 vs 14.7` all-days; `lambda` 56.1 the largest, counts exact in all 7800 cells | that row's `lambda`; `max lambda`; count recovery vs `meta.counts` |
| Comment, turn-spikes header | LOO: tier 2 `0.95` / `86%`, matched amplitude `0.95` / `82%` at `1.89×` and 460 flags, random `43%`; singles' `lambda` `7–15` | `tools/loo_harness.js`; `lambda` range |
| Comment ~L290 | USD/CHF non-flat at `p = 0.012`, best window 17 vs 8.8 at p 0.009, cut needs 0.002 | its `omni`, `max(c)`, `p`, `FDR/52` |
| Comment ~L375 | MID_FDR: 0.30 gives 349 marks and leaves USD/CHF and EUR/CHF off all-days, 0.40 gives 429 and admits them with 3 and 5 capped | rerun with `MID_FDR` at 0.30 / 0.50 |
| Comment ~L386 | AGG_Q: row spreads 6–85 / 6–84 / 24–86 / 17–76%, cuts 63/61/72/67%, lighting 9/8/8/9, mean mu 0.58–0.69 and 0.43–0.59, weekday lighting 5–13 | `AGG_CUT`, `pTurn` spread, mean `c/days` per profile |
| Comment ~L403 | FDR sweep `86/86/86/85%` at q = .05/.10/.15/.20 (355/460/536/593 flags); USD/CHF `17 vs 8.8` just outside | `tools/loo_harness.js`; its best count and `lambda` |
| Comment ~L408 | MIN_LAM: null rates 0.061/0.36 at 1.0, 0.050/0.41 at 1.5, 0.067/0.63 at 9, 4–7% any red; 30 real red vs 6.4, 19 of 21 rows; 25 FX families hatched at 1.5 | the null simulation at each `lambda`; weekday tiers on single rows at each guard |
| Comment ~L422 | `phi` 1.0 for 19 of 21 singles (USD/CAD 1.02, EUR/AUD 1.07), 1.28–1.68 composites | `TURN[i].phi` |
| Comment ~L462 | rate hits `1.97` (USD pairs), `1.88` (Europe), `1.84` (US) | `max(c)/days` |
| Comment ~L496 | no flat row, largest omnibus USD/CHF 0.012; a 5-minute row needs `1.6–1.9×`, a 13-day weekday profile `2.2–3.8×` | `TURN[i].needs`; smallest count with `poisUpper <= 0.05` at weekday `lambda` |
| Comment ~L503 | tier 1 held-out `0.46` / `70%` vs tier 2 `0.95` / `86%`; null board `40` capped, `7` red vs `243` / `186` real | `tools/loo_harness.js` |
| Comment ~L930 | chips: 21 of 25 rows on tier 2 alone (USD/CHF, EUR/JPY, EUR/CHF, AUD/JPY capped only), 25 of 25 with tier 1 | rows with any `tier > 0` / `tier === 2` on all-days |
| §3.1 above | `phi` divergence figures `1.23 / 2.16 / 6.99`, blindness `0.96 / 1.00 / 1.01` | re-run the two estimator simulations; these are properties of the estimator, not the data, so they should reproduce |
| §1b above | the fit: per-instrument TH2 `0.0265–0.0279`, pooled `0.0271`, ratio `1.80`; US 500 at 0.015 on 2-minute `82% / 17.6 a day` vs `57% / 6.9` on 5-minute | `tools/fit_th.js`; `gen_row.js --sweep` |

Also check the **sample dates** in the opening paragraph, §1b and this section's first sentence,
the day counts in §1b, and the tools/ file headers. Since the footer went, §1b and §5 are the only
record of what period the board covers — nothing on screen says it.

---

## 6. Rejected approaches — do not reintroduce

Each was built, measured, and removed. The reasoning is in the code comments at the cited
functions or in §1b.

- **A single pooled amplitude cutoff** (the original rule). Because `t` is normalised to mean
  1.0, comparing it to one cross-instrument percentile ranks rows by dispersion, which is mostly
  sample noise. It flagged Chicago Wheat — 49 days, ~1 turn per weekday window — most often, and
  the data-rich composites least. On the three-month board a budget-matched amplitude cutoff
  comes within a few points of the significance test (§7), because every single instrument's
  `lambda` sits between 7 and 15; the test keeps its place for the hit rate and the noise
  guarantee, and for the boards where `lambda` will not be so uniform.
- **Shrinking the displayed `t` toward 1.0.** It rests on a signal-variance estimate that is a
  small difference of two mean squares, goes negative for two rows, and swings 2–3× with a
  parameter this data cannot identify.
- **An omnibus gate licensing bare per-window tests.** Gating on `out.flat` and then marking any
  window at `p <= 0.05` gives ~312 uncorrected tests per gated row. A pure-noise row that
  squeaked through painted a median of 10 marks; the 12-month board ran 201 false marks against
  20 for the current second BH pass. The gate is also built from the very windows it licenses.
- **Reading `c/days` as a probability.** It is a rate and exceeds 1. See §3.6.
- **A single absolute level for the composite bright fill.** Composites sum different numbers of
  instruments on different charts, so their baselines differ by 30+ points; any flat cut is above
  one row's whole range and below another's. See §3.7.
- **Top-of-own-range highlighting on single instruments.** It cannot tell a row with structure
  from a flat one, and lit AUD/USD and USD/CHF hardest. See §3.7.
- **Using `phi` in the printed probability.** Correct for a real dispersion, wrong for the
  interaction statistic §3.1 computes; biased the figure down by up to 17.9 points and would
  have worsened with more data. See §3.6.
- **`P(X > c)` as the p-value**, and **summing the CDF** to get the tail. See §3.2.
- **Clamping `phi` inside the omnibus.** See §3.4.
- **One threshold on both charts.** At 0.015 the 2-minute chart calls 82% of US 500 windows
  trending and 17.6 turns a day, against 57% and 6.9 on the 5-minute chart, and the 75% control
  would light whole index rows. The 2-minute threshold is fitted to match the 5-minute chart's
  pooled share instead (§1b).
- **Scaling the threshold by `sqrt(minutes/15)` or fitting it as a per-chart median** (the swing
  page's rule). The first was tried on swing.html and left every instrument between 10% and 18%
  trending; the second reads "busier than the median bar", which is right for the overnight page
  and wrong for a board whose 75% control means something across groups.
- **A 5-minute ATR(14) as the scale.** It normalises away the time-of-day structure the board
  exists to show (correlation 0.2–0.6 against the reference rows when it was tried).
- **Requiring the hour before 08:00 on the grid.** It dropped every Monday of France 40 (§1b).
- **`MIN_LAM = 3`, or 1.5, on a 13-day weekday profile.** 3 hatched all 105 single-row weekday
  families and 1.5 still hatched 25, while protecting nothing: the false-mark rate under noise is
  the same at `lambda` 1 as at 9 (§3.3).
- **Keeping the old 12-month, 5-minute rows for Wall Street and Chicago Wheat** alongside the
  rebuilt ones. Two definitions on one board cannot be read against each other; a missing row is
  named instead (§1b).
- **A fixed +5 h on histdata's stamps.** Their clock follows the UK change, so a fixed offset is
  an hour late from the last Sunday of March to the last Sunday of October; the first build of
  this board had every window labelled four slots late and was caught by review before commit
  (§1b). The same defect had sat in `hist2m5.py` and `gen_swing.py` since 16 Sep.
- **Every UK calendar day in the ATR.** The FX feeds' Sunday-evening hour counted as a day of
  its own once a week and deflated the FX scale ~13% against the index and gold feeds; the ATR
  now takes Mon–Fri days with at least six hours of real bars (§1b).
- **Treating Dukascopy's placeholder minutes as bars.** A closed Saturday arrives as 1440 flat,
  zero-volume records; read as bars they gave the Dow zero-range ATR days. `duka2bars.py` drops
  them.

---

## 7. Verification

### Load the statistics layer in node

`tools/board_stats.js` does exactly this and prints the board figures. For ad-hoc work, the same
stub by hand — the script has no module boundary, so stub the DOM and re-export:

```bash
node -e "
const fs=require('fs');
const js=fs.readFileSync('index.html','utf8').split('<script>')[1].split('</script>')[0];
const stub='const document={getElementById:()=>({textContent:\"\",innerHTML:\"\",addEventListener(){},style:{},value:\"75\",classList:{toggle(){},add(){},remove(){}},querySelector:()=>({textContent:\"\"}),querySelectorAll:()=>[],appendChild(){},getBoundingClientRect:()=>({left:0,width:900})}),createElement:()=>({style:{},classList:{add(){},toggle(){}},dataset:{},appendChild(){},querySelector:()=>({appendChild(){},querySelectorAll:()=>[]}),querySelectorAll:()=>[],firstChild:{style:{}}}),querySelectorAll:()=>[],addEventListener(){}};const window={addEventListener(){}};const setInterval=()=>0;';
fs.writeFileSync('/tmp/m.js', stub + js.replace(/^build\(\); tick\(\); setInterval\(tick, 1000\);\$/m,'')
  + '\nmodule.exports={ROWS,TURN,TURNC,GROUPS,MODES,SLOTS,COMPOSITE,FDR,MID_FDR,MIN_LAM,poisUpper,bhCutoff,gammp,betai,byar};');
"
```

Then `require` it and compute against `TURN[i][mode]`, which exposes
`{lam, c, p, spike, tier, pTurn, omni, phi, nOpen, weak, days}` plus row-level
`{flat, marked, needs}`.

### Render and inspect

```bash
CHROME="/c/Program Files/Google/Chrome/Application/chrome.exe"
"$CHROME" --headless --disable-gpu --dump-dom --virtual-time-budget=5000 \
  --window-size=2560,900 "file:///C:/projects/TrendClock/index.html" > dom.html
"$CHROME" --headless --disable-gpu --screenshot=shot.png \
  --window-size=5120,1440 --virtual-time-budget=5000 "file:///C:/projects/TrendClock/index.html"
```

To drive controls, append a `<script>` that sets `#preview` (`input` event), clicks
`#dayseg button[data-m="0"]`, or changes `#thr` (`change` event), then read `document.title`.
Note `:hover` cannot be triggered synthetically — the row highlight is class-driven (`.hot`)
partly for that reason. To see a live weekday board out of hours, prepend a `<script>` that
replaces `Date` with a subclass whose no-argument constructor returns a fixed instant (the rig
used on 22–25 Sep 2026 froze it at a Tuesday 10:07 UK).

### Checks that should pass after any change

| Check | Expected |
|---|---|
| Script parses | `new Function(scriptBody)` throws nothing |
| No runtime errors | dumped DOM contains no `Uncaught` / `ReferenceError` / `TypeError` |
| Tooltips | 1300 bar tooltips at the default profile (25 × 52) |
| CI vs verdict | **0** windows whose printed CI excludes 1.0× while the text says "within ordinary variation" |
| Printed % | every value `< 100%`; no `NaN` / `undefined` anywhere in the DOM outside the script source |
| Tiers on closed/weak | **0** |
| Tier 2 ⊂ tier 1's cut | every tier-2 window also passes the 40% cut |
| Section headings | Indices and Commodities say "2-minute chart", the FX groups "5-minute chart" |
| Composite badges | Europe 3×, US 3×, USD pairs 7×, EUR crosses 6× |
| Invariants | `build_board.js` prints invariant 1 ok and invariant 3 worst ≤ 0.26 |
| Event clock | in the converted bars, NFP (first Friday, 12:30 UTC) and the London open (07:00 UTC in summer, 08:00 in winter) are the largest bars of their day |
| Column overlays | live-window marker aligns with its column to <1px at 5120 / 2560 / 1400 / 900 |
| Narrow layout | numbers hidden below `colWidth 26px`; no right label below 1500px |

### Out-of-sample harness — `tools/loo_harness.js`

Leave-one-weekday-out: train on 4 weekday columns pooled, score on the held-out 5th. Score a
flagged window as `t_heldout − 1`. **Estimate `phi` from the training columns only** — reusing
`TURN[i].phi` leaks the held-out day. The baseline is structurally 0.00, because `t` is
normalised to mean 1.0; the meaningful baseline is the 43% hit rate of a random window. On a
three-month board the held-out weekday is 13 days, so the score is noisy; read the lift against
the budget-matched amplitude cutoff rather than on its own. Current figures: tier 2 0.95 / 86%,
tier 1 0.46 / 70%, matched amplitude 0.95 / 82%.

For the null simulation, draw flat Poisson counts at each row's real `lambda` and run the real
pipeline. **Use a proper PRNG** — a naive LCG overflows 2^53 in JS doubles and silently
degenerates, which produced wrong false-mark counts here once. Current figures: 7 red and 40
capped false marks per board against 186 and 243 real.

---

## 8. Conventions

- Three pages, cross-linked in the header: `index.html` the board (08:00–21:00, 2-minute for
  indices and commodities, 5-minute for FX), `brief.html` the news spikes, `swing.html` the
  overnight session (00:00–08:00, §10).
- All times are **UK clock time**. Slot `k` starts at `08:00 + 15k`. The EST toggle shifts
  labels only; the data is not re-bucketed. For the ~4 weeks a year when UK and US clocks are out
  of step, US-session features land an hour — **four slots** — earlier than labelled.
- Editing this file from a shell: template literals and `×`/`—` get mangled by bash string
  expansion, and a heredoc containing backticks fails outright in this harness. Apply
  replacements from a JSON file with `node tools/apply_edits.js edits.json` (each `{old, new}`
  must match exactly once; add `CLAUDE.md` as a second argument to edit this file), or use the
  editor's own write tool for a whole file, not inline `node -e` with the text embedded.
- Prose is deliberately specific about uncertainty. If a change makes a stated number wrong,
  change the number — do not soften the sentence into something unfalsifiable.

---

## 9. `brief.html` — news spikes for the week

A second static page, sharing `news.js` with `index.html` and linked from its header. It draws the
Mon–Fri news calendar as news-spike windows on a UK-time axis, one row per day, for the 22
instruments the board was built for (its own list in `news.js`; it keeps Chicago Wheat, which
the board lacks since 22 Sep 2026 — §1b), with a next-spike countdown, today's windows, a
compact line per
other day, and a list of high-impact times for the ProRealTime News Blackout indicator (12 slots).

**A spike window is not a blackout** (renamed 21 Sep 2026, at the owner's request). The window is
where the move is likely to fall, and the page exists so the owner knows it is coming — not so
they stand aside for it, which they do not necessarily do. Every user-facing string says "news
spike" or "spike window", and the advice register is awareness rather than instruction: "the
stretch the move usually falls in", not "be flat or be sized for a miss". The one place the old
word survives is the heading **For the News Blackout indicator**, because that is the ProRealTime
indicator's own name, and a line beneath says so. Two identifiers in the script, `firstSpike` and
`emptySpikes`, were `firstBlackout` and `emptyBlackout` before the rename.

**Data.** `data/ff_week.json` is the Forex Factory weekly feed
(`nfs.faireconomy.media/ff_calendar_thisweek.json`), filtered to USD EUR GBP JPY CHF CAD AUD NZD CNY
and written by `tools/fetch_ff.js`. `.github/workflows/ff-calendar.yml` runs it every 2 hours and
on `workflow_dispatch`, and commits only when the events change. The feed rate-limits frequent
pulls, so do not shorten the schedule much. A file with `"source": "seed"` was written by hand
and is replaced on the first Action run.

**Conversion.** Feed times carry a US Eastern offset. The page converts every event with
`Intl` to `Europe/London`, so BST/GMT and the weeks when UK and US clocks are out of step are
handled; nothing is stored in UK time.

**Shared module (added 20 Sep 2026).** The feed logic — the currency-to-instrument map `CCY`, the
window rules `windowFor`, `instrumentsFor` (in the caller's board order), UK-time conversion,
the recurring USDA slots and `fetchWeek()` — lives in `news.js` as `window.NewsFeed`, loaded by
both pages before their inline script, so the two cannot drift on what an event hits or when its
window runs. brief.html aliases what it uses at the top of its script; index.html uses it for
the bands, chips and mini brief. Edit a rule once, there.

**Rules the page applies (constants in the script):**

| Thing | Rule |
|---|---|
| Spike window | high 5 before / 20 after; medium 5 / 15; low 0 / 5; high-impact policy-rate decisions and statements (policy, cash, funds, bank, prime, overnight… rate; rate decision or statement; monetary policy; never unemployment, inflation or participation rates) 10 / 30; titles with speaks, speech, press conference, testifies, remarks 0 / 30 |
| Instruments hit | fixed map by currency in `CCY`: USD also maps to US 500, US Tech 100, Wall Street, Spot Gold; EUR to Germany 40, France 40; GBP to FTSE 100; CNY to AUD/USD, AUD/JPY, NZD/USD; crude oil titles add USD/CAD, EUR/CAD; printed everywhere in board order |
| Chicago Wheat | synthetic USDA slots: Crop Progress Mondays 16:00 ET (April–November), Export Sales Thursdays 08:30 ET. Not checked against USDA holiday shifts or WASDE dates |
| Week shown | the UK Mon–Fri containing today; at weekends, the week the feed covers, or the coming week when nothing is loaded |
| Holidays | feed items with impact `Holiday` print as a row note, not a bar |

**Layout.** The page is a centred column: `main` and the header's `.hwrap` share `max-width:1500px`
with automatic side margins, while `header` itself spans the window so its rule and background
reach both edges. The way back to the board is a button (`.back`), in the header and again at the
foot of the page, since the page is long enough that scrolling back up to a text link was a chore.

**The briefing panel.** "The brief" (the heading was "This morning's brief" until the voice made it
an evening and weekend page too) sits at the top of the page and is shown whenever
the calendar has loaded or failed. It is assembled client-side by `renderBrief` from the focus
day's data (no model call) and, since 20 Sep 2026, is **sectioned**: an intro paragraph, then
**High impact**, **Medium impact** and **Low impact**, then the signoff. Each of the first two
sections opens with a one-line intro chosen by how many events it holds (none / one / several),
then one block per event — release time, country and title, the spike window, the data the
list below also carries (instruments hit, forecast, previous, the USDA caveat), and one remark in
the voice chosen by the event's **kind** (rate decision, speech, scheduled data, recurring USDA
slot) and **state** (upcoming, live, past); remarks are seeded by the date and the event's minute
so neighbours differ. A section with five or more events, or spanning three sessions, is split
into **Overnight** (before 07:00), **London morning**, **Afternoon** (from 12:00) and **Evening**
(from 17:00). Low impact is one summary line listing time and title. The old count line ("2
high-impact, 3 medium-impact") is gone; an orientation sentence (front-loaded, back-loaded, spread,
a single window, empty) replaces it. Strings live under `VOICE.brief`. Notes from `data/brief.json`
(`{date, headline, sections:[{title, items:[…]}]}`) render beneath it only when `date` is today in
UK time; nothing writes that file automatically, and it is public on GitHub Pages like the rest.

**Voice (added 20 Sep 2026).** Every string a person reads that is not pure data lives in the
`VOICE` object at the top of the script, in a courteous, dry, understated register. The rules,
which also govern any new string:

- Facts first, wit as garnish. A remark never replaces a time, instrument, forecast or count, and
  list items, tags and map tooltips carry data only.
- Variants are chosen by the UK date: `pick(arr, offset, u)` = `arr[(YYYYMMDD + offset) %
  arr.length]`, with offsets 0 greeting, 1 load-failed, 2 count, 3 state line, 4 fifth line, 8
  signoff, 9 countdown aside, 10 live aside. So wording changes daily and holds still across the
  once-a-minute re-renders.
- The aside under the countdown (`#nextRem`) is garnish: it is hidden whenever the data line
  above it runs past two lines. Buckets by minutes to the next window start: 0–2, 2–15, 15–60,
  60–240, 240–1440, 1440+. A window starting within 15 minutes of the current one's end replaces
  the aside with "Then {event} at {time}."; two live windows replace it with the latest end.
- The briefing's intro is greeting; the line presenting the brief; orientation (or
  nothing-scheduled, or no-selection); state line (live, next, or all done); at most one further
  line by priority — seed caveat, stale feed (>24 h on a weekday), a run of 3+ windows each
  starting within 20 minutes of the last one's end, overnight windows already over, holidays, the
  unverified wheat slot, 1–6 quiet instruments, Friday. Then the three sections, then the signoff.
- **The greeting is a salutation and nothing more** (20 Sep 2026, at the owner's request): the
  hour plus the name — "Good morning, Don." — and never a clause after it. One form per
  bucket: the clipped "Morning, Don." was dropped on 21 Sep 2026, so the courtesy is always full. The hour alone picks
  it, weekends included: before 12:00 morning, before 18:00 afternoon, otherwise evening, so the
  wording is always true of the clock. `VOICE.greetings.morning|afternoon|evening` on brief.html,
  `GREET` on index.html.
- **Then the valet presents the brief**, which is the sentence that follows: "I have your morning
  brief ready." `VOICE.greetings.present` (keyed `smallHours` before 05:00, then the same three
  buckets, plus `weekend` naming the focus day and `weekendPast`) and `PRESENT` on the board.
  There is no brief to present when the calendar failed to load, when nothing is selected, or —
  on the board — outside 08:00–21:00 and at weekends, so the line is omitted in those states and
  the greeting runs straight into what is wrong.
- **Say what is, not what is missing** (21 Sep 2026, at the owner's request). The valet is a
  butler, so the register is positive and attentive: an empty calendar is "a clear day at high
  weight", not "nothing of high weight"; an idle board "opens at 08:00 and I shall start
  highlighting the moment it does", not "nothing is highlighted until then". Where the page is
  waiting or powerless, it says what it will do about it — "I shall keep watch", "I shall have it
  ready", "Served over http I shall have it for you" — rather than stopping at the lack. A state
  with genuinely nothing to do may carry one offer of service ("Might I get you a coffee in the
  meantime?"), but only one per page and never the same offer twice, because the first
  verification pass flagged a repeated coffee line as sitcom-butler. Honesty outranks cheer: an
  unknown is still an unknown, and "clear" never replaces "unknown" where the page cannot see.
- The owner is addressed by name **once**, in that salutation, and nowhere else: `NAME` at the top
  of each script, `{name}` only in the greeting variants. It replaced a sparing "sir" on 20 Sep
  2026. Change `NAME` in both pages to rename. No exclamation marks, no naming the character,
  British spelling.
- Unknown is never dressed as quiet: while the fetch is pending the lists say "Consulting the
  calendar…", after a failed first load they say the calendar did not load and the header says
  "unknown", and a failed refresh keeps the last calendar and says so on the freshness line.
- Windows are ordered by when their spike window starts, in the list, the header and the briefing,
  so all three name the same next window; a window that started at the same minute is the same
  release split into rows, not a successor. Two live windows show a plain "Spike window now"
  for the one that ends last; a successor that overlaps says "joins at", one that follows says
  "Then"; the briefing's live line runs to the end of the whole chained stretch.
- **Second deck (20 Sep 2026, board mini brief, news chips, sectioned briefing).** A second
  judged panel (three drafts, three lenses, one synthesis; the desk-pragmatic draft won) produced
  `VOICE.brief` in brief.html and `MV` in index.html. Its rules, as implemented: variant offsets
  11 orientation, 12 high intro, 13 medium intro, 14 low, 15 no-events and all-done, 16 + index
  per-event remark, 17 mini trend, 18 mini turn, 19 mini news, 20 outside/weekend/preview, all on
  the YYYYMMDD seed (the board's `byDay` uses the same seed via `NewsFeed.ukParts`). Name lists in
  the mini brief are cut to three names plus "and N more" (two each when both now and next print),
  and only the trend variants that admit a partial list ("among them", "for a start") are
  eligible when the cut happens; `{profile}` is "all-days" or "Tuesdays", never with an article.
  Remarks never open on a title or a digit. A remark carrying `{forecast}` is only eligible when
  the feed supplied it (`pickSafe`). Section intros have `doneOne`/`doneMany` variants (mine, not
  the deck's) for a section whose every window has passed today. The banner keeps only the
  Preview-time instruction at weekends and out of hours, because the mini brief already says
  which it is; `afterGreeting()` strips a leading "It is the weekend" from any follow-on
  sentence so the phrase can never appear twice on one screen.
- **Second verification pass (20 Sep 2026)**, three lenses over both pages, and what it changed: a
  feed that does not reach today (a weekday before the Action has turned it over) is a `stale`
  state on the board — chips say "calendar older than today", the mini brief says the absence of
  bands is unknown — rather than a confident nothing; band tooltips are built once and stay in UK
  time (`ukTime`) whatever the EST toggle shows elsewhere, so their "UK" is always true; a preview
  set to an out-of-hours time is a preview (banner, frozen countdown, `previewOutside` line), not a
  closed board; when two news windows are live the sentence names the one ending last, as brief.html
  does; "News next" reads "nothing new" when the current window simply carries over; chips carry
  the full title on hover and `shortName` cuts at a word boundary; on brief.html a section on a past
  focus day uses its done intros, `allDone` speaks only of high and medium windows, the "spread"
  orientation claims only the noon split it measures, holiday and quiet notes are not offered for a
  past day, the `joins` aside and every section intro open on a word, greetings no longer promise a
  remainder the next sentence denies, and the event blocks carry spaces between their spans for
  copy and screen readers. Left as designed: the header chip rows are per fifteen-minute slot like
  the trend and turn rows beside them, and a USDA slot that falls in wheat's closed 20:45 cell is
  still drawn, because the release is real even where the board does not trade.
- Deviations from the panel's deck, on purpose: the aside is its own `#nextRem` span rather than
  text appended after " — "; the "when {event} arrives" variant is skipped for speech titles;
  a past focus day (weekend after the shown week) gets its own past-tense greeting and count
  and no next-window line; the "today" variants of the quiet and holiday lines are skipped when
  the focus day is not today. An adversarial pass (correctness, fidelity, voice) ran on 20 Sep
  2026 over 22 rendered states; everything it found is fixed or listed here.
- State-driven quirks: "Speech in effect" / "Rate decision in effect" labels (from the window
  shape, 0/30 and 10/30); rate and speech notes and a US-open note appended to the idle data
  line after " · "; "all {n} selected instruments" when a window hits every selected one;
  "Next news spike" with the weekday when the next start is a day or more away; the tab title
  becomes "until HH:MM · event" while live and "{mins}m · event" under an hour; the clock
  caption gains "· London open" / "· US open" for five minutes; the freshness line gains
  "older than I would like" and a clocks-out-of-step note when UK and New York are four hours
  apart; "Today's windows, all done"; "· provisional" on the heading while the calendar is seed
  data; the Copy button reads "Nothing to copy" and is disabled on an empty list; a failed load
  says "unknown" everywhere rather than "nothing".

The deck behind this was produced by a judged panel (three drafts, three lenses, one synthesis)
and the winning register was the film-faithful one; the calibration lives in the session, not
the repo. Editing a string means editing `VOICE`; editing a rule means editing the renderer that
applies it and this list.

**No footer.** Both pages lost their footer on 20 Sep 2026 at the owner's request. brief.html's
carried the feed's provenance, the window rules and the currency-to-instrument mapping; that
specification now lives only in the table above. The page still declares the recurring USDA slot
unverified and the seed calendar provisional in the lines it draws, so the two claims that most
need a caveat still carry one.

**Verify the board's news layer** the same way: a faked clock, `await loadNews(); tick();`, then
count `.news i` per row, read `#newsnowlist`, `#newsnextlist` and `#mini`, and confirm a composite
row carries its constituents' bands.

**Verify.** Serve the folder over HTTP (fetch does not work from `file://`), then check with a
browser in a non-UK timezone and a faked clock that a known event lands at its UK time and that
the header switches to "Spike window now" inside it and that the console shows no errors. The
quickest rig: append a `<script>` that overrides `Date` to a fixed instant, calls `renderAll()`,
and snapshots `#next .k`, `#nextBig`, `#nextSub`, `#nextRem`, `#todayH`, `#quiet`, `#bl`,
`#brief` and `document.title` into a `<pre>`; dump the DOM headless and read it back. States
worth covering: idle under an hour, idle a day away, live (speech, rate decision, two at once),
nothing further (Friday after 15:00, weekend), a stale Forex Factory feed, nothing selected, and
a failed load.

---

## 10. `swing.html` — the overnight session, 00:00–08:00 UK

A third static page, added 20 Sep 2026 for swing entries taken before London opens. Same
instruments and the same visual language as the board, but the axis is the eight hours the board
does not cover, and the rows are cut on the three charts the owner reads: **4-hour** (two bars),
**1-hour** (eight) and **30-minute** (sixteen). Each section is a grid of instruments against the
bars of that chart, and each cell carries three things:

| Encoding | Means |
|---|---|
| Cell colour | share of nights that bar was trending |
| Figure on the cell | the share of a day's range that bar typically covers |
| Bar beneath | turn spikes — trend starts and stops — bright where flagged, capped at the looser tier |
| Grey cell | the instrument does not trade in that slot on this feed |
| Hatched cell | fewer than 30 nights, or under half the instrument's nights |

**Data.** `data/swing.json`, written by `tools/gen_swing.py` from the same histdata.com M1 zips
`tools/fetch_histdata.js` downloads. 20 instruments, 17 Jan 2024 to 18 Sep 2026, ~690 nights each
(regenerated 25 Sep 2026 with the corrected histdata clock — §1b — after a first build that sat an
hour late in every BST month).
The generator streams each instrument once, cuts every timeframe on UK local time so the slots
follow BST, and computes:

- **trending** — `|EMA20[t] − EMA20[t−1]| >= TH × the 14-day ATR of UK calendar days`, with `TH`
  fitted per timeframe as the **median** of that quantity across every instrument and slot, so
  "trending" reads as "busier than the median overnight bar of this chart". Fitted values land at
  0.0381 (4h), 0.0161 (1h) and 0.0101 (30m) of a daily ATR. Carrying the board's absolute 5-minute
  rule over with a `sqrt(minutes/15)` scaling was tried first and left every instrument between
  10% and 18% — too strict to mean anything.
- **movement** — the bar's range over that daily ATR, median across nights, with the 90th
  percentile in the tooltip. Needs no calibration and is comparable across instruments.
- **turns** — the board's three-state hysteresis (enter at 2 × TH, hold above 0.5 × TH), counted
  per slot, with the Poisson tail and both Benjamini-Hochberg tiers **precomputed in the
  generator**, because this page carries no statistics layer of its own. That does not reintroduce
  the staleness hazard of §5: the tiers and the counts are written by the same run, so a refresh
  moves them together.

**Missing.** Wall Street and Chicago Wheat are in brief.html's instrument list but not here —
histdata has no symbol for either, and no proxy was substituted (the board's Wall Street row
comes from Dukascopy, §1b; wheat has no source at all). France 40's feed carries nothing before 07:00 UK, so
fourteen of its sixteen 30-minute slots are grey; that is the instrument, not the page.

**Colour scale.** Overnight trending shares cluster between about 30% and 70%, so the board's
0-to-1 blue ramp would paint a section one flat shade. Each section stretches the ramp to its own
2nd-to-98th percentile and the legend states what the two ends are worth.

**Refresh.** `node tools/fetch_histdata.js <symbol> 2024 2026 9 data` for anything new, then
`python tools/gen_swing.py data data/swing.json`. Two passes over every instrument, about three
minutes. The fitted thresholds move with the data, so the legend and the note follow by themselves.

**Trap.** `top` is a read-only global in browsers; a top-level `function top()` in the page script
throws "Identifier 'top' has already been declared" and kills the whole file before anything
renders. The helper is `topBy()` for that reason.
