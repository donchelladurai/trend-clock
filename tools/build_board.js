#!/usr/bin/env node
// Build every board row from the bar files in data/ and write them into index.html.
//
//   node tools/build_board.js [--from 2026-06-22 --to 2026-09-18] [--th5 0.015 --th2 0.027] [--dry]
//
// One entry per instrument below names its group, label, bar file, chart (minutes per bar) and
// source. Composites are the mean share and the summed turn counts of the instruments beneath
// them, in the order the board draws (composite first, then its constituents — COMPOSITE in
// index.html depends on that order). An instrument whose bar file is missing is left off the
// board and named in the output; a composite then sums whatever constituents it has.
//
// Writes data/rows/<slug>.json for every row (the committed record, with meta.counts) and
// data/rows/_board.json (dates, thresholds, what went in), then replaces the ROWS, TURNC and
// GROUPS literals in index.html. --dry builds and reports without touching index.html.
const fs = require('fs'), path = require('path');
const { genRow, SLOTS, MODES } = require('./gen_row.js');
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i+1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
const FROM = args.from || '2026-06-22', TO = args.to || '2026-09-18', TH5 = +(args.th5 || 0.015), TH2 = +(args.th2 || 0.027);
const root = path.join(__dirname, '..');
const TH = { 2: TH2, 5: TH5 };

// group, label, bars, minutes, source, flags
const INSTRUMENTS = [
  ['Indices', 'FTSE 100', 'data/ukxgbp_m2.json', 2, 'histdata.com UKXGBP'],
  ['Indices', 'Germany 40', 'data/grxeur_m2.json', 2, 'histdata.com GRXEUR'],
  ['Indices', 'France 40', 'data/frxeur_m2.json', 2, 'histdata.com FRXEUR'],
  ['Indices', 'Wall Street', 'data/usa30_m2.json', 2, 'Dukascopy USA30IDXUSD'],
  ['Indices', 'US Tech 100', 'data/nsxusd_m2.json', 2, 'histdata.com NSXUSD'],
  ['Indices', 'US 500', 'data/spxusd_m2.json', 2, 'histdata.com SPXUSD'],
  ['FX — USD pairs', 'EUR/USD', 'data/eurusd_m5.json', 5, 'histdata.com EURUSD'],
  ['FX — USD pairs', 'GBP/USD', 'data/gbpusd_m5.json', 5, 'histdata.com GBPUSD'],
  ['FX — USD pairs', 'AUD/USD', 'data/audusd_m5.json', 5, 'histdata.com AUDUSD'],
  ['FX — USD pairs', 'USD/CAD', 'data/usdcad_m5.json', 5, 'histdata.com USDCAD'],
  ['FX — USD pairs', 'USD/JPY', 'data/usdjpy_m5.json', 5, 'histdata.com USDJPY'],
  ['FX — USD pairs', 'USD/CHF', 'data/usdchf_m5.json', 5, 'histdata.com USDCHF'],
  ['FX — USD pairs', 'NZD/USD', 'data/nzdusd_m5.json', 5, 'histdata.com NZDUSD'],
  ['FX — EUR crosses', 'EUR/GBP', 'data/eurgbp_m5.json', 5, 'histdata.com EURGBP'],
  ['FX — EUR crosses', 'EUR/AUD', 'data/euraud_m5.json', 5, 'histdata.com EURAUD'],
  ['FX — EUR crosses', 'EUR/JPY', 'data/eurjpy_m5.json', 5, 'histdata.com EURJPY'],
  ['FX — EUR crosses', 'EUR/CAD', 'data/eurcad_m5.json', 5, 'histdata.com EURCAD'],
  ['FX — EUR crosses', 'EUR/CHF', 'data/eurchf_m5.json', 5, 'histdata.com EURCHF'],
  ['FX — EUR crosses', 'EUR/NZD', 'data/eurnzd_m5.json', 5, 'histdata.com EURNZD'],
  ['FX — other crosses', 'AUD/JPY', 'data/audjpy_m5.json', 5, 'histdata.com AUDJPY'],
  ['Commodities', 'Spot Gold', 'data/xauusd_m2.json', 2, 'histdata.com XAUUSD', { big: true }],
  // No free 2-minute source reaches back three months for CBOT wheat (histdata and Dukascopy do
  // not carry it; Yahoo's 2-minute history stops five weeks back). Point this at a bar file in the
  // same shape — [utc_ms, o, h, l, c, real] — and the row comes back.
  ['Commodities', 'Chicago Wheat', 'data/wheat_m2.json', 2, 'none', { big: true }],
];
const COMPOSITES = [
  ['Indices', 'Europe', ['FTSE 100', 'Germany 40', 'France 40']],
  ['Indices', 'US', ['Wall Street', 'US Tech 100', 'US 500']],
  ['FX — USD pairs', 'USD pairs', ['EUR/USD', 'GBP/USD', 'AUD/USD', 'USD/CAD', 'USD/JPY', 'USD/CHF', 'NZD/USD']],
  ['FX — EUR crosses', 'EUR crosses', ['EUR/GBP', 'EUR/AUD', 'EUR/JPY', 'EUR/CAD', 'EUR/CHF', 'EUR/NZD']],
];
// Group, guide lines (minutes from 08:00), minutes per bar — index.html's build() prints the chart.
const GROUPS = [['Indices', [390, 510], 2], ['FX — USD pairs', [330, 390, 480], 5], ['FX — EUR crosses', [330, 390, 480], 5], ['FX — other crosses', [330, 390, 480], 5], ['Commodities', [330, 390, 480], 2]];
const slug = s => s.toLowerCase().replace(/[^a-z0-9]+/g, '_').replace(/^_|_$/g, '');
const r2 = x => +x.toFixed(2);

const built = new Map(), missing = [];
for (const [group, label, bars, minutes, source, flags] of INSTRUMENTS){
  const f = path.join(root, bars);
  if (!fs.existsSync(f)){ missing.push(label); continue; }
  const raw = JSON.parse(fs.readFileSync(f, 'utf8'));
  const { row, turnc, meta } = genRow(raw, { minutes, th: TH[minutes], from: FROM, to: TO, label, group, big: !!(flags && flags.big), source });
  if (!meta.days){ missing.push(label + ' (no valid days)'); continue; }
  built.set(label, { row, turnc, meta, minutes });
  console.log(label.padEnd(14) + ' ' + minutes + 'm  ' + String(meta.days).padStart(3) + ' days ' + meta.from + '–' + meta.to + ' (' + meta.byWeekday.join('/') + ')  open ' + meta.open + '  turns/day ' + (turnc[5]/meta.days).toFixed(1) + '  lambda all ' + (turnc[5]/meta.open).toFixed(1) + '  s mean ' + (row.closed.reduce((a, c, k) => c ? a : a + row.data.all.s[k], 0)/meta.open).toFixed(2));
}
function compose(group, label, kids){
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
  return { row, turnc, meta: { of: K.map(x => x.row.label), days: days.all, open: open.length, counts }, minutes: K[0].minutes };
}
// Board order: each group's composite first, then its constituents, then the rest of the group.
const ROWS = [], TURNC = [], record = [];
for (const [g] of GROUPS){
  const used = new Set();
  for (const comp of COMPOSITES.filter(c => c[0] === g)){
    const c = compose(comp[0], comp[1], comp[2]); if (!c) continue;
    ROWS.push(c.row); TURNC.push(c.turnc); record.push([comp[1], c]);
    for (const l of comp[2]) if (built.has(l)){ used.add(l); ROWS.push(built.get(l).row); TURNC.push(built.get(l).turnc); record.push([l, built.get(l)]); }
  }
  for (const [group, label] of INSTRUMENTS) if (group === g && built.has(label) && !used.has(label)){ ROWS.push(built.get(label).row); TURNC.push(built.get(label).turnc); record.push([label, built.get(label)]); }
}
console.log('rows ' + ROWS.length + (missing.length ? '; left off: ' + missing.join(', ') : ''));
for (const [label, c] of record) if (c.meta.of) console.log(label.padEnd(14) + ' = ' + c.meta.of.join(' + ') + '  days ' + c.meta.days + '  turns/day ' + (c.turnc[5]/c.meta.days).toFixed(1) + '  lambda all ' + (c.turnc[5]/c.meta.open).toFixed(1));
// Invariants 1–3.
let ok1 = TURNC.every(t => t.slice(0, 5).reduce((a, b) => a + b, 0) === t[5]), worst = 0;
for (const r of ROWS) for (const m of MODES){ let s = 0, n = 0; for (let k = 0; k < SLOTS; k++){ if (r.closed[k]) continue; s += r.data[m].t[k]; n++; } worst = Math.max(worst, Math.abs(s - n)); }
console.log('invariant 1 ' + (ok1 ? 'ok' : 'FAILED') + '; invariant 3 worst ' + worst.toFixed(3));
if (args.dry) process.exit(0);
// Find the three literals before touching anything, so a page the anchors cannot find leaves
// data/rows intact. git can hand the page back with CRLF (core.autocrlf on a rebase or checkout)
// and the anchors need LF, so normalise on the way in and write LF back.
const file = path.join(root, 'index.html');
let h = fs.readFileSync(file, 'utf8').replace(/\r\n/g, '\n');
const grab = re => { const m = h.match(re); if (!m) throw new Error('literal not found: ' + re); return m; };
const mR = grab(/const ROWS = (\[.*?\]);\n/s), mT = grab(/const TURNC = (\[.*\]);/), mG = grab(/const GROUPS = (\[.*\]);/);
const dir = path.join(root, 'data', 'rows'); fs.mkdirSync(dir, { recursive: true });
for (const f of fs.readdirSync(dir)) if (f.endsWith('.json')) fs.unlinkSync(path.join(dir, f));
for (const [label, c] of record) fs.writeFileSync(path.join(dir, slug(label) + '.json'), JSON.stringify({ row: c.row, turnc: c.turnc, meta: c.meta }));
fs.writeFileSync(path.join(dir, '_board.json'), JSON.stringify({ built: new Date().toISOString().slice(0, 10), from: FROM, to: TO, th: { 2: TH2, 5: TH5 }, rows: record.map(([l, c]) => ({ label: l, minutes: c.minutes, days: c.meta.days, from: c.meta.from || null, to: c.meta.to || null, source: c.meta.source || null, of: c.meta.of || null })), missing }, null, 1));
h = h.replace(mR[0], 'const ROWS = ' + JSON.stringify(ROWS) + ';\n').replace(mT[0], 'const TURNC = ' + JSON.stringify(TURNC) + ';').replace(mG[0], 'const GROUPS = ' + JSON.stringify(GROUPS) + ';');
fs.writeFileSync(file, h);
console.log('index.html updated: ' + ROWS.length + ' rows');
