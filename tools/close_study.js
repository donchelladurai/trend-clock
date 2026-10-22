#!/usr/bin/env node
// Market-close direction study — the six index rows on the 2- and 5-minute charts, on the owner's
// trend average: the 20-period simple moving average. The owner's 8 is a power-trend average and the
// 200 a bias, and neither predicts trends (22 Oct 2026); an 8SMA state and a 200SMA side reading were
// measured here for one evening (commit db69614), added nothing, and were removed. No EMA, ever.
//
//   node tools/close_study.js [--close 90,15] [--from 2026-01-26] [--to 2026-10-12] [--th data/th_fit.json]
//                             [--out data/close_study.json] [--quiet]
//
// The question (22 Oct 2026): over the last 90 minutes of the cash session, and over its final 15,
// does the market follow the day's dominant trend direction or reverse it? Only same/opposite is
// read, never up/down. First built on the board's 20EMA; rebuilt the same day on the SMA when the
// owner said the charts carry the 200, 20 and 8 SMA and never an EMA.
//
// Definitions
//   cash session   FTSE 100 08:00–16:30 London; Germany 40 and France 40 09:00–17:30 Berlin/Paris
//                  (16:30 UK: the EU and UK clocks change on the same dates); Wall Street, US Tech 100
//                  and US 500 09:30–16:00 New York (14:30–21:00 UK outside the clock-gap weeks, when
//                  the New York clock is used and the window lands an hour earlier in UK time).
//   close          the last N minutes of the cash session, N = 90 and 15: 15:00–16:30 and 16:15–16:30 UK,
//                  14:30–16:00 and 15:45–16:00 New York. N is rounded to whole bars, so on the 2-minute
//                  chart the final window is 8 bars = 16 minutes (16:14–16:30 UK), as the board's
//                  15-minute move is 8 bars there.
//   reference      the segment, or bias, whose direction the close is compared with:
//                    day      the cash session up to the start of the close window (both windows);
//                    day90    the session up to 15:00 UK / 14:30 ET, the 90-minute window's day (15-minute window);
//                    pre      the 75 minutes before the final window, 15:00–16:15 UK (15-minute window);
//                    full     from 08:00 UK, the board's day start, to the window (US rows only).
//   readings       state20: sign of (bars in the +1 state − bars in the −1 state) over the segment, where
//                  the state is the board's trend-state rule (CLAUDE.md §1b) on the 20SMA — the average's
//                  move over 15 minutes of clock time against TH × the daily ATR, hysteresis 2× / 0.5×, TH
//                  fitted per chart by tools/fit_th.js at a pooled share of 0.45 (data/th_fit.json, key
//                  sma20), via eval_lib outcomes(); fresh20: the window's balance counting only states that
//                  begin inside it (the leading run of the state in force at the window's start is dropped),
//                  since a state carried in from before the window follows the segment that produced it by
//                  construction; price: sign of (last close of the segment − open of its first bar). Zero =
//                  no direction.
//   outcome        follow = the close has the reference's sign; reverse = the opposite sign; none = the
//                  close has no direction (state balance exactly 0, or a zero price move).
//   valid day      the board's valid day (gen_row.js), with at least 90% of the bars in the reference and
//                  close segments real, at least half of the close bars moving, a daily ATR, and the
//                  exchange not on holiday (the CFD feeds print bars on cash holidays).
//
// Output — data/close_study.json:
//   { built, def, sample, instruments[], closes[], meta, records, summary }
//   records[label][chart][close] = [rec]; meta[label][chart][close] = { th, L, validDays, used, from, to, dropped, droppedDates }
//   summary[close] = { perInstrument[label][chart]["reading.ref"], pooled[market][chart]["reading.ref" | facts[len]], facts[label][chart][len] }
//   rec = { d, wd, atr, p0, p1, p2, dm, cm, rng, crng, nb, nc, thirds?: [pm × 3], path?: [...],
//           refs: { day90?, pre?, full?: { p0, dm, nb, rng } },
//           ma: { "20": E } },  E = { up, dn, cu, cd, ct, ctr, two, s1, r1, s2, em, ecm, seq, thirds?: [{up, dn} × 3], refs: { name: { up, dn, em } } }
//   d date (UK), wd 1–5, atr the day's 14-day ATR; p0 session open, p1 close before the close window,
//   p2 cash close; dm / cm the day / close price move in ATR units; rng / crng the segment ranges in ATR
//   units; nb / nc bars in the day / close segment; thirds (90-minute window) the price move of each
//   30-minute part; path (15-minute window) every close bar's close against p1 in ATR units. Under the
//   average E: up / dn bars in the +1 / −1 state over the day, cu / cd
//   over the close; ct turns and ctr trending bars in the close; two = both states seen in the close; s1
//   the state and r1 the slope ratio on the last bar before the close, s2 the state on the final bar;
//   em / ecm the average's move over the day / close in ATR units; seq the state of every close bar as
//   + 0 -; thirds the state bars of each part; refs the same counts over the other reference segments.
//   Everything a later aggregation needs is in the record: nothing has to be recomputed from the bars.
'use strict';
const fs = require('fs'), path = require('path');
const E = require('./eval_lib.js');
const ROOT = path.join(__dirname, '..');
const DAY = 86400000;
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i + 1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
const FROM = args.from || '2026-01-26', TO = args.to || '2026-10-12', OUT = args.out || path.join(ROOT, 'data', 'close_study.json'), QUIET = !!args.quiet;
const CLOSES = String(args.close || '90,15').split(',').map(Number), MAIN = 90;
const CHARTS = [2, 5], LENS = [20];
const FIT = JSON.parse(fs.readFileSync(args.th || path.join(ROOT, 'data', 'th_fit.json'), 'utf8'));
const TH = {}; for (const len of LENS){ const f = FIT['sma' + len]; if (!f || !(f.th[2] > 0) || !(f.th[5] > 0)) throw new Error(`data/th_fit.json has no sma${len} fit: run node tools/fit_th.js --ma sma --maLen ${len}`); TH[len] = { 2: f.th[2], 5: f.th[5] }; }
const REAL_SEG = 0.9, MOVE_SEG = 0.5;
const sgn = x => x > 0 ? 1 : x < 0 ? -1 : 0, r3 = x => +x.toFixed(3), r4 = x => +x.toFixed(4);
const mean = a => a.length ? a.reduce((x, y) => x + y, 0) / a.length : NaN;
const median = a => { if (!a.length) return NaN; const s = a.slice().sort((x, y) => x - y), m = s.length >> 1; return s.length % 2 ? s[m] : (s[m - 1] + s[m]) / 2; };

// Exchange holidays inside the sample (cash market closed; the CFD feeds still print bars).
const HOL = {
  LSE:   ['2026-04-03', '2026-04-06', '2026-05-04', '2026-05-25', '2026-08-31'],
  XETRA: ['2026-04-03', '2026-04-06', '2026-05-01', '2026-05-25'],
  PARIS: ['2026-04-03', '2026-04-06', '2026-05-01'],
  NYSE:  ['2026-02-16', '2026-04-03', '2026-05-25', '2026-06-19', '2026-07-03', '2026-09-07'],
};
const INSTRUMENTS = [
  { label: 'FTSE 100',    stem: 'ukxgbp', market: 'Europe', tz: 'Europe/London',    open: [8, 0],  close: [16, 30], hol: 'LSE' },
  { label: 'Germany 40',  stem: 'grxeur', market: 'Europe', tz: 'Europe/Berlin',    open: [9, 0],  close: [17, 30], hol: 'XETRA' },
  { label: 'France 40',   stem: 'frxeur', market: 'Europe', tz: 'Europe/Paris',     open: [9, 0],  close: [17, 30], hol: 'PARIS' },
  { label: 'Wall Street', stem: 'usa30',  market: 'US',     tz: 'America/New_York', open: [9, 30], close: [16, 0],  hol: 'NYSE' },
  { label: 'US Tech 100', stem: 'nsxusd', market: 'US',     tz: 'America/New_York', open: [9, 30], close: [16, 0],  hol: 'NYSE' },
  { label: 'US 500',      stem: 'spxusd', market: 'US',     tz: 'America/New_York', open: [9, 30], close: [16, 0],  hol: 'NYSE' },
];
const MARKETS = { Europe: INSTRUMENTS.filter(i => i.market === 'Europe').map(i => i.label), US: INSTRUMENTS.filter(i => i.market === 'US').map(i => i.label) };
const REFS = ['day', 'day90', 'pre', 'full'];
const METHODS = [{ key: 'state20', kind: 'state', len: 20 }, { key: 'fresh20', kind: 'fresh', len: 20 }, { key: 'price', kind: 'price' }];

// ---- clock: a wall-clock time in a zone on a UK calendar day → position on the board's 08:00 UK grid
const fmtCache = new Map();
function wall(tz, utcMs){ let f = fmtCache.get(tz); if (!f){ f = new Intl.DateTimeFormat('en-GB', { timeZone: tz, hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' }); fmtCache.set(tz, f); }
  const p = {}; for (const x of f.formatToParts(new Date(utcMs))) p[x.type] = x.value; return Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute); }
function zonedUtc(dayNum, hh, mm, tz){ const want = dayNum * DAY + (hh * 60 + mm) * 60000; let u = want; for (let k = 0; k < 2; k++) u = want - (wall(tz, u) - u); return u; }
const posOf = (B, dayNum, utcMs) => ((wall('Europe/London', utcMs) - dayNum * DAY) / 60000 - 480) / B;

// ---- bars with opens, aligned to prepare()'s filtered series
function opens(stem, minutes, n){
  const raw = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', `${stem}_m${minutes}.json`), 'utf8')).filter(b => b[4] > 0).sort((a, b) => a[0] - b[0]);
  const o = []; let last = -1; for (const b of raw){ if (b[0] === last) continue; last = b[0]; o.push(b[1]); }
  if (o.length !== n) throw new Error(`${stem} m${minutes}: ${o.length} bars with opens against ${n} prepared`);
  return o;
}

// ---- one instrument × chart → records per close window
function study(inst, minutes){
  const P = E.load(inst.stem, minutes, FROM, TO); if (!P) return null;
  const O = {}; for (const len of LENS) O[len] = E.outcomes(P, { th: TH[len][minutes], agg: 'any', maLen: len });
  const { c, hi, lo, real, atrD } = P, B = P.B, o = opens(inst.stem, minutes, P.n);
  const hol = new Set(HOL[inst.hol]), SYM = { '1': '+', '0': '0', '-1': '-' };
  const out = {}; for (const N of CLOSES) out[N] = { recs: [], dropped: { holiday: [], grid: [], sparse: [], dead: [], noAtr: [] } };
  const drop = (k, date) => { for (const N of CLOSES) out[N].dropped[k].push(date); };
  const priceSeg = (idx, a, b) => { let re = 0, mv = 0, h = -Infinity, l = Infinity; // real share, moving share, range over positions [a, b)
    for (let p = a; p < b; p++){ const i = idx[p]; re += real[i]; if (c[i] !== c[i - 1] || hi[i] !== lo[i]) mv++; if (hi[i] > h) h = hi[i]; if (lo[i] < l) l = lo[i]; }
    return { real: re / (b - a), move: mv / (b - a), rng: h - l, n: b - a }; };
  const maSeg = (bars, idx, a, b) => { let up = 0, dn = 0, tu = 0, trn = 0; for (let p = a; p < b; p++){ const i = idx[p], s = bars.st[i]; if (s > 0) up++; else if (s < 0) dn++; tu += bars.turn[i]; trn += bars.tr[i]; } return { up, dn, turns: tu, trending: trn }; };
  for (const dd of P.days){
    const date = E.fmtDay(dd.day);
    if (hol.has(date)){ drop('holiday', date); continue; }
    const pOpen = posOf(B, dd.day, zonedUtc(dd.day, inst.open[0], inst.open[1], inst.tz)), pClose = posOf(B, dd.day, zonedUtc(dd.day, inst.close[0], inst.close[1], inst.tz));
    if (!Number.isInteger(pOpen) || !Number.isInteger(pClose) || pOpen < 0 || pClose > P.perDay){ drop('grid', date); continue; }
    const idx = dd.idx, atr = atrD[idx[pOpen]]; if (!(atr > 0)){ drop('noAtr', date); continue; }
    const pT90 = pClose - Math.round(MAIN / B);
    for (const N of CLOSES){
      const nC = Math.round(N / B), pT = pClose - nC, R = out[N];
      const D = priceSeg(idx, pOpen, pT), C = priceSeg(idx, pT, pClose);
      if (D.real < REAL_SEG || C.real < REAL_SEG){ R.dropped.sparse.push(date); continue; }
      if (C.move < MOVE_SEG){ R.dropped.dead.push(date); continue; }
      const i0 = idx[pOpen], i1 = idx[pT - 1], i2 = idx[pClose - 1], p0 = o[i0], p1 = c[i1], p2 = c[i2];
      const refList = []; if (N !== MAIN && pT90 > pOpen && pT90 < pT) refList.push(['day90', pOpen, pT90], ['pre', pT90, pT]); if (inst.market === 'US' && pOpen > 0) refList.push(['full', 0, pT]);
      const rec = { d: date, wd: dd.wd, atr: r4(atr), p0, p1, p2, dm: r3((p1 - p0) / atr), cm: r3((p2 - p1) / atr), rng: r3(D.rng / atr), crng: r3(C.rng / atr), nb: D.n, nc: C.n, refs: {}, ma: {} };
      const third = nC / 3, thirds = N === MAIN && nC % 3 === 0 ? [0, 1, 2].map(t => [pT + t * third, pT + (t + 1) * third]) : null;
      if (thirds) rec.thirds = thirds.map(([a, b]) => r3((c[idx[b - 1]] - c[idx[a] - 1]) / atr));
      if (N !== MAIN){ rec.path = []; for (let p = pT; p < pClose; p++) rec.path.push(r3((c[idx[p]] - p1) / atr)); }
      for (const [name, a, b] of refList){ const S = priceSeg(idx, a, b); rec.refs[name] = { p0: o[idx[a]], dm: r3((c[idx[b - 1]] - o[idx[a]]) / atr), nb: S.n, rng: r3(S.rng / atr) }; }
      for (const len of LENS){ const bars = O[len].bars, MA = O[len].ma, Dm = maSeg(bars, idx, pOpen, pT), Cm = maSeg(bars, idx, pT, pClose);
        let seq = ''; for (let p = pT; p < pClose; p++) seq += SYM[String(bars.st[idx[p]])];
        const e = { up: Dm.up, dn: Dm.dn, cu: Cm.up, cd: Cm.dn, ct: Cm.turns, ctr: Cm.trending, two: Cm.up > 0 && Cm.dn > 0 ? 1 : 0, s1: bars.st[i1], r1: r3(bars.ratio[i1]), s2: bars.st[i2],
          em: r3((MA[i1] - MA[i0]) / atr), ecm: r3((MA[i2] - MA[i1]) / atr), seq, refs: {} };
        if (thirds) e.thirds = thirds.map(([a, b]) => { const S = maSeg(bars, idx, a, b); return { up: S.up, dn: S.dn }; });
        for (const [name, a, b] of refList){ const S = maSeg(bars, idx, a, b); e.refs[name] = { up: S.up, dn: S.dn, em: r3((MA[idx[b - 1]] - MA[idx[a]]) / atr) }; }
        rec.ma[len] = e; }
      R.recs.push(rec);
    }
  }
  return { byClose: out, th: Object.fromEntries(LENS.map(len => [len, TH[len][minutes]])), L: P.L, perDay: P.perDay, validDays: P.days.length };
}

// ---- aggregation: the same functions a page or a later tool would use on the records
function freshDir(e){ let s = e.seq; if (e.s1 !== 0){ const ch = e.s1 > 0 ? '+' : '-'; let i = 0; while (i < s.length && s[i] === ch) i++; s = s.slice(i); }
  let up = 0, dn = 0; for (const ch of s){ if (ch === '+') up++; else if (ch === '-') dn++; } return sgn(up - dn); }
function refDir(r, method, ref){ // the reference's direction, or null when the record has no such reference
  if (method.kind === 'price'){ const s = ref === 'day' ? r : r.refs[ref]; return s ? sgn(s.dm) : null; }
  const e = r.ma[method.len], s = ref === 'day' ? e : e.refs[ref]; return s ? sgn(s.up - s.dn) : null; }
function refStrength(r, method, ref){
  if (method.kind === 'price'){ const s = ref === 'day' ? r : r.refs[ref]; return Math.abs(s.dm); }
  const e = r.ma[method.len], s = ref === 'day' ? e : e.refs[ref], nb = ref === 'day' ? r.nb : r.refs[ref].nb; return Math.abs(s.up - s.dn) / nb; }
function closeDir(r, method){ if (method.kind === 'price') return sgn(r.cm); const e = r.ma[method.len]; return method.kind === 'state' ? sgn(e.cu - e.cd) : freshDir(e); }
function wilson(k, n, z = 1.96){ if (!n) return [NaN, NaN]; const p = k / n, z2 = z * z, den = 1 + z2 / n, cen = (p + z2 / (2 * n)) / den, half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den; return [cen - half, cen + half]; }
// Follow share with a date-clustered interval (instrument-days on the same date are one cluster).
function tally(recs, method, ref){
  recs = recs.filter(r => refDir(r, method, ref) !== null); if (!recs.length) return null;
  const out = { days: recs.length, noDay: 0, follow: 0, reverse: 0, none: 0, quiet: 0, cont: [], byDate: new Map() };
  const dec = [];
  for (const r of recs){ const dd = refDir(r, method, ref); if (dd === 0){ out.noDay++; continue; } dec.push(r); const cd = closeDir(r, method);
    let e = out.byDate.get(r.d); if (!e){ e = { n: 0, f: 0 }; out.byDate.set(r.d, e); }
    if (cd === 0){ out.none++; if (method.kind !== 'price' && r.ma[method.len].cu + r.ma[method.len].cd === 0) out.quiet++; } else { e.n++; if (cd === dd){ out.follow++; e.f++; } else out.reverse++; }
    out.cont.push(r.cm * dd); }
  const n = out.follow + out.reverse, p = n ? out.follow / n : NaN;
  let v = 0; for (const e of out.byDate.values()) v += (e.f - p * e.n) ** 2; const se = n ? Math.sqrt(v) / n : NaN;
  const med = median(dec.map(r => refStrength(r, method, ref))), split = {};
  for (const [name, keep] of [['strong', x => x >= med], ['weak', x => x < med]]){ let f = 0, rv = 0, no = 0, ct = [];
    for (const r of dec){ if (!keep(refStrength(r, method, ref))) continue; const dd = refDir(r, method, ref), cd = closeDir(r, method); if (cd === 0) no++; else if (cd === dd) f++; else rv++; ct.push(r.cm * dd); }
    split[name] = { follow: f, reverse: rv, none: no, pFollow: f + rv ? r3(f / (f + rv)) : null, cont: r3(mean(ct)) }; }
  const cm = mean(out.cont), sd = Math.sqrt(out.cont.reduce((s, x) => s + (x - cm) ** 2, 0) / Math.max(1, out.cont.length - 1));
  return { days: out.days, noDay: out.noDay, follow: out.follow, reverse: out.reverse, none: out.none, quiet: out.quiet, decided: n, pFollow: n ? r3(p) : null,
    ci: n ? wilson(out.follow, n).map(r3) : null, ciCluster: n ? [r3(p - 1.96 * se), r3(p + 1.96 * se)] : null, dates: out.byDate.size,
    cont: r3(cm), contSe: r3(sd / Math.sqrt(out.cont.length || 1)), medStrength: r3(med), split };
}
function closeFacts(recs, len){ // what the close window looks like on this average
  const M = r => r.ma[len];
  const any = recs.filter(r => M(r).cu + M(r).cd > 0).length, two = recs.filter(r => M(r).two).length, turns = mean(recs.map(r => M(r).ct)), trending = mean(recs.map(r => M(r).ctr / r.nc));
  const s1 = recs.filter(r => M(r).s1 !== 0), s1follow = s1.filter(r => sgn(r.cm) === M(r).s1).length, s1rev = s1.filter(r => sgn(r.cm) === -M(r).s1).length;
  const agree = recs.filter(r => sgn(M(r).up - M(r).dn) !== 0 && sgn(r.dm) !== 0), agreeN = agree.filter(r => sgn(M(r).up - M(r).dn) === sgn(r.dm)).length;
  const both = recs.filter(r => sgn(M(r).cu - M(r).cd) !== 0 && sgn(r.cm) !== 0), bothN = both.filter(r => sgn(M(r).cu - M(r).cd) === sgn(r.cm)).length;
  const fresh = recs.filter(r => freshDir(M(r)) !== 0), freshP = fresh.filter(r => sgn(r.cm) !== 0), freshN = freshP.filter(r => freshDir(M(r)) === sgn(r.cm)).length;
  return { anyState: r3(any / recs.length), bothStates: r3(two / recs.length), turns: r3(turns), trendingShare: r3(trending), absClose: r3(mean(recs.map(r => Math.abs(r.cm)))), absDay: r3(mean(recs.map(r => Math.abs(r.dm)))),
    inTrendAtClose: s1.length, inTrendFollow: s1follow, inTrendReverse: s1rev, pInTrendFollow: s1follow + s1rev ? r3(s1follow / (s1follow + s1rev)) : null,
    methodsAgreeDay: agree.length ? r3(agreeN / agree.length) : null, methodsAgreeDayN: agree.length, methodsAgreeClose: both.length ? r3(bothN / both.length) : null, methodsAgreeCloseN: both.length,
    freshAny: r3(fresh.length / recs.length), freshAgreeClose: freshP.length ? r3(freshN / freshP.length) : null, freshAgreeCloseN: freshP.length };
}

// ---- run
const built = new Date().toISOString().slice(0, 10), records = {}, meta = {}, summary = {};
for (const N of CLOSES) summary[N] = { perInstrument: {}, pooled: {}, facts: {} };
for (const inst of INSTRUMENTS){ records[inst.label] = {}; meta[inst.label] = {};
  for (const m of CHARTS){ const S = study(inst, m); if (!S){ console.error(`no bars for ${inst.label} m${m}`); continue; }
    records[inst.label][m] = {}; meta[inst.label][m] = {};
    for (const N of CLOSES){ const R = S.byClose[N]; records[inst.label][m][N] = R.recs;
      meta[inst.label][m][N] = { th: S.th, L: S.L, validDays: S.validDays, used: R.recs.length, from: R.recs[0]?.d, to: R.recs[R.recs.length - 1]?.d, dropped: Object.fromEntries(Object.entries(R.dropped).map(([k, v]) => [k, v.length])), droppedDates: R.dropped };
      const T = summary[N]; T.perInstrument[inst.label] = T.perInstrument[inst.label] || {}; T.facts[inst.label] = T.facts[inst.label] || {}; T.perInstrument[inst.label][m] = {}; T.facts[inst.label][m] = {};
      for (const method of METHODS) for (const ref of REFS){ const t = tally(R.recs, method, ref); if (t) T.perInstrument[inst.label][m][`${method.key}.${ref}`] = t; }
      for (const len of LENS) T.facts[inst.label][m][len] = closeFacts(R.recs, len); } } }
for (const N of CLOSES) for (const market of Object.keys(MARKETS)){ summary[N].pooled[market] = {};
  for (const m of CHARTS){ const recs = []; for (const l of MARKETS[market]) if (records[l][m]?.[N]) recs.push(...records[l][m][N]);
    summary[N].pooled[market][m] = { facts: {} }; for (const method of METHODS) for (const ref of REFS){ const t = tally(recs, method, ref); if (t) summary[N].pooled[market][m][`${method.key}.${ref}`] = t; }
    for (const len of LENS) summary[N].pooled[market][m].facts[len] = closeFacts(recs, len); } }
const def = { closes: CLOSES, averages: { state: 'SMA20', ema: 'never', note: 'the owner predicts trends on the 20SMA alone; the 8 is a power-trend average and the 200 a bias (22 Oct 2026)' }, th: TH, thSource: Object.fromEntries(LENS.map(l => ['sma' + l, FIT['sma' + l]])), L: { 2: 8, 5: 3 },
  state: 'board trend-state rule on the 20SMA (eval_lib outcomes, agg any, hysteresis 2/0.5)', readings: Object.fromEntries(METHODS.map(m => [m.key, m.kind === 'price' ? 'sign(last close − first open) over the segment' : m.kind === 'state' ? `sign(up − dn) of the SMA${m.len} state over the segment` : `SMA${m.len} state balance over the window counting only states that begin inside it`])),
  outcome: 'follow = same sign; reverse = opposite; none = close direction 0',
  refs: { day: 'cash session up to the close window', day90: 'cash session up to the 90-minute window (15-minute window only)', pre: 'the 75 minutes before the final window (15-minute window only)', full: 'from 08:00 UK to the close window (US rows only)' },
  closeBars: Object.fromEntries(CLOSES.map(N => [N, { 2: Math.round(N / 2), 5: Math.round(N / 5) }])), validity: { realShare: REAL_SEG, closeMoving: MOVE_SEG, holidays: HOL },
  sessions: Object.fromEntries(INSTRUMENTS.map(i => [i.label, { market: i.market, tz: i.tz, open: i.open, close: i.close, holidays: i.hol }])) };
fs.writeFileSync(OUT, JSON.stringify({ built, def, sample: { from: FROM, to: TO }, instruments: INSTRUMENTS.map(i => i.label), closes: CLOSES, meta, records, summary }));

// ---- the page's table: by weekday, the reading the owner asked for on 22 Oct 2026 ---------------------
// "For the day I'm trading, the percentage that the close follows and disagrees with the dominant trend of
// that day" — day direction = the 20SMA trend-state balance over the cash session up to the window (what the
// dominant trend of the day means on the chart), close direction = the window's net price move (the only
// reading that describes a window this short, CLAUDE.md §12). Counts per weekday and over all days with a
// 95% interval: Wilson for one instrument, date-clustered for a pooled row. Written as the CLOSE literal in
// index.html (anchor `^const CLOSE = {...};$`) and as data/close_table.json.
function pageCell(recs, wd){
  let f = 0, r = 0, none = 0, noDay = 0; const byDate = new Map();
  for (const rec of recs){ if (wd !== 'all' && rec.wd !== wd + 1) continue; const dd = sgn(rec.ma[20].up - rec.ma[20].dn); if (dd === 0){ noDay++; continue; }
    const cd = sgn(rec.cm); let e = byDate.get(rec.d); if (!e){ e = { n: 0, f: 0 }; byDate.set(rec.d, e); }
    if (cd === 0) none++; else { e.n++; if (cd === dd){ f++; e.f++; } else r++; } }
  const n = f + r; let lo = null, hi = null;
  if (n){ const p = f / n;
    if ([...byDate.values()].some(e => e.n > 1)){ let v = 0; for (const e of byDate.values()) v += (e.f - p * e.n) ** 2; const se = Math.sqrt(v) / n; lo = Math.max(0, p - 1.96 * se); hi = Math.min(1, p + 1.96 * se); }
    else [lo, hi] = wilson(f, n); }
  return [f, r, none, noDay, lo == null ? null : r3(lo), hi == null ? null : r3(hi)];
}
const WDS = ['all', 0, 1, 2, 3, 4], closeRows = [];
for (const market of Object.keys(MARKETS)){
  const labels = MARKETS[market], pooled = {};
  for (const m of CHARTS) for (const N of CLOSES){ const recs = []; for (const l of labels) if (records[l][m]?.[N]) recs.push(...records[l][m][N]); (pooled[m] = pooled[m] || {})[N] = Object.fromEntries(WDS.map(wd => [String(wd), pageCell(recs, wd)])); }
  closeRows.push({ label: market, market, pooled: labels.length, data: pooled });
  for (const l of labels){ const data = {}; for (const m of CHARTS) for (const N of CLOSES) if (records[l][m]?.[N]) (data[m] = data[m] || {})[N] = Object.fromEntries(WDS.map(wd => [String(wd), pageCell(records[l][m][N], wd)])); closeRows.push({ label: l, market, data }); }
}
const CLOSE = { built, sample: { from: FROM, to: TO }, windows: CLOSES, ma: 'sma20', th: TH[20],
  def: { day: 'sign of (bars in the +1 state − bars in the −1 state) of the 20SMA trend state over the cash session up to the window', close: 'sign of the window\'s net price move',
    cell: '[follow, reverse, close with no direction, no day direction, 95% lo, 95% hi]; the interval is Wilson for one instrument and date-clustered for a pooled row', weekdays: '"0".."4" = Mon..Fri, "all" = every day' },
  rows: closeRows };
fs.writeFileSync(path.join(ROOT, 'data', 'close_table.json'), JSON.stringify(CLOSE));
if (!args.dry){ const file = path.join(ROOT, 'index.html'); let h = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
  const m = h.match(/^const CLOSE = (\{.*\});$/m); if (!m) throw new Error('const CLOSE literal not found in index.html');
  fs.writeFileSync(file, h.replace(m[0], 'const CLOSE = ' + JSON.stringify(CLOSE) + ';')); }

// ---- print
if (!QUIET){
  console.log('\n# The page table (CLOSE): follow share of decided windows, 20SMA day direction against the window price move\n');
  console.log('| Row | Chart | Window | All days | Mon | Tue | Wed | Thu | Fri |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  const fc = x => { const n = x[0] + x[1]; return n ? `${Math.round(100 * x[0] / n)}% (${n})` : '–'; };
  for (const row of closeRows) for (const m of CHARTS) for (const N of CLOSES){ const d = row.data[m]?.[N]; if (!d) continue;
    console.log(`| ${row.pooled ? '**' + row.label + '**' : row.label} | ${m}-min | ${N} | ${fc(d.all)} | ${WDS.slice(1).map(wd => fc(d[String(wd)])).join(' | ')} |`); }
  console.log('');
  const pct = x => x == null || isNaN(x) ? '–' : (100 * x).toFixed(0) + '%';
  const ci = t => t.ci ? `${pct(t.ci[0])}–${pct(t.ci[1])}` : '–';
  const cci = t => t.ciCluster ? `${pct(t.ciCluster[0])}–${pct(t.ciCluster[1])} (clustered)` : '–';
  const cont = t => (t.cont >= 0 ? '+' : '') + t.cont.toFixed(2) + ' ± ' + t.contSe.toFixed(2);
  const REFNAME = { day: 'session to the window', day90: 'session to 15:00 UK / 14:30 ET', pre: 'the 75 minutes before', full: 'from 08:00 UK' };
  const MNAME = { state20: '20SMA trend state, whole window', fresh20: '20SMA states beginning inside the window', price: 'Net price move' };
  console.log(`close_study ${built}: sample ${FROM}..${TO}; 20SMA thresholds 2-min ${TH[20][2]} 5-min ${TH[20][5]}; close windows ${CLOSES.join(' and ')} minutes (2-minute chart: ${CLOSES.map(N => Math.round(N / 2) * 2).join(' and ')} minutes)\n`);
  console.log('Days used per instrument, chart and window (valid board days → used; dropped: holiday / sparse / dead / grid / no ATR):');
  for (const inst of INSTRUMENTS) for (const m of CHARTS) for (const N of CLOSES){ const x = meta[inst.label][m]?.[N]; if (!x) continue; const d = x.dropped;
    console.log(`  ${inst.label.padEnd(12)} ${String(m).padStart(2)}-min ${String(N).padStart(2)}  ${x.validDays} → ${x.used}  (${d.holiday}/${d.sparse}/${d.dead}/${d.grid}/${d.noAtr})  ${x.from}..${x.to}` + (x.droppedDates.holiday.length ? `  holidays present: ${x.droppedDates.holiday.join(' ')}` : '') + (x.droppedDates.dead.length ? `  dead: ${x.droppedDates.dead.join(' ')}` : '') + (x.droppedDates.sparse.length ? `  sparse: ${x.droppedDates.sparse.join(' ')}` : '')); }
  for (const N of CLOSES){
    console.log(`\n# Close window: the last ${N} minutes\n`);
    for (const key of ['price', 'state20']){
      console.log(`## ${MNAME[key]} — reference: ${REFNAME.day}\n`);
      console.log('| Instrument | Chart | Days | No day direction | Follow | Reverse | None | Follow share | 95% CI | Close move with the day (ATR) |');
      console.log('|---|---|---|---|---|---|---|---|---|---|');
      for (const inst of INSTRUMENTS) for (const m of CHARTS){ const t = summary[N].perInstrument[inst.label]?.[m]?.[`${key}.day`]; if (!t) continue;
        console.log(`| ${inst.label} | ${m}-min | ${t.days} | ${t.noDay} | ${t.follow} | ${t.reverse} | ${t.none} | ${pct(t.pFollow)} | ${ci(t)} | ${cont(t)} |`); }
      for (const market of Object.keys(MARKETS)) for (const m of CHARTS){ const t = summary[N].pooled[market][m][`${key}.day`];
        console.log(`| **${market} pooled** | ${m}-min | ${t.days} | ${t.noDay} | ${t.follow} | ${t.reverse} | ${t.none} | ${pct(t.pFollow)} | ${cci(t)} | ${cont(t)} |`); }
      console.log('');
    }
    console.log(`## Every reading × reference, pooled by market (follow / reverse / none, follow share, interval, close move with the reference)\n`);
    console.log('| Market | Chart | Reading | Reference | Follow / reverse / none | Follow share | 95% CI (clustered) | Move with ref (ATR) |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const market of Object.keys(MARKETS)) for (const m of CHARTS) for (const method of METHODS) for (const ref of REFS){ const t = summary[N].pooled[market][m][`${method.key}.${ref}`]; if (!t) continue;
      console.log(`| ${market} | ${m}-min | ${method.key} | ${REFNAME[ref]} | ${t.follow} / ${t.reverse} / ${t.none} | ${pct(t.pFollow)} | ${cci(t)} | ${cont(t)} |`); }
    console.log(`\n## Strong against weak reference trends (split at the median strength), pooled, reference ${REFNAME.day}\n`);
    console.log('| Market | Chart | Reading | Median strength | Strong: follow / reverse / none | Strong follow share | Weak: follow / reverse / none | Weak follow share |');
    console.log('|---|---|---|---|---|---|---|---|');
    for (const market of Object.keys(MARKETS)) for (const m of CHARTS) for (const method of METHODS){ const t = summary[N].pooled[market][m][`${method.key}.day`], s = t.split.strong, w = t.split.weak;
      console.log(`| ${market} | ${m}-min | ${method.key} | ${t.medStrength} | ${s.follow} / ${s.reverse} / ${s.none} | ${pct(s.pFollow)} (${s.cont >= 0 ? '+' : ''}${s.cont} ATR) | ${w.follow} / ${w.reverse} / ${w.none} | ${pct(w.pFollow)} (${w.cont >= 0 ? '+' : ''}${w.cont} ATR) |`); }
    console.log('\n## What the close window looks like\n');
    console.log('| Market | Chart | Average | Any trend state in the close | A state begins in the close | Both directions seen | Turns in the close | Trending bars | Mean abs day move (ATR) | Mean abs close move (ATR) | Day readings agree | Close state agrees with close price | Fresh state agrees with close price | In a trend at the window start: price follows / reverses |');
    console.log('|---|---|---|---|---|---|---|---|---|---|---|---|---|---|');
    for (const market of Object.keys(MARKETS)) for (const m of CHARTS) for (const len of LENS){ const f = summary[N].pooled[market][m].facts[len];
      console.log(`| ${market} | ${m}-min | SMA${len} | ${pct(f.anyState)} | ${pct(f.freshAny)} | ${pct(f.bothStates)} | ${f.turns.toFixed(1)} | ${pct(f.trendingShare)} | ${f.absDay.toFixed(2)} | ${f.absClose.toFixed(2)} | ${pct(f.methodsAgreeDay)} (n ${f.methodsAgreeDayN}) | ${pct(f.methodsAgreeClose)} (n ${f.methodsAgreeCloseN}) | ${pct(f.freshAgreeClose)} (n ${f.freshAgreeCloseN}) | ${f.inTrendFollow} / ${f.inTrendReverse} = ${pct(f.pInTrendFollow)} of ${f.inTrendAtClose} |`); }
  }
  console.log(`\nwrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}
