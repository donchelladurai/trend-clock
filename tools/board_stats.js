#!/usr/bin/env node
// Load index.html's statistics layer in node and print every figure the code comments and
// CLAUDE.md cite (CLAUDE.md §5 step 3), for each of the three boards. Run after any data refresh:
//   node tools/board_stats.js [--chart 2]
const fs = require('fs'), path = require('path');
const { loadPage } = require('./page_stub.js');
const M = loadPage();
const { B, CHARTS, MODES, SLOTS, FDR, MID_FDR, MIN_LAM, MIN_N, OMNIBUS, AGG_Q, bhCutoff, byar, ciHalfPP, poisUpper } = M;
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ args[a.slice(2)] = process.argv[i+1]; i++; } }
const open = r => { const o = []; for (let k = 0; k < SLOTS; k++) if (!r.closed[k]) o.push(k); return o; };
const f = (x, d = 2) => Number(x).toFixed(d);
const WD = MODES.slice(0, 5);
console.log(`boards: ${CHARTS.map(ch => ch + 'm ' + B[ch].ROWS.length + ' rows ' + B[ch].from + '–' + B[ch].to + ' th ' + B[ch].th).join('; ')}; MIN_N ${MIN_N}, MIN_LAM ${MIN_LAM}, FDR ${FDR}, MID_FDR ${MID_FDR}`);
const T = M.LIVE && M.LIVE.tables;
if (T) for (const ch of CHARTS){ const t = T[ch]; if (!t || !t.turn[0] || !Array.isArray(t.turn[0][0])) continue;
  const f2 = c => c && c.p15 != null ? c.p15.toFixed(2) : '-';
  console.log(`live table ${ch}m, P(turn in 15 min | in trend) by slope ratio [${t.rEdges.join(',')}) x age [${t.ageEdges.join(',')}), price on the trend side: ` + t.turn.map((row, ri) => ri === 0 ? null : row.map(c => f2(c[1])).join('/')).filter(Boolean).join(' | ')
    + `; against it: ` + t.turn.map((row, ri) => ri === 0 ? null : row.map(c => f2(c[0])).join('/')).filter(Boolean).join(' | ')
    + `; P(trend starts in 15 min | flat) by r [${t.r5Edges.join(',')}), slope rising, by age: ` + t.start.map(r => r[1].map(f2).join('/')).join(' | ')
    + `; P(next window trending) by r x next-window tertile: ` + t.next.map(r => r.map(c => c.p != null ? c.p.toFixed(2) : '-').join('/')).join(' | ')
    + (M.LIVE.regime && M.LIVE.regime[ch] ? `; regime (last 4 weeks / window, mean over rows): turns ${(Object.values(M.LIVE.regime[ch]).reduce((a, x) => a + x.turns, 0)/Object.keys(M.LIVE.regime[ch]).length).toFixed(2)}` : '')); }

for (const ch of (args.chart ? [args.chart] : CHARTS)){
  const { ROWS, TURN, TURNC, GROUPS, COMPOSITE, AGG_CUT } = B[ch];
  const isComp = i => COMPOSITE[i] > 0, single = i => !isComp(i);
  const idx = pred => ROWS.map((r, i) => i).filter(pred);
  const S = idx(single), C = idx(isComp);
  console.log(`\n\n######## ${ch}-minute board: ${ROWS.length} rows = ${C.length} composites + ${S.length} single instruments`);
  console.log(`days: all-days ${Math.min(...ROWS.map(r => r.days.all))}–${Math.max(...ROWS.map(r => r.days.all))}, weekday ${Math.min(...ROWS.flatMap(r => WD.map(m => r.days[m])))}–${Math.max(...ROWS.flatMap(r => WD.map(m => r.days[m])))}; open windows ${Math.min(...ROWS.map(r => open(r).length))}–${Math.max(...ROWS.map(r => open(r).length))}`);
  console.log('\n=== rows');
  console.log('i  label            comp days  phi   omni    flat  marked needs  lam.all lam.wd(min–max)  red/capped by profile [Mon Tue Wed Thu Fri all]  maxc/days');
  ROWS.forEach((r, i) => { const t = TURN[i]; const wl = WD.map(m => t[m].lam);
    const tiers = MODES.map(m => { const o = open(r); return o.filter(k => t[m].tier[k] === 2).length + '/' + o.filter(k => t[m].tier[k] === 1).length; });
    console.log(`${String(i).padStart(2)} ${r.label.padEnd(16)} ${String(COMPOSITE[i] || '').padEnd(4)} ${String(r.days.all).padStart(4)}  ${f(t.phi)}  ${f(t.all.omni, 3)}  ${String(t.flat).padEnd(5)} ${String(t.marked).padEnd(6)} ${f(t.needs, 1)}   ${f(t.all.lam, 1).padStart(6)}  ${f(Math.min(...wl), 1)}–${f(Math.max(...wl), 1)}`.padEnd(98) + tiers.join(' ').padEnd(36) + f(Math.max(...t.all.c) / r.days.all)); });
  let red = 0, cap = 0, redWd = 0, capWd = 0, families = 0, expFalse = 0, closedTier = 0, weakTier = 0, t2notIn1 = 0, chipAll = 0, chipAny = 0;
  const byClass = { comp: [0, 0, 0, 0], single: [0, 0, 0, 0] };
  ROWS.forEach((r, i) => { const t = TURN[i], o = open(r); let anyAll = false, anyAny = false; const cls = isComp(i) ? 'comp' : 'single';
    for (const m of MODES){ const tm = t[m]; const r2 = o.filter(k => tm.tier[k] === 2).length, r1 = o.filter(k => tm.tier[k] === 1).length;
      red += r2; cap += r1; if (m !== 'all'){ redWd += r2; capWd += r1; byClass[cls][0] += r2; byClass[cls][2] += r1; } else { byClass[cls][1] += r2; byClass[cls][3] += r1; }
      if (r2 + r1) anyAny = true; if (m === 'all' && r2 + r1) anyAll = true;
      for (let k = 0; k < SLOTS; k++){ if (r.closed[k] && tm.tier[k]) closedTier++; if (tm.weak && tm.tier[k]) weakTier++; }
      if (r2){ families++; const cut = bhCutoff(o.map(k => tm.p[k]), FDR); expFalse += o.length * cut; }
      if (!tm.weak){ const mid = bhCutoff(o.map(k => tm.p[k]), MID_FDR); for (const k of o) if (tm.tier[k] === 2 && tm.p[k] > mid) t2notIn1++; } }
    if (anyAll) chipAll++; if (anyAny) chipAny++; });
  console.log('\n=== tiers');
  console.log(`red (tier 2) ${red} = ${redWd} weekday + ${red - redWd} all-days; capped (tier 1) ${cap} = ${capWd} weekday + ${cap - capWd} all-days`);
  for (const [k, n] of [['comp', 'composites'], ['single', 'singles']]) console.log(`  ${n.padEnd(12)} red ${byClass[k][0]} weekday + ${byClass[k][1]} all-days; capped ${byClass[k][2]} weekday + ${byClass[k][3]} all-days`);
  console.log(`rows marked ${ROWS.filter((r, i) => TURN[i].marked).length} of ${ROWS.length}; blank: ${ROWS.filter((r, i) => !TURN[i].marked).map(r => r.label).join(', ') || 'none'}`);
  console.log(`rows that can reach the chips: ${chipAll} of ${ROWS.length} on the all-days profile, ${chipAny} on some profile`);
  console.log(`FDR bound: sum(m*cut) over ${families} firing families = ${f(expFalse, 1)} expected false of ${red} red = ${red ? f(100 * expFalse / red, 1) : '-'}%`);
  console.log(`weekday flag rate per window vs all-days: ${(red - redWd) ? f((redWd / 5) / (red - redWd), 3) : '-'}x`);
  console.log(`checks: tiers on closed ${closedTier}, tiers on weak ${weakTier}, tier-2 not within tier-1 cut ${t2notIn1}`);
  console.log(`flat rows (omnibus > ${OMNIBUS}): ` + (ROWS.map((r, i) => [r, i]).filter(([r, i]) => TURN[i].flat).map(([r, i]) => `${r.label} ${f(TURN[i].all.omni, 2)}`).join(', ') || 'none'));
  const weak = ROWS.map((r, i) => MODES.filter(m => TURN[i][m].weak).map(m => `${r.label}/${m}`)).flat();
  console.log(`weak (hatched) profiles: ${weak.length ? weak.join(', ') : 'none'}`);
  console.log(`thin heat profiles (days < MIN_N): ` + (ROWS.flatMap(r => MODES.filter(m => r.days[m] < MIN_N).map(m => `${r.label}/${m} (${r.days[m]})`)).join(', ') || 'none'));
  console.log(`phi: singles ${f(Math.min(...S.map(i => TURN[i].phi)))}–${f(Math.max(...S.map(i => TURN[i].phi)))} (${S.filter(i => TURN[i].phi === 1).length} of ${S.length} at 1.00); composites ` + C.map(i => `${ROWS[i].label} ${f(TURN[i].phi)}`).join(', '));
  let spanAll = 0, nAll = 0, spanWd = 0, nWd = 0, contra = 0;
  ROWS.forEach((r, i) => { const t = TURN[i]; for (const m of MODES){ const tm = t[m]; if (tm.weak) continue; for (const k of open(r)){ const [lo, hi] = byar(tm.c[k] / tm.phi, 1.96).map(x => x * tm.phi / tm.lam); const sp = lo <= 1 && 1 <= hi; if (m === 'all'){ nAll++; if (sp) spanAll++; } else { nWd++; if (sp) spanWd++; }
    if (!tm.tier[k] && !(lo > 1) && !(hi < 1) && (+lo.toFixed(2) > 1 || +hi.toFixed(2) < 1)) contra++; } } });
  console.log(`\n=== Byar interval spans 1.0x: all-days ${f(100 * spanAll / nAll, 1)}% of ${nAll}, weekday ${f(100 * spanWd / nWd, 1)}% of ${nWd}; CI-vs-verdict contradictions ${contra}`);
  const rng = (ix, ms) => { const v = []; for (const i of ix) for (const m of ms) v.push(TURN[i][m].lam); return v.length ? `${f(Math.min(...v), 1)}–${f(Math.max(...v), 1)}` : '-'; };
  console.log(`=== turns per window (lambda): singles weekday ${rng(S, WD)}, all-days ${rng(S, ['all'])}; composites ${rng(C, WD)} / ${rng(C, ['all'])}`);
  const tpd = ix => { const v = ix.map(i => TURNC[i][5] / ROWS[i].days.all); return `${f(Math.min(...v), 1)}–${f(Math.max(...v), 1)}`; };
  console.log(`=== turns per day: singles ${tpd(S)}, composites ${tpd(C)}`);
  const nd = ix => `${f(Math.min(...ix.map(i => TURN[i].needs)), 1)}–${f(Math.max(...ix.map(i => TURN[i].needs)), 1)}x`;
  console.log(`=== needs (ratio that first clears p = 0.05 on all-days): singles ${nd(S)}, composites ${nd(C)}`);
  const meanHW = (ix, ms) => { let s = 0, n = 0; for (const i of ix) for (const m of ms) for (const k of open(ROWS[i])){ s += ciHalfPP(ROWS[i].data[m].s[k], ROWS[i].days[m]); n++; } return f(s / n, 1); };
  console.log(`=== Wilson half-width (pp): singles weekday ±${meanHW(S, WD)}, all-days ±${meanHW(S, ['all'])}`);
  const sh = ix => { let s = 0, n = 0, hi = 0; for (const i of ix) for (const k of open(ROWS[i])){ const v = ROWS[i].data.all.s[k]; s += v; n++; if (v >= .75) hi++; } return `mean ${f(s / n)}, ${hi} of ${n} cells >= 75%`; };
  console.log(`=== all-days trending share: singles ${sh(S)}; composites ${sh(C)}`);
  function lag1(pairs){ const n = pairs.length; let mx = 0, my = 0; for (const [x, y] of pairs){ mx += x; my += y; } mx /= n; my /= n; let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of pairs){ sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; } return sxy / Math.sqrt(sxx * syy); }
  const pa = [], pd = [];
  ROWS.forEach((r, i) => { const o = open(r); for (let j = 1; j < o.length; j++){ const a = r.data.all.t; pa.push([a[o[j - 1]], a[o[j]]]); for (const m of WD){ const d = k => r.data[m].t[k] - a[k]; pd.push([d(o[j - 1]), d(o[j])]); } } });
  console.log(`=== lag-1 autocorrelation: all-days pattern ${f(lag1(pa))}; day-specific part ${f(lag1(pd))}`);
  console.log(`=== AGG_CUT (q = ${AGG_Q}): ` + C.map(i => { const r = ROWS[i]; const p = open(r).map(k => TURN[i].all.pTurn[k]); return `${r.label} ${Math.round(100 * AGG_CUT[i])}% (row spread ${Math.round(100 * Math.min(...p))}–${Math.round(100 * Math.max(...p))}%) lighting ${open(r).filter(k => TURN[i].all.pTurn[k] >= AGG_CUT[i]).length} all-days, ${MODES.reduce((a, m) => a + open(r).filter(k => TURN[i][m].pTurn[k] >= AGG_CUT[i]).length, 0)} across profiles`; }).join('; '));
  console.log(`=== composite max count/days (a rate, not a probability): ` + C.map(i => `${ROWS[i].label} ${f(Math.max(...TURN[i].all.c) / ROWS[i].days.all)}`).join(', '));
  console.log(`=== max lambda ${f(Math.max(...ROWS.map((r, i) => TURN[i].all.lam)), 1)} (count recovery is exact below 100); tooltips at the default profile ${ROWS.reduce((a, r) => a + open(r).length, 0)}; printed % max ${f(100 * Math.max(...ROWS.map((r, i) => Math.max(...MODES.map(m => Math.max(...TURN[i][m].pTurn))))), 1)}%`);
  console.log(`=== flat-yet-marked: ` + (ROWS.map((r, i) => TURN[i].flat && TURN[i].marked ? `${r.label} (omni ${f(TURN[i].all.omni, 2)}, ${open(r).filter(k => TURN[i].all.tier[k] === 2).length} red all-days)` : null).filter(Boolean).join(', ') || 'none'));
  console.log(`=== non-flat-yet-few: ` + (ROWS.map((r, i) => !TURN[i].flat && open(r).filter(k => TURN[i].all.tier[k] === 2).length <= 1 ? `${r.label} (omni ${f(TURN[i].all.omni, 4)}, ${open(r).filter(k => TURN[i].all.tier[k] === 2).length} red, ${open(r).filter(k => TURN[i].all.tier[k] === 1).length} capped all-days)` : null).filter(Boolean).join(', ') || 'none'));
  // Count recovery against the generator's record.
  let off = 0, cells = 0; const dir = path.join(__dirname, '..', 'data', 'rows', 'm' + ch);
  if (fs.existsSync(dir)) for (const fn of fs.readdirSync(dir)){ const rec = JSON.parse(fs.readFileSync(path.join(dir, fn), 'utf8')); const i = ROWS.findIndex(r => r.label === rec.row.label); if (i < 0 || !rec.meta.counts) continue;
    for (const m of MODES) for (const k of open(ROWS[i])){ cells++; if (TURN[i][m].c[k] !== rec.meta.counts[m][k]) off++; } }
  console.log(`=== count recovery vs data/rows/m${ch}: ${off} of ${cells} cells differ`);
}
