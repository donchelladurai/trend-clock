#!/usr/bin/env node
// Build one TrendClock board row (ROWS entry + TURNC row) from 5-minute bars.
//
//   node tools/gen_row.js --bars data/audjpy_m5.json --label "AUD/JPY" --group "FX — other crosses" \
//        --from 2021-09-13 --to 2026-09-11 --out data/row_audjpy.json [--compare]
//
// Input bars: JSON array of [utc_ms, open, high, low, close], 5-minute, bar OPEN time, sorted.
// (tools/hist2m5.py produces this from histdata.com M1 zips.)
//
// Definitions — see CLAUDE.md §1b. They were calibrated against the original 24 rows, whose
// generator is not available, so they reproduce those rows approximately, not exactly.
//   MA        20-period EMA of 5-minute closes, on the continuous series (weekend gaps ignored).
//   scale     14-day Wilder ATR of UK-calendar-day bars, taken from completed days only.
//   move      d3[t] = EMA[t] - EMA[t-3]  (the MA's move over the last 15 minutes)
//   trending  bar t is trending when |d3[t]| >= TREND_TH * scale; a 15-minute window is
//             trending on a day when any of its three bars is.
//   trend     a 3-state (+1 / 0 / -1) with hysteresis: enter +-1 when |d3| >= TURN_ON * scale,
//             hold while the sign is unchanged and |d3| >= TURN_OFF * scale, else re-evaluate.
//   turn      every bar at which that state differs from the bar before; counted in the window
//             holding that bar.
//   window k  UK clock 08:00 + 15k, k = 0..51, three bars with open times at :00 :05 :10.
//   valid day Mon-Fri (UK), all 156 board bars and the 12 bars before 08:00 present, and at
//             least half the board bars show movement (drops 25 Dec, 1 Jan and the like).
const fs = require('fs');
const TREND_TH = 0.015, TURN_ON = 0.03, TURN_OFF = 0.0075, MA_LEN = 20, ATR_DAYS = 14, SLOTS = 52;

const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i+1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
if (!args.bars || !args.label || !args.group || !args.from || !args.to){ console.error('usage: --bars file --label L --group G --from YYYY-MM-DD --to YYYY-MM-DD [--out file] [--compare]'); process.exit(1); }

// ---- UK-local mapping -------------------------------------------------------------------
const fmt = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const offCache = new Map();
function offMin(ts){ const h = Math.floor(ts/3600000); let o = offCache.get(h);
  if (o === undefined){ const p = {}; for (const x of fmt.formatToParts(new Date(h*3600000))) p[x.type] = x.value;
    o = (Date.UTC(+p.year, +p.month-1, +p.day, (+p.hour)%24, +p.minute) - h*3600000)/60000; offCache.set(h, o); } return o; }
const DAY = 86400000, ymd = s => { const [y,m,d] = s.split('-').map(Number); return Math.floor(Date.UTC(y, m-1, d)/DAY); };
const sgn = x => x > 0 ? 1 : x < 0 ? -1 : 0;

// ---- load ---------------------------------------------------------------------------------
const raw = JSON.parse(fs.readFileSync(args.bars, 'utf8')).filter(b => b[4] > 0).sort((a, b) => a[0] - b[0]);
const bars = []; for (const b of raw){ if (bars.length && bars[bars.length-1][0] === b[0]) continue; bars.push(b); }
const n = bars.length, c = new Float64Array(n), hi = new Float64Array(n), lo = new Float64Array(n);
const day = new Int32Array(n), slot = new Int16Array(n), wd = new Int8Array(n);
for (let i = 0; i < n; i++){ const b = bars[i]; hi[i] = b[2]; lo[i] = b[3]; c[i] = b[4];
  const lt = b[0] + offMin(b[0])*60000; day[i] = Math.floor(lt/DAY); slot[i] = Math.floor((lt - day[i]*DAY)/300000); wd[i] = new Date(lt).getUTCDay(); }

// ---- indicators -----------------------------------------------------------------------------
const ema = new Float64Array(n).fill(NaN); { const a = 2/(MA_LEN+1); let s = 0, e = NaN; for (let i = 0; i < n; i++){ if (i < MA_LEN-1){ s += c[i]; continue; } if (i === MA_LEN-1){ s += c[i]; e = s/MA_LEN; } else e = a*c[i] + (1-a)*e; ema[i] = e; } }
const atrD = new Float64Array(n).fill(NaN); { let d = -1, dh = 0, dl = 0, pc = NaN, atr = NaN, cnt = 0, acc = 0;
  for (let i = 0; i < n; i++){
    if (day[i] !== d){ if (d >= 0){ const tr = Math.max(dh-dl, isNaN(pc) ? 0 : Math.abs(dh-pc), isNaN(pc) ? 0 : Math.abs(dl-pc)); pc = c[i-1];
        if (cnt < ATR_DAYS){ acc += tr; cnt++; if (cnt === ATR_DAYS) atr = acc/ATR_DAYS; } else atr = (atr*(ATR_DAYS-1) + tr)/ATR_DAYS; }
      d = day[i]; dh = hi[i]; dl = lo[i]; }
    else { if (hi[i] > dh) dh = hi[i]; if (lo[i] < dl) dl = lo[i]; }
    atrD[i] = atr; } }
const d3 = new Float64Array(n); for (let i = 3; i < n; i++) d3[i] = ema[i] - ema[i-3];
const trending = new Uint8Array(n), state = new Int8Array(n), turn = new Uint8Array(n);
for (let i = 40; i < n; i++){
  const x = d3[i], b = atrD[i]; if (isNaN(x) || isNaN(b)) continue;
  trending[i] = Math.abs(x) >= TREND_TH*b ? 1 : 0;
  const prev = state[i-1];
  state[i] = (prev !== 0 && sgn(x) === prev && Math.abs(x) >= TURN_OFF*b) ? prev : (Math.abs(x) >= TURN_ON*b ? sgn(x) : 0);
  if (i > 40 && state[i] !== state[i-1]) turn[i] = 1;
}

// ---- days ------------------------------------------------------------------------------------
const from = ymd(args.from), to = ymd(args.to), map = new Map();
for (let i = 0; i < n; i++){ const d = day[i]; if (d < from || d > to || wd[i] < 1 || wd[i] > 5) continue; const s = slot[i]; if (s < 84 || s >= 252) continue;
  let e = map.get(d); if (!e){ e = { wd: wd[i], idx: new Int32Array(168).fill(-1), n: 0 }; map.set(d, e); } const p = s-84; if (e.idx[p] < 0){ e.idx[p] = i; if (p >= 12) e.n++; } }
const days = [];
for (const [d, e] of map){ if (e.n < 156 || e.idx.slice(0, 12).some(x => x < 0)) continue;
  let moves = 0; for (let p = 13; p < 168; p++){ const i = e.idx[p]; if (c[i] !== c[e.idx[p-1]] || hi[i] !== lo[i]) moves++; } if (moves < 78) continue;
  days.push({ day: d, wd: e.wd, idx: e.idx }); }
days.sort((a, b) => a.day - b.day);
const fmtDay = d => new Date(d*DAY).toISOString().slice(0, 10);

// ---- profiles --------------------------------------------------------------------------------
const MODES = ['0','1','2','3','4','all'];
const prof = {}, dcount = {}, turnc = [];
for (const m of MODES){
  const sel = m === 'all' ? days : days.filter(d => d.wd === +m + 1);
  const sh = new Float64Array(SLOTS), tc = new Float64Array(SLOTS);
  for (const d of sel) for (let k = 0; k < SLOTS; k++){ const p0 = 12 + 3*k, i0 = d.idx[p0], i1 = d.idx[p0+1], i2 = d.idx[p0+2];
    if (trending[i0] || trending[i1] || trending[i2]) sh[k]++; tc[k] += turn[i0] + turn[i1] + turn[i2]; }
  const total = tc.reduce((a, b) => a + b, 0), lam = total/SLOTS;
  prof[m] = { s: Array.from(sh, x => +(x/sel.length).toFixed(2)), t: Array.from(tc, x => +(x/lam).toFixed(2)), counts: Array.from(tc) };
  dcount[m] = sel.length; turnc.push(total);
}
const row = { group: args.group, label: args.label, big: false, closed: new Array(SLOTS).fill(false),
  days: { all: dcount.all, 0: dcount[0], 1: dcount[1], 2: dcount[2], 3: dcount[3], 4: dcount[4] },
  data: { all: { s: prof.all.s, t: prof.all.t }, 0: { s: prof[0].s, t: prof[0].t }, 1: { s: prof[1].s, t: prof[1].t }, 2: { s: prof[2].s, t: prof[2].t }, 3: { s: prof[3].s, t: prof[3].t }, 4: { s: prof[4].s, t: prof[4].t } } };

// ---- report ---------------------------------------------------------------------------------
console.log(`${args.label}: ${days.length} valid days ${fmtDay(days[0].day)} – ${fmtDay(days[days.length-1].day)}, by weekday ${[1,2,3,4,5].map(w => days.filter(d => d.wd === w).length).join('/')}`);
console.log(`TURNC ${turnc.join(',')}  turns/day ${(turnc[5]/days.length).toFixed(2)}  lambda(all) ${(turnc[5]/SLOTS).toFixed(1)}  lambda(weekday) ${(Math.min(...turnc.slice(0,5))/SLOTS).toFixed(1)}–${(Math.max(...turnc.slice(0,5))/SLOTS).toFixed(1)}`);
let worst = 0, off = 0, cells = 0;
for (const m of MODES){ let s = 0; const lam = turnc[MODES.indexOf(m)]/SLOTS; for (let k = 0; k < SLOTS; k++){ s += prof[m].t[k]; cells++; if (Math.round(prof[m].t[k]*lam) !== prof[m].counts[k]) off++; } worst = Math.max(worst, Math.abs(s - SLOTS)); }
console.log(`invariant 3 worst |sum(t)-52| = ${worst.toFixed(3)}; count recovery round(t*lambda) off in ${off} of ${cells} cells`);
console.log(`trend share (all-days) mean ${(prof.all.s.reduce((a, b) => a + b, 0)/SLOTS).toFixed(3)}, range ${Math.min(...prof.all.s)}–${Math.max(...prof.all.s)}`);
if (args.compare){
  const h = fs.readFileSync(__dirname + '/../index.html', 'utf8'); const ROWS = JSON.parse(h.match(/const ROWS = (\[.*?\]);\n/s)[1]); const TURNC = JSON.parse(h.match(/const TURNC = (\[\[[\s\S]*?\]\]);/)[1]);
  const ri = ROWS.findIndex(r => r.label === args.compare || r.label === args.label); if (ri < 0){ console.log('no such row to compare'); }
  else { const r = ROWS[ri]; const corr = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++){ ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++){ const x = a[i]-ma, y = b[i]-mb; ab += x*y; aa += x*x; bb += y*y; } return ab/Math.sqrt(aa*bb); };
    const rmse = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x-b[i])**2, 0)/a.length);
    console.log(`vs existing ${r.label}: days ${r.days.all} (ref) | s rmse ${rmse(prof.all.s, r.data.all.s).toFixed(3)} corr ${corr(prof.all.s, r.data.all.s).toFixed(2)} mean ${(r.data.all.s.reduce((a, b) => a + b, 0)/SLOTS).toFixed(3)} (ref) | t corr ${corr(prof.all.t, r.data.all.t).toFixed(2)} | turns/day ${(turnc[5]/days.length).toFixed(2)} vs ${(TURNC[ri][5]/r.days.all).toFixed(2)} (ref)`); } }
if (args.out) fs.writeFileSync(args.out, JSON.stringify({ row, turnc, meta: { from: fmtDay(days[0].day), to: fmtDay(days[days.length-1].day), days: days.length, params: { TREND_TH, TURN_ON, TURN_OFF, MA_LEN, ATR_DAYS }, counts: Object.fromEntries(MODES.map(m => [m, prof[m].counts])) } }));
