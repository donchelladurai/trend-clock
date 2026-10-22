#!/usr/bin/env node
// Market-close direction study — the six index rows on the 2- and 5-minute charts.
//
//   node tools/close_study.js [--from 2026-01-26] [--to 2026-10-12] [--out data/close_study.json] [--quiet]
//
// The question (22 Oct 2026): over the last 90 minutes of the cash session, does the market follow
// the day's dominant trend direction or reverse it? Only same/opposite is read, never up/down.
//
// Definitions
//   cash session   FTSE 100 08:00–16:30 London; Germany 40 and France 40 09:00–17:30 Berlin/Paris
//                  (16:30 UK: the EU and UK clocks change on the same dates); Wall Street, US Tech 100
//                  and US 500 09:30–16:00 New York (14:30–21:00 UK outside the clock-gap weeks, when
//                  the New York clock is used and the window lands an hour earlier in UK time).
//   close          the last 90 minutes of the cash session: 15:00–16:30 UK / 14:30–16:00 New York.
//   day            the cash session before the close: 08:00–15:00 UK / 09:30–14:30 New York. For the
//                  US rows a second reading, "full", runs from 08:00 UK (the board's day start).
//   day direction  state: sign of (bars in the +1 state − bars in the −1 state) over the day segment,
//                  where the state is the board's 20EMA trend state on that chart — the same
//                  hysteresis, move length and fitted threshold as index.html (CLAUDE.md §1b), via
//                  tools/eval_lib.js outcomes(); price: sign of (last close of the day segment −
//                  open of the session's first bar). Zero on either reading = no dominant direction.
//   close direction  the same two readings over the close window.
//   outcome        follow = the close has the day's sign; reverse = the opposite sign; none = the
//                  close has no direction (state balance exactly 0, or a zero price move).
//   valid day      the board's valid day (gen_row.js), with at least 90% of the bars in the day and
//                  close segments real, at least half of the close bars moving, a daily ATR, and the
//                  exchange not on holiday (the CFD feeds print bars on cash holidays).
//
// Output — data/close_study.json:
//   { built, def, sample, instruments[], records: { label: { "2": [rec], "5": [rec] } }, summary }
//   rec = { d, wd, atr, p0, p1, p2, dm, cm, rng, crng, nb, nc, up, dn, cu, cd, ct, ctr, two, s1, r1, s2, em, ecm,
//           thirds: [{pm, up, dn} × 3], full?: { p0, dm, up, dn, em, nb, rng } }
//   d date (UK), wd 1–5, atr the day's 14-day ATR; p0 session open, p1 close before the close window,
//   p2 cash close; dm / cm the day / close price move in ATR units; rng / crng the segment ranges in ATR
//   units; nb / nc bars in the day / close segment; up / dn bars in the +1 / −1 state over the day,
//   cu / cd over the close; ct turns and ctr trending bars in the close; two = both states seen in the
//   close; s1 the state and r1 the slope ratio on the last bar before the close, s2 the state on the
//   final bar; em / ecm the 20EMA's move over the day / close in ATR units; thirds = the close window
//   in three 30-minute parts (price move in ATR units, state bars). Everything a later aggregation
//   needs is in the record: nothing has to be recomputed from the bar files.
'use strict';
const fs = require('fs'), path = require('path');
const E = require('./eval_lib.js');
const ROOT = path.join(__dirname, '..');
const DAY = 86400000;
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i + 1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
const FROM = args.from || '2026-01-26', TO = args.to || '2026-10-12', OUT = args.out || path.join(ROOT, 'data', 'close_study.json'), QUIET = !!args.quiet;
const LIVE = JSON.parse(fs.readFileSync(path.join(ROOT, 'data', 'live_tables.json'), 'utf8'));
const CHARTS = [2, 5], TH = { 2: LIVE.th[2], 5: LIVE.th[5] };
const CLOSE_MIN = 90, REAL_SEG = 0.9, MOVE_SEG = 0.5;
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

// ---- one instrument × chart → records
function study(inst, minutes){
  const P = E.load(inst.stem, minutes, FROM, TO); if (!P) return null;
  const O = E.outcomes(P, { th: TH[minutes], agg: 'any' });
  const { st, turn, tr, ratio } = O.bars, { c, hi, lo, ema, real, atrD } = P, B = P.B, o = opens(inst.stem, minutes, P.n);
  const hol = new Set(HOL[inst.hol]), recs = [], dropped = { holiday: [], grid: [], sparse: [], dead: [], noAtr: [] };
  const seg = (idx, a, b) => { // state counts, price move, range, real share, moving share over positions [a, b)
    let up = 0, dn = 0, re = 0, mv = 0, h = -Infinity, l = Infinity, tu = 0, trn = 0;
    for (let p = a; p < b; p++){ const i = idx[p]; if (st[i] > 0) up++; else if (st[i] < 0) dn++; re += real[i]; if (c[i] !== c[i - 1] || hi[i] !== lo[i]) mv++; if (hi[i] > h) h = hi[i]; if (lo[i] < l) l = lo[i]; tu += turn[i]; trn += tr[i]; }
    return { up, dn, real: re / (b - a), move: mv / (b - a), rng: h - l, turns: tu, trending: trn, n: b - a }; };
  for (const dd of O.days){
    const date = E.fmtDay(dd.day);
    if (hol.has(date)){ dropped.holiday.push(date); continue; }
    const pOpen = posOf(B, dd.day, zonedUtc(dd.day, inst.open[0], inst.open[1], inst.tz)), pClose = posOf(B, dd.day, zonedUtc(dd.day, inst.close[0], inst.close[1], inst.tz));
    if (!Number.isInteger(pOpen) || !Number.isInteger(pClose) || pOpen < 0 || pClose > P.perDay){ dropped.grid.push(date); continue; }
    const pT1 = pClose - CLOSE_MIN / B, idx = dd.idx;
    const atr = atrD[idx[pOpen]]; if (!(atr > 0)){ dropped.noAtr.push(date); continue; }
    const D = seg(idx, pOpen, pT1), C = seg(idx, pT1, pClose);
    if (D.real < REAL_SEG || C.real < REAL_SEG){ dropped.sparse.push(date); continue; }
    if (C.move < MOVE_SEG){ dropped.dead.push(date); continue; }
    const i0 = idx[pOpen], i1 = idx[pT1 - 1], i2 = idx[pClose - 1];
    const p0 = o[i0], p1 = c[i1], p2 = c[i2];
    const third = (pClose - pT1) / 3, thirds = [];
    for (let t = 0; t < 3; t++){ const a = pT1 + t * third, b = a + third, S = seg(idx, a, b); thirds.push({ pm: r3((c[idx[b - 1]] - c[idx[a] - 1]) / atr), up: S.up, dn: S.dn }); }
    const rec = { d: date, wd: dd.wd, atr: r4(atr), p0, p1, p2, dm: r3((p1 - p0) / atr), cm: r3((p2 - p1) / atr), rng: r3(D.rng / atr), crng: r3(C.rng / atr),
      nb: D.n, nc: C.n, up: D.up, dn: D.dn, cu: C.up, cd: C.dn, ct: C.turns, ctr: C.trending, two: C.up > 0 && C.dn > 0 ? 1 : 0,
      s1: st[i1], r1: r3(ratio[i1]), s2: st[i2], em: r3((ema[i1] - ema[i0]) / atr), ecm: r3((ema[i2] - ema[i1]) / atr), thirds };
    if (inst.market === 'US' && pOpen > 0){ const F = seg(idx, 0, pT1), j0 = idx[0]; rec.full = { p0: o[j0], dm: r3((p1 - o[j0]) / atr), up: F.up, dn: F.dn, em: r3((ema[i1] - ema[j0]) / atr), nb: F.n, rng: r3(F.rng / atr) }; }
    recs.push(rec);
  }
  return { recs, dropped, th: TH[minutes], L: P.L, perDay: P.perDay, validDays: O.days.length };
}

// ---- aggregation: the same functions a page or a later tool would use on the records
const DAYDIR = {
  state: { cash: r => sgn(r.up - r.dn), full: r => r.full ? sgn(r.full.up - r.full.dn) : sgn(r.up - r.dn) },
  price: { cash: r => sgn(r.dm), full: r => r.full ? sgn(r.full.dm) : sgn(r.dm) },
};
const CLOSEDIR = { state: r => sgn(r.cu - r.cd), price: r => sgn(r.cm) };
const STRENGTH = {
  state: { cash: r => Math.abs(r.up - r.dn) / r.nb, full: r => r.full ? Math.abs(r.full.up - r.full.dn) / r.full.nb : Math.abs(r.up - r.dn) / r.nb },
  price: { cash: r => Math.abs(r.dm), full: r => r.full ? Math.abs(r.full.dm) : Math.abs(r.dm) },
};
function wilson(k, n, z = 1.96){ if (!n) return [NaN, NaN]; const p = k / n, z2 = z * z, den = 1 + z2 / n, cen = (p + z2 / (2 * n)) / den, half = z * Math.sqrt(p * (1 - p) / n + z2 / (4 * n * n)) / den; return [cen - half, cen + half]; }
// Follow share with a date-clustered interval (instrument-days on the same date are one cluster).
function tally(recs, method, dayDef){
  const dayDir = DAYDIR[method][dayDef], closeDir = CLOSEDIR[method], strength = STRENGTH[method][dayDef];
  const out = { days: recs.length, noDay: 0, follow: 0, reverse: 0, none: 0, quiet: 0, cont: [], byDate: new Map() };
  const dec = [];
  for (const r of recs){ const dd = dayDir(r); if (dd === 0){ out.noDay++; continue; } dec.push(r); const cd = closeDir(r);
    let e = out.byDate.get(r.d); if (!e){ e = { n: 0, f: 0 }; out.byDate.set(r.d, e); }
    if (cd === 0){ out.none++; if (method === 'state' && r.cu + r.cd === 0) out.quiet++; } else { e.n++; if (cd === dd){ out.follow++; e.f++; } else out.reverse++; }
    out.cont.push(r.cm * dd); }
  const n = out.follow + out.reverse, p = n ? out.follow / n : NaN;
  let v = 0; for (const e of out.byDate.values()) v += (e.f - p * e.n) ** 2; const se = n ? Math.sqrt(v) / n : NaN;
  const med = median(dec.map(strength)), split = {};
  for (const [name, keep] of [['strong', x => x >= med], ['weak', x => x < med]]){ let f = 0, rv = 0, no = 0, ct = [];
    for (const r of dec){ if (!keep(strength(r))) continue; const dd = dayDir(r), cd = closeDir(r); if (cd === 0) no++; else if (cd === dd) f++; else rv++; ct.push(r.cm * dd); }
    split[name] = { follow: f, reverse: rv, none: no, pFollow: f + rv ? r3(f / (f + rv)) : null, cont: r3(mean(ct)) }; }
  return { days: out.days, noDay: out.noDay, follow: out.follow, reverse: out.reverse, none: out.none, quiet: out.quiet, decided: n, pFollow: n ? r3(p) : null,
    ci: n ? wilson(out.follow, n).map(r3) : null, ciCluster: n ? [r3(p - 1.96 * se), r3(p + 1.96 * se)] : null, dates: out.byDate.size,
    cont: r3(mean(out.cont)), contSe: r3(Math.sqrt(out.cont.reduce((s, x) => s + (x - mean(out.cont)) ** 2, 0) / Math.max(1, out.cont.length - 1)) / Math.sqrt(out.cont.length || 1)),
    medStrength: r3(med), split };
}
function closeFacts(recs){ // what the close window itself looks like on this chart
  const any = recs.filter(r => r.cu + r.cd > 0).length, two = recs.filter(r => r.two).length, turns = mean(recs.map(r => r.ct)), trending = mean(recs.map(r => r.ctr / r.nc));
  const s1 = recs.filter(r => r.s1 !== 0), s1follow = s1.filter(r => sgn(r.cm) === r.s1).length, s1rev = s1.filter(r => sgn(r.cm) === -r.s1).length;
  const agree = recs.filter(r => sgn(r.up - r.dn) !== 0 && sgn(r.dm) !== 0), agreeN = agree.filter(r => sgn(r.up - r.dn) === sgn(r.dm)).length;
  return { anyState: r3(any / recs.length), bothStates: r3(two / recs.length), turns: r3(turns), trendingShare: r3(trending), absClose: r3(mean(recs.map(r => Math.abs(r.cm)))), absDay: r3(mean(recs.map(r => Math.abs(r.dm)))),
    inTrendAtClose: s1.length, inTrendFollow: s1follow, inTrendReverse: s1rev, pInTrendFollow: s1follow + s1rev ? r3(s1follow / (s1follow + s1rev)) : null,
    methodsAgree: agree.length ? r3(agreeN / agree.length) : null, methodsAgreeN: agree.length };
}

// ---- run
const built = new Date().toISOString().slice(0, 10), records = {}, meta = {}, summary = { perInstrument: {}, pooled: {}, facts: {} };
for (const inst of INSTRUMENTS){ records[inst.label] = {}; meta[inst.label] = {}; summary.perInstrument[inst.label] = {}; summary.facts[inst.label] = {};
  for (const m of CHARTS){ const S = study(inst, m); if (!S){ console.error(`no bars for ${inst.label} m${m}`); continue; }
    records[inst.label][m] = S.recs; meta[inst.label][m] = { th: S.th, L: S.L, validDays: S.validDays, used: S.recs.length, from: S.recs[0]?.d, to: S.recs[S.recs.length - 1]?.d, dropped: Object.fromEntries(Object.entries(S.dropped).map(([k, v]) => [k, v.length])), droppedDates: S.dropped };
    summary.perInstrument[inst.label][m] = {}; for (const method of ['state', 'price']) for (const dayDef of (inst.market === 'US' ? ['cash', 'full'] : ['cash'])) summary.perInstrument[inst.label][m][`${method}.${dayDef}`] = tally(S.recs, method, dayDef);
    summary.facts[inst.label][m] = closeFacts(S.recs); } }
for (const market of ['Europe', 'US']){ summary.pooled[market] = {};
  for (const m of CHARTS){ const recs = []; for (const inst of INSTRUMENTS) if (inst.market === market && records[inst.label][m]) recs.push(...records[inst.label][m]);
    summary.pooled[market][m] = {}; for (const method of ['state', 'price']) for (const dayDef of (market === 'US' ? ['cash', 'full'] : ['cash'])) summary.pooled[market][m][`${method}.${dayDef}`] = tally(recs, method, dayDef);
    summary.pooled[market][m].facts = closeFacts(recs); } }
const def = { closeMinutes: CLOSE_MIN, th: TH, L: { 2: 8, 5: 3 }, state: 'board 20EMA trend state (eval_lib outcomes, agg any, hysteresis 2/0.5)', dayDirection: { state: 'sign(up − dn) over the day segment', price: 'sign(p1 − p0)' },
  closeDirection: { state: 'sign(cu − cd) over the close window', price: 'sign(p2 − p1)' }, outcome: 'follow = same sign; reverse = opposite; none = close direction 0', validity: { realShare: REAL_SEG, closeMoving: MOVE_SEG, holidays: HOL },
  sessions: Object.fromEntries(INSTRUMENTS.map(i => [i.label, { market: i.market, tz: i.tz, open: i.open, close: i.close, holidays: i.hol }])) };
fs.writeFileSync(OUT, JSON.stringify({ built, def, sample: { from: FROM, to: TO }, instruments: INSTRUMENTS.map(i => i.label), meta, records, summary }));

// ---- print
if (!QUIET){
  const pct = x => x == null || isNaN(x) ? '–' : (100 * x).toFixed(0) + '%';
  const ci = t => t.ci ? `${pct(t.ci[0])}–${pct(t.ci[1])}` : '–';
  const cont = t => (t.cont >= 0 ? '+' : '') + t.cont.toFixed(2);
  console.log(`close_study ${built}: sample ${FROM}..${TO}; th 2-min ${TH[2]}, 5-min ${TH[5]}; close = last ${CLOSE_MIN} min of the cash session\n`);
  console.log('Days used per instrument and chart (valid board days → used; dropped: holiday / sparse / dead / grid / no ATR):');
  for (const inst of INSTRUMENTS) for (const m of CHARTS){ const x = meta[inst.label][m]; if (!x) continue; const d = x.dropped;
    console.log(`  ${inst.label.padEnd(12)} ${String(m).padStart(2)}-min  ${x.validDays} → ${x.used}  (${d.holiday}/${d.sparse}/${d.dead}/${d.grid}/${d.noAtr})  ${x.from}..${x.to}` + (x.droppedDates.holiday.length ? `  holidays present: ${x.droppedDates.holiday.join(' ')}` : '') + (x.droppedDates.dead.length ? `  dead: ${x.droppedDates.dead.join(' ')}` : '') + (x.droppedDates.sparse.length ? `  sparse: ${x.droppedDates.sparse.join(' ')}` : '')); }
  for (const method of ['state', 'price']){
    console.log(`\n## ${method === 'state' ? '20EMA trend state on the chart' : 'Net price move (chart-free)'} — day = cash session before the close\n`);
    console.log('| Instrument | Chart | Days | No day direction | Follow | Reverse | None | Follow share | 95% CI | Close move with the day (ATR) |');
    console.log('|---|---|---|---|---|---|---|---|---|---|');
    for (const inst of INSTRUMENTS) for (const m of CHARTS){ const t = summary.perInstrument[inst.label][m]?.[`${method}.cash`]; if (!t) continue;
      console.log(`| ${inst.label} | ${m}-min | ${t.days} | ${t.noDay} | ${t.follow} | ${t.reverse} | ${t.none} | ${pct(t.pFollow)} | ${ci(t)} | ${cont(t)} ± ${t.contSe.toFixed(2)} |`); }
    for (const market of ['Europe', 'US']) for (const m of CHARTS){ const t = summary.pooled[market][m][`${method}.cash`];
      console.log(`| **${market} pooled** | ${m}-min | ${t.days} | ${t.noDay} | ${t.follow} | ${t.reverse} | ${t.none} | ${pct(t.pFollow)} | ${t.ciCluster.map(pct).join('–')} (clustered) | ${cont(t)} ± ${t.contSe.toFixed(2)} |`); }
  }
  console.log('\n## US rows with the day read from 08:00 UK instead of the 14:30 UK cash open\n');
  console.log('| Instrument | Chart | Method | No day direction | Follow | Reverse | None | Follow share | 95% CI |');
  console.log('|---|---|---|---|---|---|---|---|---|');
  for (const inst of INSTRUMENTS.filter(i => i.market === 'US')) for (const m of CHARTS) for (const method of ['state', 'price']){ const t = summary.perInstrument[inst.label][m]?.[`${method}.full`]; if (!t) continue;
    console.log(`| ${inst.label} | ${m}-min | ${method} | ${t.noDay} | ${t.follow} | ${t.reverse} | ${t.none} | ${pct(t.pFollow)} | ${ci(t)} |`); }
  for (const m of CHARTS) for (const method of ['state', 'price']){ const t = summary.pooled.US[m][`${method}.full`]; console.log(`| **US pooled** | ${m}-min | ${method} | ${t.noDay} | ${t.follow} | ${t.reverse} | ${t.none} | ${pct(t.pFollow)} | ${t.ciCluster.map(pct).join('–')} (clustered) |`); }
  console.log('\n## Strong against weak day trends (split at the median strength of the day direction), pooled\n');
  console.log('| Market | Chart | Method | Median strength | Strong: follow / reverse / none | Strong follow share | Weak: follow / reverse / none | Weak follow share |');
  console.log('|---|---|---|---|---|---|---|---|');
  for (const market of ['Europe', 'US']) for (const m of CHARTS) for (const method of ['state', 'price']){ const t = summary.pooled[market][m][`${method}.cash`], s = t.split.strong, w = t.split.weak;
    console.log(`| ${market} | ${m}-min | ${method} | ${t.medStrength} | ${s.follow} / ${s.reverse} / ${s.none} | ${pct(s.pFollow)} (${s.cont >= 0 ? '+' : ''}${s.cont} ATR) | ${w.follow} / ${w.reverse} / ${w.none} | ${pct(w.pFollow)} (${w.cont >= 0 ? '+' : ''}${w.cont} ATR) |`); }
  console.log('\n## What the close window looks like\n');
  console.log('| Market | Chart | Any trend state in the close | Both directions seen | Turns in the close | Trending bars | Mean abs day move (ATR) | Mean abs close move (ATR) | State and price day readings agree | In a trend at the close start: follows / reverses |');
  console.log('|---|---|---|---|---|---|---|---|---|---|');
  for (const market of ['Europe', 'US']) for (const m of CHARTS){ const f = summary.pooled[market][m].facts;
    console.log(`| ${market} | ${m}-min | ${pct(f.anyState)} | ${pct(f.bothStates)} | ${f.turns.toFixed(1)} | ${pct(f.trendingShare)} | ${f.absDay.toFixed(2)} | ${f.absClose.toFixed(2)} | ${pct(f.methodsAgree)} (n ${f.methodsAgreeN}) | ${f.inTrendFollow} / ${f.inTrendReverse} = ${pct(f.pInTrendFollow)} of ${f.inTrendAtClose} |`); }
  console.log(`\nwrote ${path.relative(ROOT, OUT)} (${(fs.statSync(OUT).size / 1024).toFixed(0)} KB)`);
}
