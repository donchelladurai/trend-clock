#!/usr/bin/env node
// Build one TrendClock board row (ROWS entry + TURNC row) from N-minute bars.
//
//   node tools/gen_row.js --bars data/spxusd_m2.json --minutes 2 --label "US 500" --group Indices \
//        --from 2026-06-22 --to 2026-09-18 [--th 0.015] [--out data/rows/us500.json] [--compare] [--sweep 0.01,0.015,0.02]
//
// Input bars: JSON array of [utc_ms, open, high, low, close, real], bar OPEN time, sorted, on a
// complete grid inside each trading week (tools/hist2bars.py and tools/duka2bars.py write this;
// real = 0 marks a bucket the feed had nothing for, filled flat).
//
// Definitions — see CLAUDE.md §1b. One rule for every chart, in units of the instrument's own
// daily range, so a 2-minute index row and a 5-minute FX row answer the same question about
// different charts:
//   MA        20-period EMA of the bar closes, on the continuous series (weekend gaps ignored).
//   scale     14-day Wilder ATR of UK-calendar-day bars, taken from completed trading days only
//             (Mon-Fri with at least six hours of real bars, so an FX Sunday-evening hour or a
//             holiday stub is not a day).
//   move      d[t] = EMA[t] - EMA[t-L], the MA's move over the last 15 minutes of clock time:
//             L = round(15 / minutes) bars, i.e. 3 bars on the 5-minute chart, 8 (16 min) on the
//             2-minute chart.
//   trending  bar t is trending when |d[t]| >= TH * scale; a 15-minute window is trending on a
//             day when any of its bars is (3 bars on the 5-minute chart, 7 or 8 on the 2-minute).
//   trend     a 3-state (+1 / 0 / -1) with hysteresis: enter +-1 when |d| >= 2 TH * scale, hold
//             while the sign is unchanged and |d| >= 0.5 TH * scale, else re-evaluate.
//   turn      every bar at which that state differs from the bar before; counted in the window
//             holding that bar.
//   window k  UK clock 08:00 + 15k, k = 0..51; a bar belongs to the window holding its open.
//   open      window k is open when, over the Mon-Fri days in range, at least half of its bars
//             are real on at least half the days; otherwise it is drawn closed and left out of
//             every statistic (Chicago Wheat's pre-open gap, the evening after a cash close).
//   valid day Mon-Fri (UK); every board bar on the grid; at least 90% of the bars in open windows
//             real; at least half of those bars show movement (drops holidays and dead feeds).
//             No warm-up hour is demanded before 08:00: the EMA runs on the continuous series and
//             a feed that starts the week at 08:00 (France 40) is read as its chart shows it.
const fs = require('fs');
const SLOTS = 52, MA_LEN = 20, ATR_DAYS = 14, ON_RATIO = 2, OFF_RATIO = 0.5, OPEN_SHARE = 0.5, REAL_DAY = 0.9;
const DAY = 86400000, MODES = ['0','1','2','3','4','all'];
const ymd = s => { const [y,m,d] = s.split('-').map(Number); return Math.floor(Date.UTC(y, m-1, d)/DAY); };
const fmtDay = d => new Date(d*DAY).toISOString().slice(0, 10);
const sgn = x => x > 0 ? 1 : x < 0 ? -1 : 0;
const fmt = new Intl.DateTimeFormat('en-GB',{timeZone:'Europe/London',hour12:false,year:'numeric',month:'2-digit',day:'2-digit',hour:'2-digit',minute:'2-digit'});
const offCache = new Map();
function offMin(ts){ const h = Math.floor(ts/3600000); let o = offCache.get(h);
  if (o === undefined){ const p = {}; for (const x of fmt.formatToParts(new Date(h*3600000))) p[x.type] = x.value;
    o = (Date.UTC(+p.year, +p.month-1, +p.day, (+p.hour)%24, +p.minute) - h*3600000)/60000; offCache.set(h, o); } return o; }

// Everything that does not depend on the threshold: the grid, the day index, EMA, ATR and d.
function prepare(raw, o){
  const B = o.minutes, L = Math.round(15/B), perDay = 780/B, warm = 0, from = ymd(o.from), to = ymd(o.to);
  raw = raw.filter(b => b[4] > 0).sort((a, b) => a[0] - b[0]);
  const bars = []; for (const b of raw){ if (bars.length && bars[bars.length-1][0] === b[0]) continue; bars.push(b); }
  const n = bars.length, c = new Float64Array(n), hi = new Float64Array(n), lo = new Float64Array(n), real = new Uint8Array(n);
  const day = new Int32Array(n), pos = new Int16Array(n).fill(-999), wd = new Int8Array(n);
  for (let i = 0; i < n; i++){ const b = bars[i]; hi[i] = b[2]; lo[i] = b[3]; c[i] = b[4]; real[i] = b.length > 5 ? (b[5] ? 1 : 0) : 1;
    const lt = b[0] + offMin(b[0])*60000; day[i] = Math.floor(lt/DAY); const m = Math.floor((lt - day[i]*DAY)/60000); wd[i] = new Date(lt).getUTCDay();
    if (m >= 480 && m < 1260 && (m - 480) % B === 0) pos[i] = (m - 480)/B; }
  const ema = new Float64Array(n).fill(NaN); { const a = 2/(MA_LEN+1); let s = 0, e = NaN; for (let i = 0; i < n; i++){ if (i < MA_LEN-1){ s += c[i]; continue; } if (i === MA_LEN-1){ s += c[i]; e = s/MA_LEN; } else e = a*c[i] + (1-a)*e; ema[i] = e; } }
  // Daily ATR over UK calendar days that are trading days: Mon-Fri with at least six hours of real
  // bars. Without that test the FX feeds' Sunday-evening hour (one twelfth of a day, a quarter of
  // a day's range) entered as a day of its own once a week and deflated the FX scale by ~13%
  // against the index and gold feeds, which open at midnight and have no such stub.
  const atrD = new Float64Array(n).fill(NaN); { let d = -1, dh = 0, dl = 0, pc = NaN, atr = NaN, cnt = 0, acc = 0, nb = 0, wdd = 0;
    const minBars = 360/B;
    for (let i = 0; i < n; i++){
      if (day[i] !== d){ if (d >= 0 && wdd >= 1 && wdd <= 5 && nb >= minBars){ const tr = Math.max(dh-dl, isNaN(pc) ? 0 : Math.abs(dh-pc), isNaN(pc) ? 0 : Math.abs(dl-pc)); pc = c[i-1];
          if (cnt < ATR_DAYS){ acc += tr; cnt++; if (cnt === ATR_DAYS) atr = acc/ATR_DAYS; } else atr = (atr*(ATR_DAYS-1) + tr)/ATR_DAYS; }
        d = day[i]; dh = hi[i]; dl = lo[i]; nb = real[i]; wdd = wd[i]; }
      else { if (hi[i] > dh) dh = hi[i]; if (lo[i] < dl) dl = lo[i]; nb += real[i]; }
      atrD[i] = atr; } }
  const dm = new Float64Array(n).fill(NaN); for (let i = L; i < n; i++) dm[i] = ema[i] - ema[i-L];
  // Day index: one slot per grid position from 08:00 to 21:00.
  const map = new Map();
  for (let i = 0; i < n; i++){ const p = pos[i]; if (p === -999) continue; const d = day[i]; if (d < from || d > to || wd[i] < 1 || wd[i] > 5) continue;
    let e = map.get(d); if (!e){ e = { wd: wd[i], idx: new Int32Array(perDay + warm).fill(-1) }; map.set(d, e); } if (e.idx[p + warm] < 0) e.idx[p + warm] = i; }
  // Which positions fall in which window, and which windows are open on this feed.
  const win = []; for (let k = 0; k < SLOTS; k++) win.push([]); for (let p = 0; p < perDay; p++) win[Math.floor(p*B/15)].push(p + warm);
  const realShare = new Array(SLOTS).fill(0); let cand = 0;
  for (const e of map.values()){ let any = false; for (let p = warm; p < perDay + warm; p++) if (e.idx[p] >= 0 && real[e.idx[p]]) { any = true; break; } if (!any) continue; cand++;
    for (let k = 0; k < SLOTS; k++){ let r = 0; for (const p of win[k]) if (e.idx[p] >= 0 && real[e.idx[p]]) r++; if (r >= win[k].length/2) realShare[k]++; } }
  for (let k = 0; k < SLOTS; k++) realShare[k] = cand ? realShare[k]/cand : 0;
  const closed = realShare.map(x => x < OPEN_SHARE), open = []; for (let k = 0; k < SLOTS; k++) if (!closed[k]) open.push(k);
  const openPos = []; for (const k of open) openPos.push(...win[k]);
  const days = [];
  for (const [d, e] of map){ if (e.idx.some(x => x < 0)) continue;
    let r = 0, moves = 0; for (const p of openPos){ const i = e.idx[p]; if (real[i]) r++; if (c[i] !== c[i-1] || hi[i] !== lo[i]) moves++; }
    if (r < REAL_DAY*openPos.length || moves < openPos.length/2) continue;
    days.push({ day: d, wd: e.wd, idx: e.idx }); }
  days.sort((a, b) => a.day - b.day);
  return { n, c, atrD, dm, days, win, open, closed, realShare, B, L, perDay, warm };
}

// The threshold-dependent part: trending bars, turns, and the six profiles.
function score(P, th){
  const { n, atrD, dm, days, win, open } = P, on = ON_RATIO*th, off = OFF_RATIO*th;
  const trending = new Uint8Array(n), state = new Int8Array(n), turn = new Uint8Array(n);
  let started = false;
  for (let i = 0; i < n; i++){ const x = dm[i], b = atrD[i]; if (isNaN(x) || isNaN(b)){ started = false; continue; }
    trending[i] = Math.abs(x) >= th*b ? 1 : 0;
    const prev = state[i-1] || 0;
    state[i] = (prev !== 0 && sgn(x) === prev && Math.abs(x) >= off*b) ? prev : (Math.abs(x) >= on*b ? sgn(x) : 0);
    if (started && state[i] !== state[i-1]) turn[i] = 1; started = true; }
  const prof = {}, dcount = {}, turnc = [];
  for (const m of MODES){
    const sel = m === 'all' ? days : days.filter(d => d.wd === +m + 1);
    const sh = new Float64Array(SLOTS), tc = new Float64Array(SLOTS);
    for (const d of sel) for (const k of open){ let tr = 0, tu = 0; for (const p of win[k]){ const i = d.idx[p]; if (trending[i]) tr = 1; tu += turn[i]; } sh[k] += tr; tc[k] += tu; }
    const total = tc.reduce((a, b) => a + b, 0), lam = total/open.length;
    prof[m] = { s: Array.from(sh, x => sel.length ? +(x/sel.length).toFixed(2) : 0), t: Array.from(tc, x => lam ? +(x/lam).toFixed(2) : 0), counts: Array.from(tc) };
    dcount[m] = sel.length; turnc.push(total);
  }
  return { prof, dcount, turnc };
}

function genRow(raw, o){
  const P = prepare(raw, o), th = o.th, S = score(P, th);
  const { prof, dcount, turnc } = S, days = P.days;
  const row = { group: o.group, label: o.label, big: !!o.big, closed: P.closed.slice(),
    days: { all: dcount.all, 0: dcount[0], 1: dcount[1], 2: dcount[2], 3: dcount[3], 4: dcount[4] },
    data: Object.fromEntries(MODES.map(m => [m, { s: prof[m].s, t: prof[m].t }])) };
  const meta = { from: days.length ? fmtDay(days[0].day) : null, to: days.length ? fmtDay(days[days.length-1].day) : null, days: days.length,
    byWeekday: [1,2,3,4,5].map(w => days.filter(d => d.wd === w).length), minutes: o.minutes, moveBars: P.L,
    params: { TREND_TH: th, TURN_ON: ON_RATIO*th, TURN_OFF: OFF_RATIO*th, MA_LEN, ATR_DAYS, OPEN_SHARE, REAL_DAY },
    open: P.open.length, realShare: P.realShare.map(x => +x.toFixed(2)), counts: Object.fromEntries(MODES.map(m => [m, prof[m].counts])), source: o.source || null };
  return { row, turnc, meta, P, S };
}

function summary(P, S, label){
  const { prof, turnc } = S, days = P.days, open = P.open;
  const sAll = open.map(k => prof.all.s[k]), q = (a, p) => { const s = a.slice().sort((x, y) => x - y); return s[Math.floor(p*(s.length-1))]; };
  const wl = turnc.slice(0, 5).map(x => x/open.length);
  const f1 = x => Number(x).toFixed(1), f2 = x => Number(x).toFixed(2);
  return label + ': ' + days.length + ' days ' + (days.length ? fmtDay(days[0].day) : '-') + '–' + (days.length ? fmtDay(days[days.length-1].day) : '-')
    + ' (' + [1,2,3,4,5].map(w => days.filter(d => d.wd === w).length).join('/') + '), open ' + open.length + '/' + SLOTS
    + ' | s mean ' + f2(sAll.reduce((a, b) => a + b, 0)/sAll.length) + ' q10 ' + f2(q(sAll, .1)) + ' q50 ' + f2(q(sAll, .5)) + ' q90 ' + f2(q(sAll, .9)) + ' max ' + f2(Math.max(...sAll)) + ' >=.75: ' + sAll.filter(x => x >= .75).length
    + ' | turns/day ' + f1(turnc[5]/days.length) + ' lambda all ' + f1(turnc[5]/open.length) + ' weekday ' + f1(Math.min(...wl)) + '–' + f1(Math.max(...wl));
}

module.exports = { genRow, prepare, score, summary, SLOTS, MODES };

if (require.main === module){
  const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i+1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
  if (!args.bars || !args.label || !args.group || !args.from || !args.to || !args.minutes){ console.error('usage: --bars file --minutes N --label L --group G --from YYYY-MM-DD --to YYYY-MM-DD [--th 0.015] [--out file] [--compare] [--sweep a,b,c]'); process.exit(1); }
  const raw = JSON.parse(fs.readFileSync(args.bars, 'utf8'));
  const o = { minutes: +args.minutes, th: +(args.th || 0.015), from: args.from, to: args.to, label: args.label, group: args.group, big: !!args.big, source: args.source };
  if (args.sweep){ const P = prepare(raw, o); for (const th of args.sweep.split(',').map(Number)) console.log('th ' + th + ': ' + summary(P, score(P, th), args.label)); process.exit(0); }
  const { row, turnc, meta, P, S } = genRow(raw, o);
  console.log(summary(P, S, args.label));
  console.log('TURNC ' + turnc.join(',') + '; closed windows: ' + (row.closed.map((x, k) => x ? k : null).filter(x => x !== null).join(',') || 'none'));
  let worst = 0, off = 0, cells = 0;
  for (const m of MODES){ let s = 0; const lam = turnc[MODES.indexOf(m)]/P.open.length; for (const k of P.open){ s += row.data[m].t[k]; cells++; if (Math.round(row.data[m].t[k]*lam) !== meta.counts[m][k]) off++; } worst = Math.max(worst, Math.abs(s - P.open.length)); }
  console.log('invariant 3 worst |sum(t)-open| = ' + worst.toFixed(3) + '; count recovery round(t*lambda) off in ' + off + ' of ' + cells + ' cells');
  if (args.compare){
    const h = fs.readFileSync(__dirname + '/../index.html', 'utf8'); const ROWS = JSON.parse(h.match(/const ROWS = (\[.*?\]);\n/s)[1]); const TURNC = JSON.parse(h.match(/const TURNC = (\[\[[\s\S]*?\]\]);/)[1]);
    const ri = ROWS.findIndex(r => r.label === (args.compare === true ? args.label : args.compare)); if (ri < 0) console.log('no such row to compare');
    else { const r = ROWS[ri]; const ks = P.open.filter(k => !r.closed[k]); const corr = (a, b) => { const n = a.length; let ma = 0, mb = 0; for (let i = 0; i < n; i++){ ma += a[i]; mb += b[i]; } ma /= n; mb /= n; let ab = 0, aa = 0, bb = 0; for (let i = 0; i < n; i++){ const x = a[i]-ma, y = b[i]-mb; ab += x*y; aa += x*x; bb += y*y; } return ab/Math.sqrt(aa*bb); };
      const rmse = (a, b) => Math.sqrt(a.reduce((s, x, i) => s + (x-b[i])**2, 0)/a.length);
      const a = ks.map(k => row.data.all.s[k]), b = ks.map(k => r.data.all.s[k]), ta = ks.map(k => row.data.all.t[k]), tb = ks.map(k => r.data.all.t[k]);
      console.log('vs existing ' + r.label + ': days ' + r.days.all + ' (ref) | s rmse ' + rmse(a, b).toFixed(3) + ' corr ' + corr(a, b).toFixed(2) + ' mean ' + (b.reduce((x, y) => x + y, 0)/b.length).toFixed(3) + ' (ref) | t corr ' + corr(ta, tb).toFixed(2) + ' | turns/day ' + (turnc[5]/P.days.length).toFixed(2) + ' vs ' + (TURNC[ri][5]/r.days.all).toFixed(2) + ' (ref)'); } }
  if (args.out){ fs.mkdirSync(require('path').dirname(args.out), { recursive: true }); fs.writeFileSync(args.out, JSON.stringify({ row, turnc, meta })); }
}
