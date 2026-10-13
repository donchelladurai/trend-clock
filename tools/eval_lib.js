#!/usr/bin/env node
// Research library behind the October 2026 accuracy study (CLAUDE.md §7, "Accuracy harness").
//
// Everything the board shows is a climatology — on what share of past days was the 20MA trending
// in this window, and where do turns cluster — so the only honest measure of "accuracy" is how
// well those shares predict a day they were not built from. This module turns a bar file into
// per-day × per-window outcome matrices under a named definition of "trending", and scores
// walk-forward predictions of held-out weeks against them. It also tabulates the bar-level state
// (slope ratio, trend age, price side) against what happens in the next fifteen minutes, which is
// what a live layer needs for a calibrated "turn within 15 minutes" figure.
//
//   const E = require('./eval_lib.js');
//   const P = E.load('eurusd', 5, '2026-01-01', '2026-10-09');     // prepare() from gen_row.js, cached
//   const O = E.outcomes(P, { th: 0.015, agg: 'any' });            // days[], open[], bars{}
//   const S = E.walkForward(O, { trainWeeks: 13, testFrom: '2026-08-24', testTo: '2026-10-09' });
//   console.log(S.summary);                                         // Brier skill, AUC, precision at 75%, turn tiers
//
// Definition options (def):
//   th        absolute threshold in daily-ATR units (or use fitTh() to solve it for a pooled share)
//   agg       'any' (board rule: a window is trending if any of its bars is), 'majority', 'all'
//   horizon   multiplier of the 15-minute move: 1 = EMA[t] - EMA[t-L] (board), 2 = over 30 minutes
//   side      true: a bar is trending only if the close sits on the slope's side of the EMA
//   onRatio / offRatio   hysteresis multiples of th for the turn state (board: 2 and 0.5)
//   maLen     EMA length (board: 20; the EMA is recomputed here when it differs)
//
// Scores (walkForward): for each test week, the training set is the trainWeeks weeks before it.
// Trend predictors: all-days share, same-weekday share, and the weekday share shrunk toward the
// all-days one with pseudo-count m. Turn predictors: the board's tiers from the training counts
// (poisUpper + BH at FDR / MID_FDR with phi = 1) and the printed figure pTurn = 1 - exp(-c/days).
'use strict';
const fs = require('fs'), path = require('path');
const { prepare, SLOTS } = require('./gen_row.js');
const ROOT = path.join(__dirname, '..');
const DAY = 86400000;

// label, bar-file stem, group, Yahoo symbol (live probe; cash indices are delayed there)
const INSTRUMENTS = [
  ['FTSE 100', 'ukxgbp', 'Indices'], ['Germany 40', 'grxeur', 'Indices'], ['France 40', 'frxeur', 'Indices'],
  ['Wall Street', 'usa30', 'Indices'], ['US Tech 100', 'nsxusd', 'Indices'], ['US 500', 'spxusd', 'Indices'],
  ['EUR/USD', 'eurusd', 'FX — USD pairs'], ['GBP/USD', 'gbpusd', 'FX — USD pairs'], ['AUD/USD', 'audusd', 'FX — USD pairs'],
  ['USD/CAD', 'usdcad', 'FX — USD pairs'], ['USD/JPY', 'usdjpy', 'FX — USD pairs'], ['USD/CHF', 'usdchf', 'FX — USD pairs'], ['NZD/USD', 'nzdusd', 'FX — USD pairs'],
  ['EUR/GBP', 'eurgbp', 'FX — EUR crosses'], ['EUR/AUD', 'euraud', 'FX — EUR crosses'], ['EUR/JPY', 'eurjpy', 'FX — EUR crosses'],
  ['EUR/CAD', 'eurcad', 'FX — EUR crosses'], ['EUR/CHF', 'eurchf', 'FX — EUR crosses'], ['EUR/NZD', 'eurnzd', 'FX — EUR crosses'],
  ['AUD/JPY', 'audjpy', 'FX — other crosses'], ['Spot Gold', 'xauusd', 'Commodities'],
];
const ymd = s => { const [y, m, d] = s.split('-').map(Number); return Math.floor(Date.UTC(y, m - 1, d) / DAY); };
const fmtDay = d => new Date(d * DAY).toISOString().slice(0, 10);
const weekOf = d => Math.floor((d - 4) / 7);            // Monday-based week index (day 4 = Mon 5 Jan 1970)
const sgn = x => x > 0 ? 1 : x < 0 ? -1 : 0;

// ---- the page's tail and BH, copied verbatim from index.html so the harness scores the real pipeline
function lgamma(x){ const g = [76.18009172947146, -86.50532032941677, 24.01409824083091, -1.231739572450155, .1208650973866179e-2, -.5395239384953e-5];
  let y = x, t = x + 5.5; t -= (x + .5) * Math.log(t); let s = 1.000000000190015; for (let j = 0; j < 6; j++) s += g[j] / ++y; return -t + Math.log(2.5066282746310005 * s / x); }
function gammp(a, x){ if (x <= 0) return 0; const lead = Math.exp(-x + a * Math.log(x) - lgamma(a));
  if (x < a + 1){ let ap = a, sum = 1 / a, del = sum; for (let n = 0; n < 500; n++){ ap++; del *= x / ap; sum += del; if (Math.abs(del) < Math.abs(sum) * 1e-16) break; } return Math.min(1, sum * lead); }
  let b = x + 1 - a, c = 1e300, d = 1 / b, h = d;
  for (let i = 1; i <= 500; i++){ const an = -i * (i - a); b += 2; d = an * d + b; if (Math.abs(d) < 1e-300) d = 1e-300; c = b + an / c; if (Math.abs(c) < 1e-300) c = 1e-300; d = 1 / d; const del = d * c; h *= del; if (Math.abs(del - 1) < 1e-16) break; }
  return Math.max(0, 1 - lead * h); }
function poisUpper(c, lam, phi){ c /= phi; lam /= phi; return c <= 0 ? 1 : gammp(c, lam); }
function bhCutoff(ps, q){ const s = ps.slice().sort((a, b) => a - b); let n = 0; for (let i = 0; i < s.length; i++) if (s[i] <= q * (i + 1) / s.length) n = i + 1; return n ? s[n - 1] : -1; }

// ---- bars -------------------------------------------------------------------------------------
const cache = new Map();
function load(sym, minutes, from = '2026-01-01', to = '2026-10-09'){
  const key = `${sym}|${minutes}|${from}|${to}`;
  if (cache.has(key)) return cache.get(key);
  const f = path.join(ROOT, 'data', `${sym}_m${minutes}.json`);
  if (!fs.existsSync(f)) return null;
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const P = prepare(raw, { minutes, from, to });
  P.sym = sym; P.minutes = minutes; P.from = from; P.to = to;
  cache.set(key, P);
  return P;
}
function ema(c, len){ const n = c.length, e = new Float64Array(n).fill(NaN), a = 2 / (len + 1); let s = 0, v = NaN;
  for (let i = 0; i < n; i++){ if (i < len - 1){ s += c[i]; continue; } if (i === len - 1){ s += c[i]; v = s / len; } else v = a * c[i] + (1 - a) * v; e[i] = v; } return e; }

// ---- outcomes under a definition ---------------------------------------------------------------
function outcomes(P, def){
  const th = def.th; if (!(th > 0)) throw new Error('def.th required (use fitTh)');
  const agg = def.agg || 'any', H = def.horizon || 1, on = (def.onRatio == null ? 2 : def.onRatio) * th, off = (def.offRatio == null ? 0.5 : def.offRatio) * th;
  const { n, c, atrD, days, win, open, L } = P;
  const E = def.maLen && def.maLen !== 20 ? ema(c, def.maLen) : P.ema;
  const d = (H === 1 && E === P.ema) ? P.dm : (() => { const x = new Float64Array(n).fill(NaN); for (let i = H * L; i < n; i++) x[i] = E[i] - E[i - H * L]; return x; })();
  const tr = new Uint8Array(n), st = new Int8Array(n), turn = new Uint8Array(n), ratio = new Float32Array(n).fill(NaN), age = new Int32Array(n), side = new Int8Array(n);
  let started = false, a = 0;
  for (let i = 0; i < n; i++){
    const x = d[i], b = atrD[i];
    if (isNaN(x) || isNaN(b) || !(b > 0)){ started = false; st[i] = 0; a = 0; continue; }
    const r = Math.abs(x) / (th * b); ratio[i] = r;
    side[i] = sgn(c[i] - E[i]);
    let t = r >= 1;
    if (def.side) t = t && sgn(x) === side[i];
    tr[i] = t ? 1 : 0;
    const prev = i > 0 ? st[i - 1] : 0;
    st[i] = (prev !== 0 && sgn(x) === prev && Math.abs(x) >= off * b) ? prev : (Math.abs(x) >= on * b ? sgn(x) : 0);
    if (started && st[i] !== st[i - 1]){ turn[i] = 1; a = 0; } else a++;
    age[i] = a; started = true;
  }
  const out = days.map(dd => {
    const trend = new Uint8Array(SLOTS), turns = new Uint8Array(SLOTS), dir = new Int8Array(SLOTS);
    for (const k of open){ let cnt = 0, tu = 0, up = 0, dn = 0; const m = win[k].length;
      for (const p of win[k]){ const i = dd.idx[p]; cnt += tr[i]; tu += turn[i]; if (tr[i]){ if (d[i] > 0) up++; else dn++; } }
      trend[k] = agg === 'all' ? (cnt === m ? 1 : 0) : agg === 'majority' ? (cnt * 2 > m ? 1 : 0) : (cnt > 0 ? 1 : 0);
      turns[k] = tu; dir[k] = up > dn ? 1 : dn > up ? -1 : 0; }
    return { day: dd.day, wd: dd.wd, week: weekOf(dd.day), idx: dd.idx, trend, turns, dir };
  });
  return { days: out, open: open.slice(), win, bars: { tr, st, turn, ratio, age, side, d }, th, def, P };
}

// Mean window share over open windows and all days — the quantity fit_th.js matches across charts.
function meanShare(O){ let s = 0, n = 0; for (const dd of O.days) for (const k of O.open){ s += dd.trend[k]; n++; } return n ? s / n : NaN; }
// Solve th so that the pooled mean share across the given prepared instruments equals target.
function fitTh(Ps, def, target, lo = 0.002, hi = 0.15){
  const pooled = th => { let s = 0, n = 0; for (const P of Ps){ const m = meanShare(outcomes(P, Object.assign({}, def, { th }))); if (!isNaN(m)){ s += m; n++; } } return s / n; };
  for (let i = 0; i < 30; i++){ const mid = (lo + hi) / 2; if (pooled(mid) > target) lo = mid; else hi = mid; }
  return (lo + hi) / 2;
}

// ---- scoring ------------------------------------------------------------------------------------
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
function brier(p, y){ let s = 0; for (let i = 0; i < p.length; i++) s += (p[i] - y[i]) ** 2; return s / p.length; }
function logloss(p, y){ let s = 0; for (let i = 0; i < p.length; i++){ const q = Math.min(1 - 1e-6, Math.max(1e-6, p[i])); s -= y[i] ? Math.log(q) : Math.log(1 - q); } return s / p.length; }
function auc(p, y){ const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]); let r = 1, i = 0, sumPos = 0, nPos = 0, nNeg = 0;
  while (i < idx.length){ let j = i; while (j + 1 < idx.length && p[idx[j + 1]] === p[idx[i]]) j++; const avg = (r + r + (j - i)) / 2; for (let k = i; k <= j; k++){ if (y[idx[k]]) { sumPos += avg; nPos++; } else nNeg++; } r += j - i + 1; i = j + 1; }
  return nPos && nNeg ? (sumPos - nPos * (nPos + 1) / 2) / (nPos * nNeg) : NaN; }
// Reliability table: observed rate by predicted-probability bin.
function reliability(p, y, bins = [0, .25, .4, .5, .6, .7, .75, .8, .85, .9, 1.01]){ const out = [];
  for (let b = 0; b + 1 < bins.length; b++){ let n = 0, s = 0, ps = 0; for (let i = 0; i < p.length; i++) if (p[i] >= bins[b] && p[i] < bins[b + 1]){ n++; s += y[i]; ps += p[i]; }
    out.push({ lo: bins[b], hi: Math.min(1, bins[b + 1]), n, pred: n ? ps / n : NaN, obs: n ? s / n : NaN }); } return out; }

// Training statistics from a set of outcome days: shares and turn tiers per window.
function fitTrain(train, open, opts = {}){
  const fdr = opts.fdr == null ? 0.10 : opts.fdr, midFdr = opts.midFdr == null ? 0.40 : opts.midFdr, minLam = opts.minLam == null ? 1 : opts.minLam;
  const nd = train.length, sAll = new Float64Array(SLOTS), cAll = new Float64Array(SLOTS);
  const sWd = [0, 1, 2, 3, 4].map(() => new Float64Array(SLOTS)), nWd = [0, 0, 0, 0, 0];
  for (const dd of train){ const w = dd.wd - 1; nWd[w]++; for (const k of open){ sAll[k] += dd.trend[k]; cAll[k] += dd.turns[k]; sWd[w][k] += dd.trend[k]; } }
  for (const k of open){ sAll[k] /= nd || 1; for (let w = 0; w < 5; w++) sWd[w][k] = nWd[w] ? sWd[w][k] / nWd[w] : sAll[k]; }
  const total = open.reduce((a, k) => a + cAll[k], 0), lam = total / open.length, weak = lam < minLam;
  const p = new Float64Array(SLOTS).fill(1), tier = new Int8Array(SLOTS), pTurn = new Float64Array(SLOTS);
  for (const k of open){ p[k] = poisUpper(cAll[k], lam, 1); pTurn[k] = 1 - Math.exp(-cAll[k] / nd); }
  if (!weak){ const ps = open.map(k => p[k]); const c2 = bhCutoff(ps, fdr), c1 = bhCutoff(ps, midFdr); for (const k of open) tier[k] = p[k] <= c2 ? 2 : p[k] <= c1 ? 1 : 0; }
  return { nd, nWd, sAll, sWd, cAll, lam, weak, p, tier, pTurn, ratio: Array.from(cAll, x => lam ? x / lam : 0) };
}

// Walk-forward: every test week is predicted from the trainWeeks weeks before it.
// opts: trainWeeks, testFrom, testTo (ymd strings), shrink (pseudo-count m for the weekday share; default 10),
//       thr (the "trend if >=" level; default 0.75), minTrainDays (skip a test week with fewer; default 20)
function walkForward(O, opts = {}){
  const trainWeeks = opts.trainWeeks || 13, shrink = opts.shrink == null ? 10 : opts.shrink, thr = opts.thr == null ? 0.75 : opts.thr;
  const tFrom = weekOf(ymd(opts.testFrom || '2026-08-24')), tTo = weekOf(ymd(opts.testTo || '2026-10-09')), minTrain = opts.minTrainDays == null ? 20 : opts.minTrainDays;
  const days = O.days, open = O.open;
  const pred = { all: [], wd: [], shr: [], base: [] }, y = [], yTurn = [], cnt = [], meta = [];
  const tierRows = [];   // one per test day x window: {tier, pTurn, ratio, y, count}
  let weeksScored = 0, weeksSkipped = 0;
  for (let w = tFrom; w <= tTo; w++){
    const test = days.filter(d => d.week === w); if (!test.length) continue;
    const train = days.filter(d => d.week < w && d.week >= w - trainWeeks);
    if (train.length < minTrain){ weeksSkipped++; continue; }
    weeksScored++;
    const F = fitTrain(train, open, opts);
    const base = mean(open.map(k => F.sAll[k]));
    for (const dd of test) for (const k of open){
      const sw = F.sWd[dd.wd - 1][k], nw = F.nWd[dd.wd - 1];
      pred.all.push(F.sAll[k]); pred.wd.push(sw); pred.shr.push((nw * sw + shrink * F.sAll[k]) / (nw + shrink)); pred.base.push(base);
      y.push(dd.trend[k]); yTurn.push(dd.turns[k] > 0 ? 1 : 0); cnt.push(dd.turns[k]); meta.push({ day: dd.day, wd: dd.wd, k });
      tierRows.push({ tier: F.weak ? -1 : F.tier[k], pTurn: F.pTurn[k], ratio: F.ratio[k], y: dd.turns[k] > 0 ? 1 : 0, count: dd.turns[k], lamDay: F.lam / F.nd });
    }
  }
  const score = p => ({ brier: brier(p, y), logloss: logloss(p, y), auc: auc(p, y), skill: 1 - brier(p, y) / brier(pred.base, y),
    precAt: (() => { const sel = p.map((v, i) => v >= thr ? i : -1).filter(i => i >= 0); return { n: sel.length, obs: sel.length ? mean(sel.map(i => y[i])) : NaN, pred: sel.length ? mean(sel.map(i => p[i])) : NaN }; })(),
    topDecile: (() => { const idx = p.map((v, i) => i).sort((a, b) => p[b] - p[a]).slice(0, Math.max(1, Math.floor(p.length / 10))); return { obs: mean(idx.map(i => y[i])), pred: mean(idx.map(i => p[i])) }; })(),
    bottomDecile: (() => { const idx = p.map((v, i) => i).sort((a, b) => p[a] - p[b]).slice(0, Math.max(1, Math.floor(p.length / 10))); return { obs: mean(idx.map(i => y[i])), pred: mean(idx.map(i => p[i])) }; })(),
    reliability: reliability(p, y) });
  const turns = {};
  const lamTest = mean(cnt);
  for (const t of [2, 1, 0, -1]){ const rows = tierRows.filter(r => r.tier === t); turns[t] = { n: rows.length, hit: mean(rows.map(r => r.y)), predP: mean(rows.map(r => r.pTurn)), heldRatio: rows.length ? mean(rows.map(r => r.count)) / lamTest : NaN, trainRatio: mean(rows.map(r => r.ratio)) }; }
  turns.baseHit = mean(yTurn); turns.lamDay = lamTest;
  return { n: y.length, weeksScored, weeksSkipped, baseRate: mean(y), all: score(pred.all), wd: score(pred.wd), shr: score(pred.shr), turns, raw: { pred, y, yTurn, cnt, meta, tierRows },
    summary: { n: y.length, weeks: weeksScored, baseRate: +mean(y).toFixed(3), skillAll: +(1 - brier(pred.all, y) / brier(pred.base, y)).toFixed(4), skillWd: +(1 - brier(pred.wd, y) / brier(pred.base, y)).toFixed(4), skillShr: +(1 - brier(pred.shr, y) / brier(pred.base, y)).toFixed(4),
      aucAll: +auc(pred.all, y).toFixed(3), aucWd: +auc(pred.wd, y).toFixed(3), prec75All: score(pred.all).precAt, prec75Wd: score(pred.wd).precAt, turnTier2: turns[2], turnTier1: turns[1], turnTier0: turns[0], turnBaseHit: +mean(yTurn).toFixed(3) } };
}

// Split-half reliability of the window profile: correlation of the per-window shares between odd and even days.
function splitHalf(O){ const a = new Float64Array(SLOTS), b = new Float64Array(SLOTS); let na = 0, nb = 0;
  O.days.forEach((dd, i) => { if (i % 2){ nb++; for (const k of O.open) b[k] += dd.trend[k]; } else { na++; for (const k of O.open) a[k] += dd.trend[k]; } });
  const x = O.open.map(k => a[k] / na), y = O.open.map(k => b[k] / nb); return corr(x, y); }
function corr(a, b){ const n = a.length, ma = mean(a), mb = mean(b); let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++){ ab += (a[i] - ma) * (b[i] - mb); aa += (a[i] - ma) ** 2; bb += (b[i] - mb) ** 2; } return ab / Math.sqrt(aa * bb); }

// ---- bar-level state against the next fifteen minutes --------------------------------------------
// For every in-hours bar of every valid day in [from, to] (ymd strings; default all), with the next
// hBars bars still inside the grid: the live features and what followed. Returns parallel arrays.
function stateRows(O, opts = {}){
  const { P, bars, days, open, win } = O, L = P.L, hBars = opts.hBars || L, perDay = P.perDay;
  const from = opts.from ? ymd(opts.from) : -Infinity, to = opts.to ? ymd(opts.to) : Infinity;
  const openSet = new Set(open), posWin = new Int16Array(perDay); for (const k of open) for (const p of win[k]) posWin[p] = k;
  const rows = { k: [], ratio: [], state: [], age: [], side: [], dRatio: [], turnNext: [], turnsNext: [], trendNext: [], holds: [], ratioNext: [], day: [], wd: [], trendingNow: [], windowShare: [] };
  for (const dd of days){ if (dd.day < from || dd.day > to) continue;
    for (let p = 0; p + hBars < perDay; p++){ const k = posWin[p]; if (!openSet.has(k)) continue; const i = dd.idx[p];
      if (isNaN(bars.ratio[i]) || isNaN(bars.ratio[i - L] ?? NaN)) continue;
      let tn = 0; for (let j = 1; j <= hBars; j++) tn += bars.turn[i + j];
      const kn = posWin[p + hBars];
      rows.k.push(k); rows.ratio.push(bars.ratio[i]); rows.state.push(bars.st[i]); rows.age.push(bars.age[i]); rows.side.push(bars.side[i]); rows.dRatio.push(bars.ratio[i] - bars.ratio[i - L]);
      rows.turnNext.push(tn > 0 ? 1 : 0); rows.turnsNext.push(tn); rows.trendNext.push(k + 1 < SLOTS && openSet.has(k + 1) ? dd.trend[k + 1] : -1);
      rows.holds.push(bars.st[i] !== 0 && tn === 0 ? 1 : 0); rows.ratioNext.push(bars.ratio[i + hBars]); rows.day.push(dd.day); rows.wd.push(dd.wd); rows.trendingNow.push(bars.tr[i]); rows.windowShare.push(kn);
    } }
  return rows;
}
// Bucket a target by one or two keys: table[key] = {n, rate}.
function bucket(rows, keyFn, targetFn){ const t = new Map(); const n = rows.k.length;
  for (let i = 0; i < n; i++){ const key = keyFn(i); if (key == null) continue; let e = t.get(key); if (!e){ e = { n: 0, s: 0 }; t.set(key, e); } e.n++; e.s += targetFn(i); }
  return Array.from(t, ([key, e]) => ({ key, n: e.n, rate: e.s / e.n })).sort((a, b) => String(a.key) < String(b.key) ? -1 : 1); }

module.exports = { INSTRUMENTS, SLOTS, load, outcomes, meanShare, fitTh, fitTrain, walkForward, splitHalf, corr, stateRows, bucket, poisUpper, bhCutoff, brier, logloss, auc, reliability, ymd, fmtDay, weekOf, mean };

if (require.main === module){
  const sym = process.argv[2] || 'eurusd', minutes = +(process.argv[3] || 5), th = +(process.argv[4] || (minutes === 2 ? 0.027 : 0.015));
  const P = load(sym, minutes); if (!P){ console.error('no bars for', sym, minutes); process.exit(1); }
  const O = outcomes(P, { th, agg: 'any' });
  console.log(`${sym} ${minutes}m th ${th}: ${O.days.length} valid days ${fmtDay(O.days[0].day)}–${fmtDay(O.days[O.days.length - 1].day)}, open ${O.open.length}, mean share ${meanShare(O).toFixed(3)}, split-half r ${splitHalf(O).toFixed(2)}`);
  const S = walkForward(O, { trainWeeks: 13, testFrom: '2026-08-24', testTo: '2026-10-09' });
  console.log(JSON.stringify(S.summary, null, 1));
  const R = stateRows(O, { from: '2026-06-22' });
  console.log('state rows', R.k.length, 'P(turn next 15m) by slope-ratio bucket:', JSON.stringify(bucket(R, i => R.state[i] === 0 ? null : Math.min(4, Math.floor(R.ratio[i] * 2)) / 2, i => R.turnNext[i])));
}
