# TrendClock

A single static file, `index.html`. No build, no dependencies, no server. Open it in a browser.

It answers two questions about 26 instruments across the 08:00–21:00 UK trading day, cut into
52 fifteen-minute windows:

- **Blue heat strip** — on what share of days was the 5-minute 20-period moving average
  *trending* in this window?
- **Orange bar strip** — how often did a trend *start or stop* here (a "turn"), and is that
  more than ordinary variation for this instrument?

Everything is precomputed into two literals near the top of the `<script>`. The page derives all
statistics from them at load. The original 25 rows arrived as a blob from outside — their
generator is not in this repo or its history. The 26th row, AUD/JPY, is built by the scripts in
`tools/` (§1b) with a definition calibrated to reproduce those rows approximately. The data
contract below is what both must satisfy.

---

## 1. Data contract

### `ROWS` — 26 entries, one per board row

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
- Profile keys: `"0"`–`"4"` are Mon–Fri, `"all"` is the row's whole sample — 12 months for 25 rows,
  five years for AUD/JPY (§1b).

### `TURNC` — 26 × 6 integers

Total turn count per row per profile, ordered `[Mon, Tue, Wed, Thu, Fri, all]`. This is what
makes the whole statistical layer possible: `t` alone is a ratio and carries no sample size, so
without `TURNC` there is no way to tell a 1.5× built on 10 turns from one built on 50.

### Invariants — all four currently hold exactly; a refreshed blob must preserve them

| # | Invariant | Status |
|---|---|---|
| 1 | `TURNC[i][5] === sum(TURNC[i][0..4])` | 26/26 |
| 2 | Composite `TURNC` == sum of its constituents, in all 6 profiles | exact |
| 3 | `sum(t[k])` over open windows == number of open windows | worst deviation 0.140 against a 2dp rounding budget of 0.26 |
| 4 | Open windows: 52 for 25 rows, **43 for Chicago Wheat** (9 closed) | — |

**Composite membership** (used by invariant 2, and derived at runtime — see §4):

- `Europe` = FTSE 100 + Germany 40 + France 40
- `US` = Wall Street + US Tech 100 + US 500
- `USD pairs` = EUR/USD, GBP/USD, AUD/USD, USD/CAD, USD/JPY, USD/CHF, NZD/USD
- `EUR crosses` = EUR/GBP, EUR/AUD, EUR/JPY, EUR/CAD, EUR/CHF, EUR/NZD

**Trap:** a composite's `days` is the *mean* of its constituents' day counts, not a day count of
its own (Europe 255 = mean of 256/257/252, whose sum is 765). Its `TURNC` is a genuine **sum**.
So `TURNC / days` for a composite is turns per day *across several instruments* and can exceed 1
— USD pairs reaches 1.28. Never read it as a probability. See §3.6.

### 1b. AUD/JPY and the generator in `tools/`

AUD/JPY (group "FX — other crosses", no composite) is the one row not from the original blob.
It was added on 16 Sep 2026 from **five years** of data — 13 Sep 2021 – 11 Sep 2026, 1296 valid
days, ~260 per weekday — so its `all` profile is not a 12-month profile, and its tests have
roughly five times the power of any other row's. It carries 48 red and 33 capped windows across
its six profiles for that reason alone; `phi` is 1.07, so the longer history has not inflated
the interaction statistic (§3.1).

**Source.** histdata.com 1-minute bid bars (EST-stamped, converted to UTC, aggregated to 5-minute
bars, gaps inside a week forward-filled flat). Dukascopy was tried first and rate-limits a
five-year pull into hours; histdata serves a year per request.

**Definitions** (constants at the top of `tools/gen_row.js`):

| Term | Rule |
|---|---|
| MA | 20-period EMA of 5-minute closes on the continuous series |
| scale | 14-day Wilder ATR of UK-calendar-day bars, from completed days only |
| move | `d3[t] = EMA[t] − EMA[t−3]`, the MA's move over the last 15 minutes |
| trending | bar: `abs(d3) ≥ 0.015 × scale`; window: any of its three bars is trending |
| trend state | +1 / 0 / −1 with hysteresis: enter at `abs(d3) ≥ 0.03 × scale`, hold while the sign is unchanged and `abs(d3) ≥ 0.0075 × scale` |
| turn | every bar at which the state differs from the bar before, counted in that bar's window |
| valid day | Mon–Fri UK; all 156 board bars and the 12 before 08:00 present; at least half the board bars move |

The original generator is unknown, so these were **calibrated**, not copied: seven instruments
were pulled from the same source over the original 1 Sep 2025 – 28 Aug 2026 window and scored
against their existing rows. The day-validity rule reproduces the original day counts exactly
(258 days, 52/52/52/50/52 by weekday, for FX). The trend rule reproduces the share-of-days
profiles to a correlation of 0.89–0.96 and an RMSE of 0.04–0.07 on FX and gold (0.10 on the two
indices, which want a higher threshold — do not reuse this rule for an index row without
refitting). Turn rates land within about 15% on FX (USD/JPY 6.8 vs 7.1 a day, EUR/JPY 7.2 vs
6.9, AUD/USD 8.4 vs 7.4, EUR/USD 8.9 vs 7.4), and the turn profiles correlate only 0.2–0.6,
because the reference profiles are mostly Poisson noise at ~35 turns per window. Read AUD/JPY
as "comparable to the other FX rows", not "computed the same way".

Rejected while calibrating: a 5-minute ATR(14) scale (it normalises away the time-of-day
structure the reference rows show; correlation 0.2–0.6); price above/below the MA (negative
correlation); raw direction flips of the MA as turns (2–3× too many, and not clustered where
the reference turns are); a single threshold in price units (cannot serve JPY pairs, majors
and indices at once).

**Pipeline** — from the repo root, node ≥ 18 and python 3:

```bash
node tools/fetch_histdata.js audjpy 2021 2026 9 data      # yearly zips, then monthly for 2026
python tools/hist2m5.py audjpy data data/audjpy_m5.json   # EST M1 → UTC 5-minute bars
node tools/gen_row.js --bars data/audjpy_m5.json --label "AUD/JPY" --group "FX — other crosses" \
     --from 2021-09-13 --to 2026-09-11 --out data/row_audjpy.json
node tools/inject_row.js data/row_audjpy.json             # replaces the row in place
node tools/board_stats.js                                 # every figure the footer cites
```

`gen_row.js --compare` scores a run against the existing row of the same label, which is how
to check a rule change. To put AUD/JPY on the same 12-month footing as the rest, rerun with
`--from 2025-09-01 --to 2026-08-28`; to add another pair, change the histdata symbol and the
label and keep the group. `data/row_audjpy.json` is the committed record of what went in,
including the exact per-window counts under `meta.counts`; the zips and 5-minute bars are not
committed (see `.gitignore`).

---

## 2. Counts are recovered, not stored per window

```js
lambda = TURNC[i][mode] / openWindows        // expected turns per window if the day were flat
c[k]   = Math.round(t[k] * lambda)           // the integer count behind the window
```

Exact wherever one count moves `t` by more than the 0.01 rounding step, i.e. `lambda < 100`.
Above that a count can land either side: on USD pairs and EUR crosses over 12 months
(`lambda` 258 and 212), 57 of 7746 windows come back one turn off the constraint-solved value,
and on AUD/JPY's all-days profile (`lambda` 183) 27 of 52 windows sit one off the generator's
exact count. No flag on the board turns on the difference — for AUD/JPY this was checked by
re-running the tiers on `meta.counts` (0 differences) — but if a refresh pushes more rows past
`lambda = 100`, re-check that.

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
**Refresh hazard:** a longer history inflates it further and will quietly suppress flags.

Returns **both** forms and they are not interchangeable:

- `phi` — clamped to `>= 1`. Used for the per-window tail, where staying conservative is
  deliberate.
- `raw` + `dfPhi` — unclamped. Used by the omnibus, which references F.

Observed range: 1.0 for 10 of the 22 single instruments, up to ~2.5 for USD pairs. AUD/JPY sits at
1.07 despite five years of history, so its weekday × slot structure is mild. Under a pure
null it is unbiased (simulated 0.98–1.00), which is what §3.4 leans on to calibrate test size;
it is only under structure that it inflates.

### 3.2 Per-window p-value — `poisUpper(c, lam, phi)`

`P(X >= c)` for a quasi-Poisson with `Var = phi·mu`, computed as `gammp(c/phi, lam/phi)` — the
regularized lower incomplete gamma, series below the crossover and continued fraction above.

**Two bugs live here historically; do not reintroduce either.** Summing the CDF and returning
`1 − s` (a) loses the far tail to cancellation — at `lambda` 258, `c` 400 it returned 1.5e-10
against a true 2.2e-16 — and (b) for integer `c` silently computes `P(X > c)`, excluding the
observed count from its own tail and understating every p-value by ~1.7×.

### 3.3 Tiers — the bar colours

Within each **row × profile** family (52 windows, 43 for Chicago Wheat):

| Tier | Rule | Constant | Appearance |
|---|---|---|---|
| 2 | `p <= ` BH cutoff at 10% FDR | `FDR = 0.10` | solid bright orange |
| 1 | `p <= ` BH cutoff at 40% FDR, not tier 2 | `MID_FDR = 0.40` | dim bar with a light cap |
| 0 | neither | — | plain brown |
| — | `lambda < MIN_LAM` → no tier at all | `MIN_LAM = 3` | hatched, "too few to read" |

`bhCutoff` returns **−1** when nothing passes, so a legitimate cutoff of exactly 0 (an
underflowed p) stays distinguishable from "no rejections". Do not restore a `cut > 0` guard.

Current board: **118 red, 226 capped, 25 of 26 rows marked**; only Chicago Wheat is blank. The 25
12-month rows alone are still 70 red / 193 capped; AUD/JPY adds 48 red and 33 capped across its
six profiles (31 of its red are weekday ones), because five years gives its tests about five
times the power.

`MID_FDR` was 0.30 and was raised to 0.40 for coverage of the summary chips, not for the bars.
At 0.30 nine rows could never reach the chips at all, including USD/CAD, whose day is
measurably not flat (omnibus 0.032) but whose evidence is too diffuse for any one window to
survive. 0.40 admits it with 6 windows at a cost of 263 marks against 180, and — the reason it
is defensible — still leaves every statistically flat row out: AUD/USD (0.73), USD/CHF (0.24),
FTSE 100 (0.20), Chicago Wheat (0.64). Germany 40 (0.054) and EUR/JPY (0.089) would need 0.60
and 0.70; they are deliberately excluded, because past roughly 0.40 the tier stops carrying a
claim worth making.

### 3.4 Row-level structure — `omnibusP(c, open, lam, phiRaw, dfPhi)`

Pearson chi-square of the counts against a flat `lambda`, referred to **F(df, dfPhi)** with
`df = openWindows − 1`, computed via the regularized incomplete beta.

The F reference and the unclamped `phi` are a matched pair. `phi` is unbiased, so clamping it
truncates half its sampling distribution and drags a nominal 0.10 test down to a realised 0.076;
unclamping alone overshoots to 0.13. Together they land on 0.10 (measured 0.099/0.092/0.105/0.094
across `lambda`). Change one and you must change the other.

Only `out.all.omni` is read. `out.flat = out.all.omni > OMNIBUS` (`OMNIBUS = 0.10`) feeds
tooltip prose **only** — it must never gate which windows get marked (§6).

### 3.4b The summary chips

The three lists at the top follow **both** marked tiers, sorted strongest-first, with tier 1
drawn as an outlined chip against tier 2's filled one. They read `tier[k] > 0`, not `spike[k]`.

This matters more than it looks: keyed to tier 2 alone, only 13 of 25 rows could ever appear,
so the summary was structurally silent about EUR/USD, USD/CAD and seven others regardless of
what the day did. It is now 20 of 26 on the all-days profile (19 of the 25 original rows) and 25
of 26 on some profile. The rows that stay out are the ones carrying no mark there, which is the
honest reading rather than a gap.

### 3.5 Composite detection — `COMPOSITE`

Derived, not hardcoded: a `big` row is a composite exactly when the non-`big` rows following it
in its group have turn totals summing to its own. This correctly excludes **Spot Gold and
Chicago Wheat**, which are drawn `big` but are real instruments. It self-maintains if rows are
added — but it depends on invariant 2 and on constituents immediately following their composite
in `ROWS` order.

### 3.6 The printed percentage — chance of at least one turn

The figure on each bar is `P(at least one turn in this window on a given day)`, with
`mu = c[k] / days`:

```js
pTurn = 1 - Math.exp(-mu)     // Poisson; deliberately does NOT use phi
```

**It is not `c/days`** — that is a rate, exceeds 1 on the busiest composite windows, and cannot
be a percentage.

**Why no `phi`.** It used the negative-binomial form `1 - phi^(-mu/(phi-1))`, which is correct
for a genuine dispersion `phi` but wrong with the statistic §3.1 actually computes. Because
`ln(phi)/(phi−1) < 1`, an inflated `phi` always biases this *downward* — measured at up to 17.9
points on USD pairs, 8.8 on Europe, 7.8 on US — and since `phi` grows with sample length, a
longer history would have shrunk the printed probability rather than sharpened it.

`1 - exp(-mu)` is by Jensen an **upper bound** on P(at least one) for any mixed-Poisson day
model, so it cannot mislead optimistically and does not drift with sample size. The UI says
"up to" for exactly this reason — keep that wording if you touch it.

### 3.7 Other constants

- `AGG_Q = 0.85` — composite rows only: bright orange fill where `pTurn` reaches that percentile
  of **that row's own** 12-month spread. `AGG_CUT[i]` holds the level, `Infinity` for
  non-composites so the test carries its own guard.

  A flat 50% preceded it and was miscalibrated at both ends — above the whole of Europe's 19–42%
  and US's 16–42% (0 cells each), below the whole of USD pairs' 50–72% (all 52 lit). A
  composite's baseline is set by how many instruments it sums, so the level has to be per row.
  Current cuts: Europe 37%, US 38%, USD pairs 68%, EUR crosses 60% — lighting 8/9/9/10 cells on
  the 12-month profile and 296 across all six, against 5/4/287/239 under the flat rule.

  One level per row serves all six profiles because `mu` barely moves between them (Europe
  0.392–0.402). It shares the bright fill with tier 2, so on those four rows bright means
  "high for this row, or flagged, or both".

  **Do not generalise this to single instruments as a top-of-own-range rule.** Measured: a
  ≥80%-of-row-max rule lights 356 cells including 27 on AUD/USD and 24 on USD/CHF, both
  statistically flat (omnibus 0.73 and 0.24). Amplitude ranking scored 0.169 out-of-sample lift
  against 0.399 for the significance test, and per-instrument amplitude normalisation measured
  worse still at 0.140. The tier colours are already row-relative — that is what `lambda` is.
- `MIN_N = 30` — days below which a heat cell is hatched as a thin sample.
- Wilson intervals carry the heat strip; Byar's Poisson interval carries the bar tooltip.

---

## 4. What the page draws

- Composite rows sit on their own band with a rule beneath, a `N×` badge, larger figures, and
  clear air before their constituents.
- Right-hand mirror labels appear at ≥1500px so a row can be named from either end.
- A cursor readout names the row and window; a crosshair marks the column.
- `--pv`, set per section by `tick()` from the **real column width** as
  `clamp(9, colWidth × 0.32, 32)px`, drives the cell figure, bar height, heat height and both
  labels. Fixed breakpoints cannot do this — the same viewport gives different columns once the
  right label appears. Numbers are drawn only at `colWidth >= 26px`.
- The **Trend if ≥** control outlines every heat cell meeting the threshold, in every profile,
  whether or not the market is open. Default 75%.

---

## 5. Refreshing the data (the 12-month window going stale)

The sample is currently **1 Sep 2025 – 28 Aug 2026**; Chicago Wheat only from 23 Jun 2026;
AUD/JPY **13 Sep 2021 – 11 Sep 2026** (§1b — regenerated by `tools/`, so it can be refreshed on
its own with the pipeline there while the other rows wait for the external blob).

### Step 1 — replace the blob

Regenerate `ROWS` and `TURNC` together. They must satisfy all four invariants in §1. Verify
before going further:

```bash
node -e "
const fs=require('fs');const h=fs.readFileSync('index.html','utf8');
const R=JSON.parse(h.match(/const ROWS = (\[.*?\]);\n/s)[1]);
const T=JSON.parse(h.match(/const TURNC = (\[\[[\s\S]*?\]\]);/)[1]);
console.log('INV1', R.every((r,i)=>T[i].slice(0,5).reduce((a,b)=>a+b,0)===T[i][5]));
let mx=0; for(const r of R) for(const m of ['0','1','2','3','4','all']){let s=0,n=0;
  for(let k=0;k<52;k++){if(r.closed[k])continue;s+=r.data[m].t[k];n++;} mx=Math.max(mx,Math.abs(s-n));}
console.log('INV3 worst', mx.toFixed(3));"
```

### Step 2 — nothing in the algorithm changes

Every statistic is derived at load. No thresholds need retuning unless the sample size changes
materially. If it does, re-run the leave-one-weekday-out check in §7 before touching `FDR` or
`MID_FDR`.

### Step 3 — recompute every hardcoded figure

**This is where a refresh goes wrong.** The footer and the code comments carry dozens of
specific numbers describing *this* sample. They are prose, not computed, and will silently
become false. Recompute or delete each one.

Some footer values *are* computed and look after themselves — day-count range, `~N of each
weekday`, Chicago Wheat's and AUD/JPY's day counts, `MIN_LAM`, `MIN_N`. Everything below is not,
but **`node tools/board_stats.js` prints the current value of every board-level figure** in this
table (tiers, CI spans, `lambda` ranges, Wilson widths, autocorrelations, FDR bound, `AGG_CUT`),
so a refresh is a diff against its output rather than a hunt. The held-out and null-simulation
figures are the exception: they describe experiments on the 25 original rows, and the footer
now says so.

| Where | Claim | How to recompute |
|---|---|---|
| Footer | `83%` of all-days windows / `95%` of weekday windows have a CI spanning 1.0× | Byar interval per window, count those with `lo <= 1 <= hi` |
| Footer | quasi-Poisson dispersion `1.0` most singles, `1.3–2.5` composites | `TURN[i].phi` range |
| Footer | FDR bound "works out at about 7%", "roughly 8 of the 118 red" | `sum(m × cut)` over firing families ÷ total flags |
| Footer | `226` capped against `118` red on the board, `193`/`70` on the 12-month rows; `26 of the 70` weekday; `116 of the 193`; AUD/JPY `31 of 48` | count tiers across all profiles |
| Footer | held-out lift `0.15` vs `0.40`, hit `62%` vs `81%`; weekday `0.19` vs `0.29`, `69%`/`76%` — scoped to the 25 original rows | §7 harness |
| Footer | `20` false marks on a pure-noise board against `201` — scoped to the 25 original rows | §7 null simulation |
| Footer | rate "about eight times lower per window" (12-month rows; the whole board is 5.4×) | weekday flags/windows ÷ all-days flags/windows |
| Footer | `~5–8` turns/window weekday vs `~27–38` all-days; composites `15–53` / `83–258`; wheat `1.0–1.5` / `6.1`; AUD/JPY `34–38` / `183` | `lambda` ranges by row class |
| Footer | blank rows named — only **Chicago wheat** | `TURN[i].marked`, `TURN[i].all.omni`, `TURN[i].needs` |
| Footer | Spot Gold "flat overall at p = 0.13 yet owns one window" | `TURN[i].all.omni` + its tier-2 count |
| Footer | Wilson half-widths `±13pp` weekday, `±6pp` all-days; AUD/JPY `±6pp` / `±3pp` | mean `ciHalfPP` by profile class |
| Footer | lag-1 autocorrelation `−0.04` day-specific vs `+0.35` all-days (`+0.33` without AUD/JPY) | pooled lag-1 over `t_weekday − t_all` and over `t_all` |
| Footer | bar height cap `1.8×` | matches `Math.min(d.t[k]/1.8, 1)` in `applyMode` |
| Comment ~L211 | FTSE 100 `~10 turns vs 6.9` weekday, `~50 vs 33.6` 12-month | that row's `lambda` |
| Comment ~L213 | Chicago Wheat `1.0–1.5` turns per weekday window | its weekday `lambda` |
| Comment ~L219 | `lambda` 258 / 212, `57 of 7746` windows off by one; AUD/JPY `183`, `27 of 312` | recompute against a constraint solve; AUD/JPY against `meta.counts` |
| Comment ~L222 | LOO `0.399` vs `0.169`, `81%` vs `61%`, `179` vs `779` flags, budget-matched `0.254`/`66%` | §7 harness |
| Comment ~L279 | GBP/USD non-flat at `p = 0.0004` yet clears once | its `omni` and tier-2 count |
| Comment ~L565 | chips reachable by `20 of 26` rows on the all-days profile, `25 of 26` on some profile | rows with any `tier > 0` |
| Comment ~L312 | realised size `0.076` clamped / `0.13` unclamped / `0.10` paired | §7 null simulation |
| Comment ~L334 | FDR sweep `83/81/79/76%` at q = .05/.10/.15/.20 | §7 harness across q |
| Comment ~L336 | USD pairs `331 turns against 258` just missing the cut | its max count and `lambda` |
| Comment ~L341 | `phi` 1.0 for 10 of 22 singles, up to 2.5 | `TURN[i].phi` |
| Comment ~L378 | USD pairs rate hits `1.28` | `max(c)/days` |
| Comment ~L401 | rejected gate: median `10` marks, board `201` vs `20` | §7 null simulation |
| Comment ~L405 | Spot Gold omnibus `0.10`, one red | recompute |
| Comment ~L408 | Chicago Wheat `6.1` turns/window, doubling misses p = 0.05 | `lambda` + smallest significant count |
| Comment ~L415 | held-out `0.15` vs `0.40` and `0.19` vs `0.29` | §7 harness |
| §3.7 above | per-row cuts `37/38/68/60%`, lighting `8/9/9/10` on all-days and `296` across profiles | recompute `AGG_CUT` and count |
| §3.1 above | `phi` divergence figures `1.23 / 2.16 / 6.99`, blindness `0.96 / 1.00 / 1.01` | re-run the two estimator simulations; these are properties of the estimator, not the data, so they should reproduce |

Also check the **sample dates** in the first footer sentence, the Chicago Wheat start date, and
AUD/JPY's dates and "five years" wording.

---

## 6. Rejected approaches — do not reintroduce

Each was built, measured, and removed. The reasoning is in the code comments at the cited
functions.

- **A single pooled amplitude cutoff** (the original rule). Because `t` is normalised to mean
  1.0, comparing it to one cross-instrument percentile ranks rows by dispersion, which is mostly
  sample noise. It flagged Chicago Wheat — 49 days, ~1 turn per weekday window — most often, and
  the data-rich composites least.
- **Shrinking the displayed `t` toward 1.0.** It rests on a signal-variance estimate that is a
  small difference of two mean squares, goes negative for two rows, and swings 2–3× with a
  parameter this blob cannot identify.
- **An omnibus gate licensing bare per-window tests.** Gating on `out.flat` and then marking any
  window at `p <= 0.05` gives ~312 uncorrected tests per gated row. A pure-noise row that
  squeaked through painted a median of 10 marks; the board ran 201 false marks against 20 for
  the current second BH pass. The gate is also built from the very windows it licenses.
- **Reading `c/days` as a probability.** It is a rate and exceeds 1. See §3.6.
- **A single absolute level for the composite bright fill.** Composites sum different numbers of
  instruments, so their baselines differ by 30+ points; any flat cut is above one pair's whole
  range and below the other's. See §3.7.
- **Top-of-own-range highlighting on single instruments.** It cannot tell a row with structure
  from a flat one, and lights AUD/USD and USD/CHF hardest. See §3.7.
- **Using `phi` in the printed probability.** Correct for a real dispersion, wrong for the
  interaction statistic §3.1 computes; biased the figure down by up to 17.9 points and would
  have worsened with more data. See §3.6.
- **`P(X > c)` as the p-value**, and **summing the CDF** to get the tail. See §3.2.
- **Clamping `phi` inside the omnibus.** See §3.4.

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
  + '\nmodule.exports={ROWS,TURN,TURNC,MODES,SLOTS,COMPOSITE,FDR,MID_FDR,MIN_LAM,poisUpper,bhCutoff,gammp,betai,byar};');
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
partly for that reason.

### Checks that should pass after any change

| Check | Expected |
|---|---|
| Script parses | `new Function(scriptBody)` throws nothing |
| No runtime errors | dumped DOM contains no `Uncaught` / `ReferenceError` / `TypeError` |
| Tooltips | 1343 bar tooltips at the default profile (26 × 52 − 9) |
| CI vs verdict | **0** windows whose printed CI excludes 1.0× while the text says "within ordinary variation" |
| Printed % | every value `< 100%`; no `NaN` / `undefined` anywhere in the DOM |
| Tiers on closed/weak | **0** |
| Tier 2 ⊂ tier 1's cut | every tier-2 window also passes the 30% cut |
| Column overlays | live-window marker aligns with its column to <1px at 5120 / 2560 / 1400 / 900 |
| Narrow layout | numbers hidden below `colWidth 26px`; no right label below 1500px |

### Out-of-sample harness (only needed if you retune thresholds)

Leave-one-weekday-out: train on 4 weekday columns pooled, score on the held-out 5th. Score a
flagged window as `t_heldout − 1`. **Estimate `phi` from the training columns only** — reusing
`TURN[i].phi` leaks the held-out day. The baseline is structurally 0.00, because `t` is
normalised to mean 1.0; the meaningful baseline is the 46% hit rate of a random window.

For the null simulation, draw flat Poisson counts at each row's real `lambda` and run the real
pipeline. **Use a proper PRNG** — a naive LCG overflows 2^53 in JS doubles and silently
degenerates, which produced wrong false-mark counts here once.

---

## 8. Conventions

- All times are **UK clock time**. Slot `k` starts at `08:00 + 15k`. The EST toggle shifts
  labels only; the data is not re-bucketed. For the ~4 weeks a year when UK and US clocks are out
  of step, US-session features land an hour — **four slots** — earlier than labelled.
- Editing this file from a shell: template literals and `×`/`—` get mangled by bash string
  expansion. Apply replacements from a JSON file with `node tools/apply_edits.js edits.json`
  (each `{old, new}` must match exactly once; add `CLAUDE.md` as a second argument to edit this
  file), not inline `node -e` with the text embedded.
- Prose is deliberately specific about uncertainty. If a change makes a stated number wrong,
  change the number — do not soften the sentence into something unfalsifiable.
