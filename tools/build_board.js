#!/usr/bin/env node
// Build every board row on every chart from the bar files in data/ and write them into index.html.
//
//   node tools/build_board.js [--from 2026-04-13 --to 2026-10-09] [--th2 0.0365 --th5 0.0204 --th15 0.0105]
//                             [--from15 2026-04-13] [--agg any|majority|all] [--side] [--horizon 1] [--dry]
//
// The thresholds default to the 20SMA fit in data/th_fit.json (tools/fit_th.js, pooled share 0.45); pass
// --th2/--th5/--th15 only to override it. The average is the 20-period SMA everywhere (gen_row.js); the
// board was a 20EMA until 22 Oct 2026.
//
// Three boards, one per chart the owner trades (15-, 5- and 2-minute), each holding every instrument
// in the manifest below plus the composites. A row is genRow() over data/<stem>_m<chart>.json with
// that chart's threshold; composites are the mean share and the summed turn counts of the
// instruments beneath them, in the order the board draws (composite first, then its constituents —
// COMPOSITE in index.html depends on that order). An instrument whose bar file is missing is left
// off that board and named in the output; a composite then sums whatever constituents it has.
// --from15/--to15 (and --from5, --from2) override the sample window for one chart.
//
// Also writes the live-layer constants the page needs to read a live feed with the same rule: the
// threshold and move length per chart, each instrument's daily ATR at the end of its sample (the
// fallback scale when the helper has none), and the state tables — P(turn within 15 and 30 minutes
// | slope ratio, trend age) per chart, from every valid day on disk (tools/eval_lib.js).
//
// Writes data/rows/m<chart>/<slug>.json for every row (the committed record, with meta.counts),
// data/rows/_board.json (dates, thresholds, what went in), data/live_tables.json, then replaces the
// BOARDS and LIVE literals in index.html. --dry builds and reports without touching index.html.
const fs = require('fs'), path = require('path');
const { genRow, prepare, SLOTS, MODES } = require('./gen_row.js');
const E = require('./eval_lib.js');
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i+1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
const CHARTS = [15, 5, 2];
// 26 weeks: the accuracy study (CLAUDE.md §7) found the profiles stationary across 2026 and skill still rising
// from 13 to 26 weeks of history; the thresholds are tools/fit_th.js at a pooled share of 0.45.
const FROM = args.from || '2026-04-13', TO = args.to || '2026-10-09';
const FIT = (() => { try { return JSON.parse(fs.readFileSync(path.join(__dirname, '..', 'data', 'th_fit.json'), 'utf8')).sma20.th; } catch (e) { return null; } })();
if (!FIT && !(args.th2 && args.th5 && args.th15)) throw new Error('no 20SMA fit in data/th_fit.json: run node tools/fit_th.js --share 0.45 or pass --th2 --th5 --th15');
const TH = { 2: +(args.th2 || FIT[2]), 5: +(args.th5 || FIT[5]), 15: +(args.th15 || FIT[15]) };
const DEF = { agg: args.agg || 'any', side: !!args.side, horizon: +(args.horizon || 1) };
const sampleWindow = ch => ({ from: args['from' + ch] || FROM, to: args['to' + ch] || TO });
const root = path.join(__dirname, '..');

// group, label, bar-file stem, source, flags
const INSTRUMENTS = [
  ['Indices', 'FTSE 100', 'ukxgbp', 'histdata.com UKXGBP'],
  ['Indices', 'Germany 40', 'grxeur', 'histdata.com GRXEUR'],
  ['Indices', 'France 40', 'frxeur', 'histdata.com FRXEUR'],
  ['Indices', 'Wall Street', 'usa30', 'Dukascopy USA30IDXUSD'],
  ['Indices', 'US Tech 100', 'nsxusd', 'histdata.com NSXUSD'],
  ['Indices', 'US 500', 'spxusd', 'histdata.com SPXUSD'],
  ['FX — USD pairs', 'EUR/USD', 'eurusd', 'histdata.com EURUSD'],
  ['FX — USD pairs', 'GBP/USD', 'gbpusd', 'histdata.com GBPUSD'],
  ['FX — USD pairs', 'AUD/USD', 'audusd', 'histdata.com AUDUSD'],
  ['FX — USD pairs', 'USD/CAD', 'usdcad', 'histdata.com USDCAD'],
  ['FX — USD pairs', 'USD/JPY', 'usdjpy', 'histdata.com USDJPY'],
  ['FX — USD pairs', 'USD/CHF', 'usdchf', 'histdata.com USDCHF'],
  ['FX — USD pairs', 'NZD/USD', 'nzdusd', 'histdata.com NZDUSD'],
  ['FX — EUR crosses', 'EUR/GBP', 'eurgbp', 'histdata.com EURGBP'],
  ['FX — EUR crosses', 'EUR/AUD', 'euraud', 'histdata.com EURAUD'],
  ['FX — EUR crosses', 'EUR/JPY', 'eurjpy', 'histdata.com EURJPY'],
  ['FX — EUR crosses', 'EUR/CAD', 'eurcad', 'histdata.com EURCAD'],
  ['FX — EUR crosses', 'EUR/CHF', 'eurchf', 'histdata.com EURCHF'],
  ['FX — EUR crosses', 'EUR/NZD', 'eurnzd', 'histdata.com EURNZD'],
  ['FX — other crosses', 'AUD/JPY', 'audjpy', 'histdata.com AUDJPY'],
  ['Commodities', 'Spot Gold', 'xauusd', 'histdata.com XAUUSD', { big: true }],
  // No free 2-minute source reaches back three months for CBOT wheat (histdata and Dukascopy do
  // not carry it). Drop bar files data/wheat_m{2,5,15}.json in the same shape — [utc_ms, o, h, l,
  // c, real] — and the row comes back on every chart that has one.
  ['Commodities', 'Chicago Wheat', 'wheat', 'none', { big: true }],
];
const COMPOSITES = [
  ['Indices', 'Europe', ['FTSE 100', 'Germany 40', 'France 40']],
  ['Indices', 'US', ['Wall Street', 'US Tech 100', 'US 500']],
  ['FX — USD pairs', 'USD pairs', ['EUR/USD', 'GBP/USD', 'AUD/USD', 'USD/CAD', 'USD/JPY', 'USD/CHF', 'NZD/USD']],
  ['FX — EUR crosses', 'EUR crosses', ['EUR/GBP', 'EUR/AUD', 'EUR/JPY', 'EUR/CAD', 'EUR/CHF', 'EUR/NZD']],
];
// Group and guide lines (minutes from 08:00: London open is 0, US open 390, US cash close 510, London close 510).
const GROUP_LINES = [['Indices', [390, 510]], ['FX — USD pairs', [330, 390, 480]], ['FX — EUR crosses', [330, 390, 480]], ['FX — other crosses', [330, 390, 480]], ['Commodities', [330, 390, 480]]];
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const r2 = x => +x.toFixed(2);

function compose(group, label, kids, built){
  const K = kids.map(l => built.get(l)).filter(Boolean);
  if (!K.length) return null;
  const closed = []; for (let k = 0; k < SLOTS; k++) closed.push(K.every(x => x.row.closed[k]));
  const open = []; for (let k = 0; k < SLOTS; k++) if (!closed[k]) open.push(k);
  const data = {}, days = {}, turnc = [], counts = {};
  MODES.forEach((m, mi) => {
    const s = new Array(SLOTS).fill(0), c = new Array(SLOTS).fill(0);
    for (const k of open){ const ks = K.filter(x => !x.row.closed[k]); s[k] = r2(ks.reduce((a, x) => a + x.row.data[m].s[k], 0)/ks.length); c[k] = ks.reduce((a, x) => a + x.meta.counts[m][k], 0); }
    const total = c.reduce((a, b) => a + b, 0), lam = total/open.length;
    data[m] = { s, t: c.map((x, k) => closed[k] ? 0 : (lam ? r2(x/lam) : 0)) }; counts[m] = c; turnc.push(total);
    days[m] = Math.round(K.reduce((a, x) => a + x.row.days[m], 0)/K.length);
  });
  const row = { group, label, big: true, closed, days: { all: days.all, 0: days[0], 1: days[1], 2: days[2], 3: days[3], 4: days[4] }, data };
  return { row, turnc, meta: { of: K.map(x => x.row.label), days: days.all, open: open.length, counts } };
}

const BOARDS = {}, record = {}, missingAll = {}, atrEnd = {}, prepared = {};
for (const ch of CHARTS){
  const { from, to } = sampleWindow(ch);
  const built = new Map(), missing = [];
  console.log(`\n=== ${ch}-minute chart, ${from} – ${to}, th ${TH[ch]}, ${DEF.agg}${DEF.side ? ' side' : ''}${DEF.horizon !== 1 ? ' horizon ' + DEF.horizon : ''}`);
  for (const [group, label, stem, source, flags] of INSTRUMENTS){
    const f = path.join(root, 'data', `${stem}_m${ch}.json`);
    if (!fs.existsSync(f)){ missing.push(label); continue; }
    const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
    const o = { minutes: ch, th: TH[ch], from, to, label, group, big: !!(flags && flags.big), source, agg: DEF.agg, side: DEF.side, horizon: DEF.horizon };
    const { row, turnc, meta, P } = genRow(raw, o);
    if (!meta.days){ missing.push(label + ' (no valid days)'); continue; }
    built.set(label, { row, turnc, meta });
    // The daily ATR at the end of the sample: the last finite value on or before the last valid day.
    { let v = NaN; const last = P.days[P.days.length-1].idx; for (let p = last.length-1; p >= 0 && isNaN(v); p--) v = P.atrD[last[p]]; if (!atrEnd[label] || ch === 2) atrEnd[label] = { atr: +v.toPrecision(5), asOf: meta.to }; }
    prepared[`${stem}|${ch}`] = P;
    console.log(label.padEnd(14) + String(meta.days).padStart(4) + ' days ' + meta.from + '–' + meta.to + ' (' + meta.byWeekday.join('/') + ')  open ' + meta.open + '  turns/day ' + (turnc[5]/meta.days).toFixed(1) + '  lambda all ' + (turnc[5]/meta.open).toFixed(1) + '  s mean ' + (row.closed.reduce((a, c, k) => c ? a : a + row.data.all.s[k], 0)/meta.open).toFixed(2));
  }
  // Board order: each group's composite first, then its constituents, then the rest of the group.
  const ROWS = [], TURNC = [], rec = [];
  for (const [g] of GROUP_LINES){
    const used = new Set();
    for (const comp of COMPOSITES.filter(c => c[0] === g)){
      const c = compose(comp[0], comp[1], comp[2], built); if (!c) continue;
      ROWS.push(c.row); TURNC.push(c.turnc); rec.push([comp[1], c]);
      for (const l of comp[2]) if (built.has(l)){ used.add(l); ROWS.push(built.get(l).row); TURNC.push(built.get(l).turnc); rec.push([l, built.get(l)]); }
    }
    for (const [group, label] of INSTRUMENTS) if (group === g && built.has(label) && !used.has(label)){ ROWS.push(built.get(label).row); TURNC.push(built.get(label).turnc); rec.push([label, built.get(label)]); }
  }
  const GROUPS = GROUP_LINES.filter(([g]) => ROWS.some(r => r.group === g)).map(([g, lines]) => [g, lines, ch]);
  console.log('rows ' + ROWS.length + (missing.length ? '; left off: ' + missing.join(', ') : ''));
  for (const [label, c] of rec) if (c.meta.of) console.log(label.padEnd(14) + ' = ' + c.meta.of.join(' + ') + '  days ' + c.meta.days + '  turns/day ' + (c.turnc[5]/c.meta.days).toFixed(1) + '  lambda all ' + (c.turnc[5]/c.meta.open).toFixed(1));
  // Invariants 1–3.
  const ok1 = TURNC.every(t => t.slice(0, 5).reduce((a, b) => a + b, 0) === t[5]); let worst = 0;
  for (const r of ROWS) for (const m of MODES){ let s = 0, n = 0; for (let k = 0; k < SLOTS; k++){ if (r.closed[k]) continue; s += r.data[m].t[k]; n++; } worst = Math.max(worst, Math.abs(s - n)); }
  console.log('invariant 1 ' + (ok1 ? 'ok' : 'FAILED') + '; invariant 3 worst ' + worst.toFixed(3));
  if (!ok1) process.exit(1);
  BOARDS[ch] = { ROWS, TURNC, GROUPS, from, to, th: TH[ch] };
  record[ch] = rec; missingAll[ch] = missing;
}

// ---- live-layer constants: the rule per chart, the fallback scale per instrument, the state tables.
// The lookups the October 2026 study (tools/eval_lib.js, study D) found to carry the information, fitted on
// one half of the year and scored on the other: a turn within 15 / 30 minutes while in a trend state by
// slope ratio r (7 buckets) x age in bars (5) x whether the close sits on the trend's side of the average
// (out-of-sample Brier skill 0.26 against 0.18 without the side); a trend state starting while flat by
// r (5 buckets, a flat state has r < 2 by construction) x whether the slope is rising x age (0.12); and
// the next window trending by r x the next window's climatology tertile within the row (0.24). Pooled
// over the 20 histdata instruments and every valid day on disk: the tables describe the chart rule, not
// the quarter (Jan-May and Jun-Oct halves agree to 0.013 on average).
const R_EDGES = [0, 0.5, 0.75, 1, 1.5, 2, 3], AGE_EDGES = [1, 3, 6, 11, 21], R5 = [0, 0.5, 0.75, 1, 1.5];
const bucketOf = (edges, v) => { let b = 0; for (let i = 1; i < edges.length; i++) if (v >= edges[i]) b = i; return b; };
function stateTables(ch){
  const acc = new Map();
  const add = (key, hit, ok) => { if (!ok) return; let e = acc.get(key); if (!e){ e = { n: 0, s: 0 }; acc.set(key, e); } e.n++; e.s += hit; };
  const cell = key => { const e = acc.get(key); return e ? { n: e.n, p: +(e.s/e.n).toFixed(3) } : { n: 0, p: null }; };
  for (const [group, label, stem] of INSTRUMENTS){
    if (!prepared[`${stem}|${ch}`]) continue;
    // Every valid day on disk from the first with an ATR, not just the board's window.
    const Pall = E.load(stem, ch, '2026-01-26', sampleWindow(ch).to); if (!Pall) continue;
    const O = E.outcomes(Pall, { th: TH[ch], agg: DEF.agg, side: DEF.side, horizon: DEF.horizon });
    // Tertile of each window's all-days share within this instrument, for the next-window lookup.
    const sh = new Float64Array(SLOTS); for (const d of O.days) for (const k of O.open) sh[k] += d.trend[k];
    const order = O.open.slice().sort((a, b) => sh[a] - sh[b]); const tert = new Int8Array(SLOTS).fill(-1); order.forEach((k, i) => { tert[k] = Math.min(2, Math.floor(3*i/order.length)); });
    for (const [h, R] of [[15, E.stateRows(O, { hBars: Pall.L })], [30, E.stateRows(O, { hBars: 2*Pall.L })]]){
      for (let i = 0; i < R.k.length; i++){
        const r = R.ratio[i], st = R.state[i], age = Math.max(1, R.age[i]), hit = R.turnNext[i];
        if (st !== 0) add(`t${h}|${bucketOf(R_EDGES, r)}|${bucketOf(AGE_EDGES, age)}|${R.side[i] === st ? 1 : 0}`, hit, true);
        else add(`s${h}|${bucketOf(R5, r)}|${R.dRatio[i] > 0 ? 1 : 0}|${bucketOf(AGE_EDGES, age)}`, hit, true);
        if (h === 15 && R.trendNext[i] >= 0) add(`n|${bucketOf(R_EDGES, r)}|${tert[R.k[i] + 1]}`, R.trendNext[i], tert[R.k[i] + 1] >= 0);
      }
    }
  }
  const turn = R_EDGES.map((_, ri) => AGE_EDGES.map((_, ai) => [0, 1].map(sd => { const a = cell(`t15|${ri}|${ai}|${sd}`), b = cell(`t30|${ri}|${ai}|${sd}`); return { n: a.n, p15: a.p, p30: b.p }; })));
  const start = R5.map((_, ri) => [0, 1].map(up => AGE_EDGES.map((_, ai) => { const a = cell(`s15|${ri}|${up}|${ai}`), b = cell(`s30|${ri}|${up}|${ai}`); return { n: a.n, p15: a.p, p30: b.p }; })));
  const next = R_EDGES.map((_, ri) => [0, 1, 2].map(t => cell(`n|${ri}|${t}`)));
  // Marginals over age, for the page to fall back on where a cell holds fewer than 300 bars (the fresh-flat cells are
  // V-reversals read through an unsigned slope and print figures no bar delivers).
  const pool = (keys15, keys30) => { let n = 0, s15 = 0, s30 = 0; for (const k of keys15){ const e = acc.get(k); if (e){ n += e.n; s15 += e.s; } } let n30 = 0; for (const k of keys30){ const e = acc.get(k); if (e){ n30 += e.n; s30 += e.s; } } return { n, p15: n ? +(s15/n).toFixed(3) : null, p30: n30 ? +(s30/n30).toFixed(3) : null }; };
  const turnMarg = R_EDGES.map((_, ri) => [0, 1].map(sd => pool(AGE_EDGES.map((_, ai) => `t15|${ri}|${ai}|${sd}`), AGE_EDGES.map((_, ai) => `t30|${ri}|${ai}|${sd}`))));
  const startMarg = R5.map((_, ri) => [0, 1].map(up => pool(AGE_EDGES.map((_, ai) => `s15|${ri}|${up}|${ai}`), AGE_EDGES.map((_, ai) => `s30|${ri}|${up}|${ai}`))));
  return { rEdges: R_EDGES, ageEdges: AGE_EDGES, r5Edges: R5, turn, start, next, turnMarg, startMarg };
}
// How the last four weeks of the sample compare with the whole window, per instrument and chart: turns
// a day and trending share, as ratios. The study found the regime moving by a third within a quarter;
// the page shows the ratio beside the climatology rather than scaling anything by it.
function regime(ch){
  const out = {};
  for (const [label, c] of record[ch]){ if (c.meta.of) continue;
    const stem = INSTRUMENTS.find(x => x[1] === label)[2], P = prepared[`${stem}|${ch}`]; if (!P) continue;
    const O = E.outcomes(P, { th: TH[ch], agg: DEF.agg, side: DEF.side, horizon: DEF.horizon });
    const last = O.days[O.days.length - 1].day - 28, recent = O.days.filter(d => d.day > last), all = O.days;
    const tpd = ds => ds.reduce((a, d) => a + O.open.reduce((x, k) => x + d.turns[k], 0), 0)/(ds.length || 1);
    const shr = ds => ds.reduce((a, d) => a + O.open.reduce((x, k) => x + d.trend[k], 0), 0)/((ds.length || 1)*O.open.length);
    out[label] = { turns: +(tpd(recent)/tpd(all)).toFixed(2), share: +(shr(recent)/shr(all)).toFixed(2), days: recent.length };
  }
  return out;
}
const LIVE = { built: new Date().toISOString().slice(0, 10), ma: 'sma20', th: TH, L: { 2: 8, 5: 3, 15: 1 }, def: DEF, atr: atrEnd, tables: {}, regime: {} };
for (const ch of CHARTS){ LIVE.tables[ch] = stateTables(ch); LIVE.regime[ch] = regime(ch);
  const t = LIVE.tables[ch].turn; console.log(`${ch}m turn table, P(turn in 15 min) by age, price on the trend side: r 1-1.5 ${t[3].map(x => x[1].p15).join('/')} | r 2-3 ${t[5].map(x => x[1].p15).join('/')}; against the trend: r 1-1.5 ${t[3].map(x => x[0].p15).join('/')}`);
  const rg = Object.values(LIVE.regime[ch]); console.log(`${ch}m regime (last 4 weeks / window): turns ${(rg.reduce((a, x) => a + x.turns, 0)/rg.length).toFixed(2)}, share ${(rg.reduce((a, x) => a + x.share, 0)/rg.length).toFixed(2)}`); }

if (args.dry) process.exit(0);
// Find the literals before touching anything, so a page the anchors cannot find leaves data/rows intact.
// git can hand the page back with CRLF (core.autocrlf on a rebase or checkout) and the anchors need LF,
// so normalise on the way in and write LF back.
const file = path.join(root, 'index.html');
let h = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const grab = re => { const m = h.match(re); if (!m) throw new Error('literal not found: ' + re); return m; };
const mB = grab(/^const BOARDS = (\{.*\});$/m), mL = grab(/^const LIVE = (\{.*\});$/m);
const dir = path.join(root, 'data', 'rows');
for (const ch of CHARTS){ const d = path.join(dir, 'm' + ch); fs.mkdirSync(d, { recursive: true }); for (const f of fs.readdirSync(d)) if (f.endsWith('.json')) fs.unlinkSync(path.join(d, f));
  for (const [label, c] of record[ch]) fs.writeFileSync(path.join(d, slug(label) + '.json'), JSON.stringify({ row: c.row, turnc: c.turnc, meta: c.meta })); }
for (const f of fs.readdirSync(dir)) if (f.endsWith('.json') && f !== '_board.json') fs.unlinkSync(path.join(dir, f));   // the single-chart layout, pre-October 2026
fs.writeFileSync(path.join(dir, '_board.json'), JSON.stringify({ built: LIVE.built, def: DEF, charts: Object.fromEntries(CHARTS.map(ch => [ch, { from: BOARDS[ch].from, to: BOARDS[ch].to, th: TH[ch],
  rows: record[ch].map(([l, c]) => ({ label: l, days: c.meta.days, from: c.meta.from || null, to: c.meta.to || null, source: c.meta.source || null, of: c.meta.of || null })), missing: missingAll[ch] }])) }, null, 1));
fs.writeFileSync(path.join(root, 'data', 'live_tables.json'), JSON.stringify(LIVE));
h = h.replace(mB[0], 'const BOARDS = ' + JSON.stringify(BOARDS) + ';').replace(mL[0], 'const LIVE = ' + JSON.stringify(LIVE) + ';');
fs.writeFileSync(file, h);
console.log('\nindex.html updated: ' + CHARTS.map(ch => ch + 'm ' + BOARDS[ch].ROWS.length + ' rows').join(', '));
