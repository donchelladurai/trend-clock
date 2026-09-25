#!/usr/bin/env node
// Fit the 2-minute trend threshold to the 5-minute one, on the instruments the board reads on the
// 2-minute chart: the 2-minute 20EMA moves more over 15 minutes than the 5-minute one, so the same
// threshold in daily-ATR units calls far more windows trending (US 500: 81% against 55%). The fit
// finds TH2 such that, over the same instruments and days, the 2-minute chart calls the same
// overall share of windows trending as the 5-minute chart does at TH5 — so "trending" carries one
// intensity on both charts and only the MA being read differs.
//
//   node tools/fit_th.js --from 2026-06-22 --to 2026-09-18 [--th5 0.015]
const fs = require('fs');
const { prepare, score } = require('./gen_row.js');
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ const k = a.slice(2); const v = process.argv[i+1]; if (v === undefined || v.startsWith('--')) args[k] = true; else { args[k] = v; i++; } } }
const from = args.from || '2026-06-22', to = args.to || '2026-09-18', th5 = +(args.th5 || 0.015);
const INS = [['FTSE 100','ukxgbp'],['Germany 40','grxeur'],['France 40','frxeur'],['US Tech 100','nsxusd'],['US 500','spxusd'],['Spot Gold','xauusd'],['Wall Street','usa30']];
const meanS = (P, S) => { const v = P.open.map(k => S.prof.all.s[k]); return v.reduce((a, b) => a + b, 0)/v.length; };
const tpd = (P, S) => S.turnc[5]/P.days.length;
const rows = [];
for (const [label, sym] of INS){
  const f2 = 'data/' + sym + '_m2.json', f5 = 'data/' + sym + '_m5.json';
  if (!fs.existsSync(f2) || !fs.existsSync(f5)){ console.log(label + ': missing bars, skipped'); continue; }
  const P5 = prepare(JSON.parse(fs.readFileSync(f5, 'utf8')), { minutes: 5, from, to });
  const P2 = prepare(JSON.parse(fs.readFileSync(f2, 'utf8')), { minutes: 2, from, to });
  const S5 = score(P5, th5), target = meanS(P5, S5);
  let lo = 0.005, hi = 0.08;
  for (let i = 0; i < 40; i++){ const mid = (lo + hi)/2; if (meanS(P2, score(P2, mid)) > target) lo = mid; else hi = mid; }
  const th2 = (lo + hi)/2, S2 = score(P2, th2);
  rows.push({ label, target, th2, tpd5: tpd(P5, S5), tpd2: tpd(P2, S2), P2, P5 });
  console.log(label.padEnd(12) + ' 5-min@' + th5 + ': mean s ' + target.toFixed(3) + ', ' + tpd(P5, S5).toFixed(1) + ' turns/day | 2-min matches at TH2 = ' + th2.toFixed(4) + ' (' + tpd(P2, S2).toFixed(1) + ' turns/day), days ' + P5.days.length + '/' + P2.days.length);
}
if (!rows.length){ console.error('no instrument had both a 2-minute and a 5-minute bar file: build data/<sym>_m5.json for the 2-minute instruments first (CLAUDE.md 1b)'); process.exit(1); }
// Pooled: one TH2 for the whole chart, matching the pooled mean share.
const pooled5 = rows.reduce((a, r) => a + r.target, 0)/rows.length;
let lo = 0.005, hi = 0.08;
for (let i = 0; i < 40; i++){ const mid = (lo + hi)/2; const m = rows.reduce((a, r) => a + meanS(r.P2, score(r.P2, mid)), 0)/rows.length; if (m > pooled5) lo = mid; else hi = mid; }
const th2 = (lo + hi)/2;
console.log('pooled: 5-min mean s ' + pooled5.toFixed(3) + '; 2-min matches at TH2 = ' + th2.toFixed(4) + ' (ratio to TH5 ' + (th2/th5).toFixed(2) + ')');
for (const c of [0.02, 0.025, 0.03, 0.035]){ const m = rows.reduce((a, r) => a + meanS(r.P2, score(r.P2, c)), 0)/rows.length; const t = rows.reduce((a, r) => a + tpd(r.P2, score(r.P2, c)), 0)/rows.length; console.log('  at TH2 = ' + c + ': pooled mean s ' + m.toFixed(3) + ', ' + t.toFixed(1) + ' turns/day (5-min: ' + (rows.reduce((a, r) => a + r.tpd5, 0)/rows.length).toFixed(1) + ')'); }
