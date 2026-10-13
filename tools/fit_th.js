#!/usr/bin/env node
// Fit one trend threshold per chart so that "trending" carries the same intensity on the 15-, 5- and
// 2-minute charts: the threshold at which each chart calls the same pooled share of windows trending,
// over the 20 histdata instruments and every valid day in the range.
//
//   node tools/fit_th.js [--share 0.45] [--from 2026-01-26 --to 2026-10-09] [--agg any]
//
// The share is the dial. The board ran at the 5-minute chart's share at th 0.015 (about 0.55 to 0.59
// depending on the sample) until October 2026; the accuracy study (CLAUDE.md §7) found a pooled share of
// 0.45 keeps the climatology's skill while making a lit cell mean more, so that is the default. Start the
// range after the 14-day ATR exists (the files begin 1 Jan 2026; the first ATR is 22 Jan), or the dead
// January days deflate every share. Prints the three thresholds and, per instrument, the share each
// chart gives at its fitted value, so a drift between instruments is visible.
const E = require('./eval_lib.js');
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i+1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
const share = +(args.share || 0.45), from = args.from || '2026-01-26', to = args.to || '2026-10-09', def = { agg: args.agg || 'any' };
const syms = E.INSTRUMENTS.map(x => x[1]).filter(s => s !== 'usa30');
const out = {};
for (const ch of [15, 5, 2]){
  const Ps = syms.map(s => E.load(s, ch, from, to)).filter(Boolean);
  const th = E.fitTh(Ps, def, share);
  const per = Ps.map(P => { const O = E.outcomes(P, Object.assign({}, def, { th })); return [P.sym, E.meanShare(O), O.days.length]; });
  const shares = per.map(x => x[1]);
  out[ch] = +th.toPrecision(3);
  console.log(`${ch}-minute: th ${th.toFixed(5)} -> ${out[ch]} for pooled share ${share} over ${Ps.length} instruments, ${per[0][2]}-${Math.max(...per.map(x => x[2]))} days; per-instrument share ${Math.min(...shares).toFixed(3)}–${Math.max(...shares).toFixed(3)}`);
  console.log('   ' + per.map(x => `${x[0]} ${x[1].toFixed(2)}`).join('  '));
}
console.log('\nbuild with: node tools/build_board.js --th15 ' + out[15] + ' --th5 ' + out[5] + ' --th2 ' + out[2]);
