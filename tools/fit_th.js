#!/usr/bin/env node
// Fit one trend threshold per chart so that "trending" carries the same intensity on the 15-, 5- and
// 2-minute charts: the threshold at which each chart calls the same pooled share of windows trending,
// over the 20 histdata instruments and every valid day in the range.
//
//   node tools/fit_th.js [--share 0.45] [--from 2026-01-26 --to 2026-10-09] [--agg any] [--maLen 20] [--out data/th_fit.json]
//
// The share is the dial. The board ran at the 5-minute chart's share at th 0.015 (about 0.55 to 0.59
// depending on the sample) until October 2026; the accuracy study (CLAUDE.md §7) found a pooled share of
// 0.45 keeps the climatology's skill while making a lit cell mean more, so that is the default. Start the
// range after the 14-day ATR exists (the files begin 1 Jan 2026; the first ATR is 22 Jan), or the dead
// January days deflate every share. Prints the three thresholds and, per instrument, the share each
// chart gives at its fitted value, so a drift between instruments is visible.
//
// --maLen picks the simple moving average whose 15-minute move is measured. 20 is the board's and the
// only one that predicts trends: the owner's 8 is a power-trend average and the 200 a bias (22 Oct
// 2026), and there is never an EMA (the fits of 13 Oct 2026 were on a 20EMA). Another length is for
// research only. The result is merged into data/th_fit.json under "sma<maLen>" so the tools that
// build on it (build_board.js, close_study.js) read the figures that were printed.
const fs = require('fs'), path = require('path');
const E = require('./eval_lib.js');
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i+1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
const share = +(args.share || 0.45), from = args.from || '2026-01-26', to = args.to || '2026-10-09';
const def = { agg: args.agg || 'any', maLen: +(args.maLen || 20) };
const OUT = args.out || path.join(__dirname, '..', 'data', 'th_fit.json');
const syms = E.INSTRUMENTS.map(x => x[1]).filter(s => s !== 'usa30');
const out = {};
for (const ch of [15, 5, 2]){
  const Ps = syms.map(s => E.load(s, ch, from, to)).filter(Boolean);
  const th = E.fitTh(Ps, def, share);
  const per = Ps.map(P => { const O = E.outcomes(P, Object.assign({}, def, { th })); return [P.sym, E.meanShare(O), O.days.length]; });
  const shares = per.map(x => x[1]);
  out[ch] = +th.toPrecision(3);
  console.log(`${ch}-minute SMA${def.maLen}: th ${th.toFixed(5)} -> ${out[ch]} for pooled share ${share} over ${Ps.length} instruments, ${per[0][2]}-${Math.max(...per.map(x => x[2]))} days; per-instrument share ${Math.min(...shares).toFixed(3)}–${Math.max(...shares).toFixed(3)}`);
  console.log('   ' + per.map(x => `${x[0]} ${x[1].toFixed(2)}`).join('  '));
}
const key = 'sma' + def.maLen;
let all = {}; try { all = JSON.parse(fs.readFileSync(OUT, 'utf8')); } catch (e) { /* first fit */ }
all[key] = { th: out, share, from, to, agg: def.agg, ma: 'sma', maLen: def.maLen, instruments: syms.length, fitted: new Date().toISOString().slice(0, 10) };
fs.writeFileSync(OUT, JSON.stringify(all, null, 1) + '\n');
console.log(`\nwrote ${path.relative(path.join(__dirname, '..'), OUT)} [${key}]: th15 ${out[15]} th5 ${out[5]} th2 ${out[2]}` + (def.maLen === 20 ? ' — build_board.js reads these by default' : ''));
