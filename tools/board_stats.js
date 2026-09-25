#!/usr/bin/env node
// Load index.html's statistics layer in node and print every figure the code comments and
// CLAUDE.md cite (CLAUDE.md §5 step 3). Run after any data refresh: node tools/board_stats.js
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const js = html.split('<script>')[1].split('</script>')[0];
const stub = 'const document={getElementById:()=>({textContent:"",innerHTML:"",addEventListener(){},style:{},value:"75",classList:{toggle(){},add(){},remove(){}},querySelector:()=>({textContent:""}),querySelectorAll:()=>[],appendChild(){},getBoundingClientRect:()=>({left:0,width:900})}),createElement:()=>({style:{},classList:{add(){},toggle(){}},dataset:{},appendChild(){},querySelector:()=>({appendChild(){},querySelectorAll:()=>[]}),querySelectorAll:()=>[],firstChild:{style:{}}}),querySelectorAll:()=>[],addEventListener(){}};const window={addEventListener(){}};const setInterval=()=>0;';
const M = new Function(stub + js.replace(/^build\(\); tick\(\); setInterval\(tick, 1000\);$/m, '') + '\nreturn {ROWS,TURN,TURNC,GROUPS,MODES,SLOTS,COMPOSITE,FDR,MID_FDR,MIN_LAM,MIN_N,OMNIBUS,AGG_CUT,AGG_Q,poisUpper,bhCutoff,byar,wilson,ciHalfPP};')();
const { ROWS, TURN, TURNC, GROUPS, MODES, SLOTS, COMPOSITE, FDR, MID_FDR, MIN_LAM, MIN_N, AGG_CUT, bhCutoff, byar, ciHalfPP, poisUpper } = M;
const open = r => { const o = []; for (let k = 0; k < SLOTS; k++) if (!r.closed[k]) o.push(k); return o; };
const f = (x, d = 2) => Number(x).toFixed(d);
const mins = i => { const g = GROUPS.find(g => g[0] === ROWS[i].group); return g ? g[2] : 0; };
const isComp = i => COMPOSITE[i] > 0, single = i => !isComp(i);
const idx = pred => ROWS.map((r, i) => i).filter(pred);
const S2 = idx(i => single(i) && mins(i) === 2), S5 = idx(i => single(i) && mins(i) === 5), C = idx(isComp);
const WD = MODES.slice(0, 5);
console.log(`board: ${ROWS.length} rows = ${C.length} composites + ${S2.length} single instruments on the 2-minute chart + ${S5.length} on the 5-minute chart; MIN_N ${MIN_N}, MIN_LAM ${MIN_LAM}, FDR ${FDR}, MID_FDR ${MID_FDR}`);
console.log(`days: all-days ${Math.min(...ROWS.map(r => r.days.all))}–${Math.max(...ROWS.map(r => r.days.all))}, weekday ${Math.min(...ROWS.flatMap(r => WD.map(m => r.days[m])))}–${Math.max(...ROWS.flatMap(r => WD.map(m => r.days[m])))}; open windows ${Math.min(...ROWS.map(r => open(r).length))}–${Math.max(...ROWS.map(r => open(r).length))}`);

console.log('\n=== rows');
console.log('i  label            chart comp days  phi   omni    flat  marked needs  lam.all lam.wd(min–max)  red/capped by profile [Mon Tue Wed Thu Fri all]  maxc/days');
ROWS.forEach((r, i) => { const t = TURN[i]; const wl = WD.map(m => t[m].lam);
  const tiers = MODES.map(m => { const o = open(r); return o.filter(k => t[m].tier[k] === 2).length + '/' + o.filter(k => t[m].tier[k] === 1).length; });
  console.log(`${String(i).padStart(2)} ${r.label.padEnd(16)} ${String(mins(i) + 'm').padEnd(5)} ${String(COMPOSITE[i] || '').padEnd(4)} ${String(r.days.all).padStart(4)}  ${f(t.phi)}  ${f(t.all.omni, 3)}  ${String(t.flat).padEnd(5)} ${String(t.marked).padEnd(6)} ${f(t.needs, 1)}   ${f(t.all.lam, 1).padStart(6)}  ${f(Math.min(...wl), 1)}–${f(Math.max(...wl), 1)}`.padEnd(104) + tiers.join(' ').padEnd(36) + f(Math.max(...t.all.c) / r.days.all)); });

// tier totals
let red = 0, cap = 0, redWd = 0, capWd = 0, families = 0, expFalse = 0, closedTier = 0, weakTier = 0, t2notIn1 = 0, chipAll = 0, chipAny = 0;
const byClass = { comp: [0, 0, 0, 0], two: [0, 0, 0, 0], five: [0, 0, 0, 0] };   // red wd, red all, cap wd, cap all
ROWS.forEach((r, i) => { const t = TURN[i], o = open(r); let anyAll = false, anyAny = false; const cls = isComp(i) ? 'comp' : mins(i) === 2 ? 'two' : 'five';
  for (const m of MODES){ const tm = t[m]; const r2 = o.filter(k => tm.tier[k] === 2).length, r1 = o.filter(k => tm.tier[k] === 1).length;
    red += r2; cap += r1; if (m !== 'all'){ redWd += r2; capWd += r1; byClass[cls][0] += r2; byClass[cls][2] += r1; } else { byClass[cls][1] += r2; byClass[cls][3] += r1; }
    if (r2 + r1) anyAny = true; if (m === 'all' && r2 + r1) anyAll = true;
    for (let k = 0; k < SLOTS; k++){ if (r.closed[k] && tm.tier[k]) closedTier++; if (tm.weak && tm.tier[k]) weakTier++; }
    if (r2){ families++; const cut = bhCutoff(o.map(k => tm.p[k]), FDR); expFalse += o.length * cut; }
    if (!tm.weak){ const mid = bhCutoff(o.map(k => tm.p[k]), MID_FDR); for (const k of o) if (tm.tier[k] === 2 && tm.p[k] > mid) t2notIn1++; } }
  if (anyAll) chipAll++; if (anyAny) chipAny++; });
console.log('\n=== tiers');
console.log(`red (tier 2) ${red} = ${redWd} weekday + ${red - redWd} all-days; capped (tier 1) ${cap} = ${capWd} weekday + ${cap - capWd} all-days`);
for (const [k, n] of [['comp', 'composites'], ['two', '2-minute singles'], ['five', '5-minute singles']]) console.log(`  ${n.padEnd(17)} red ${byClass[k][0]} weekday + ${byClass[k][1]} all-days; capped ${byClass[k][2]} weekday + ${byClass[k][3]} all-days`);
console.log(`rows marked ${ROWS.filter((r, i) => TURN[i].marked).length} of ${ROWS.length}; blank: ${ROWS.filter((r, i) => !TURN[i].marked).map(r => r.label).join(', ') || 'none'}`);
console.log(`rows that can reach the chips: ${chipAll} of ${ROWS.length} on the all-days profile, ${chipAny} on some profile`);
console.log(`FDR bound: sum(m*cut) over ${families} firing families = ${f(expFalse, 1)} expected false of ${red} red = ${f(100 * expFalse / red, 1)}%`);
console.log(`weekday flag rate per window vs all-days: ${f((redWd / 5) / (red - redWd), 3)}x (i.e. about ${f((red - redWd) / (redWd / 5), 1)}x lower)`);
console.log(`checks: tiers on closed ${closedTier}, tiers on weak ${weakTier}, tier-2 not within tier-1 cut ${t2notIn1}`);
console.log(`flat rows (omnibus > ${M.OMNIBUS}): ` + (ROWS.map((r, i) => [r, i]).filter(([r, i]) => TURN[i].flat).map(([r, i]) => `${r.label} ${f(TURN[i].all.omni, 2)}`).join(', ') || 'none'));
console.log(`omnibus by row: ` + ROWS.map((r, i) => `${r.label} ${f(TURN[i].all.omni, 3)}`).join(', '));
const weak = ROWS.map((r, i) => MODES.filter(m => TURN[i][m].weak).map(m => `${r.label}/${m}`)).flat();
console.log(`weak (hatched) profiles: ${weak.length ? weak.join(', ') : 'none'}`);
console.log(`thin heat profiles (days < MIN_N): ` + (ROWS.flatMap(r => MODES.filter(m => r.days[m] < MIN_N).map(m => `${r.label}/${m} (${r.days[m]})`)).join(', ') || 'none'));
console.log(`phi: singles ${f(Math.min(...idx(single).map(i => TURN[i].phi)))}–${f(Math.max(...idx(single).map(i => TURN[i].phi)))} (${idx(single).filter(i => TURN[i].phi === 1).length} of ${idx(single).length} at 1.00); composites ` + C.map(i => `${ROWS[i].label} ${f(TURN[i].phi)}`).join(', '));

// CI spanning 1.0x
let spanAll = 0, nAll = 0, spanWd = 0, nWd = 0;
ROWS.forEach((r, i) => { const t = TURN[i]; for (const m of MODES){ const tm = t[m]; if (tm.weak) continue; for (const k of open(r)){ const [lo, hi] = byar(tm.c[k] / tm.phi, 1.96).map(x => x * tm.phi / tm.lam); const sp = lo <= 1 && 1 <= hi; if (m === 'all'){ nAll++; if (sp) spanAll++; } else { nWd++; if (sp) spanWd++; } } } });
console.log(`\n=== Byar interval spans 1.0x: all-days ${f(100 * spanAll / nAll, 1)}% of ${nAll}, weekday ${f(100 * spanWd / nWd, 1)}% of ${nWd}`);
let contra = 0; ROWS.forEach((r, i) => { for (const m of MODES){ const tm = TURN[i][m]; if (tm.weak) continue; for (const k of open(r)){ const [lo, hi] = byar(tm.c[k] / tm.phi, 1.96).map(x => x * tm.phi / tm.lam); if (!tm.tier[k] && lo.toFixed(2) > 1 && !(lo > 1)) contra++; } } });
console.log(`CI-vs-verdict contradictions: ${contra}`);

// lambda ranges by class
const rng = (ix, ms) => { const v = []; for (const i of ix) for (const m of ms) v.push(TURN[i][m].lam); return v.length ? `${f(Math.min(...v), 1)}–${f(Math.max(...v), 1)}` : '-'; };
console.log(`\n=== turns per window (lambda): 2-minute singles weekday ${rng(S2, WD)}, all-days ${rng(S2, ['all'])}; 5-minute singles ${rng(S5, WD)} / ${rng(S5, ['all'])}; composites ${rng(C, WD)} / ${rng(C, ['all'])}`);
const tpd = ix => { const v = ix.map(i => TURNC[i][5] / ROWS[i].days.all); return `${f(Math.min(...v), 1)}–${f(Math.max(...v), 1)}`; };
console.log(`=== turns per day: 2-minute singles ${tpd(S2)}, 5-minute singles ${tpd(S5)}, composites ${tpd(C)}`);
// smallest count clearing p <= 0.05 at each row's all-days lambda, as a ratio (TURN.needs), range by class
const nd = ix => `${f(Math.min(...ix.map(i => TURN[i].needs)), 1)}–${f(Math.max(...ix.map(i => TURN[i].needs)), 1)}x`;
console.log(`=== needs (ratio that first clears p = 0.05 on all-days): 2-minute singles ${nd(S2)}, 5-minute singles ${nd(S5)}, composites ${nd(C)}`);

// Wilson half-widths
const meanHW = (ix, ms) => { let s = 0, n = 0; for (const i of ix) for (const m of ms) for (const k of open(ROWS[i])){ s += ciHalfPP(ROWS[i].data[m].s[k], ROWS[i].days[m]); n++; } return f(s / n, 1); };
console.log(`=== Wilson half-width (pp): singles weekday ±${meanHW([...S2, ...S5], WD)}, all-days ±${meanHW([...S2, ...S5], ['all'])}`);
// mean trending share by class, and cells at or above the 75% default
const sh = ix => { let s = 0, n = 0, hi = 0; for (const i of ix) for (const k of open(ROWS[i])){ const v = ROWS[i].data.all.s[k]; s += v; n++; if (v >= .75) hi++; } return `mean ${f(s / n)}, ${hi} of ${n} cells >= 75%`; };
console.log(`=== all-days trending share: 2-minute singles ${sh(S2)}; 5-minute singles ${sh(S5)}; composites ${sh(C)}`);

// lag-1 autocorrelation, pooled over rows: all-days pattern, and the day-specific part t_wd - t_all
function lag1(pairs){ const n = pairs.length; let mx = 0, my = 0; for (const [x, y] of pairs){ mx += x; my += y; } mx /= n; my /= n; let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of pairs){ sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; } return sxy / Math.sqrt(sxx * syy); }
const pa = [], pd = [];
ROWS.forEach((r, i) => { const o = open(r); for (let j = 1; j < o.length; j++){ const a = r.data.all.t; pa.push([a[o[j - 1]], a[o[j]]]);
  for (const m of WD){ const d = k => r.data[m].t[k] - a[k]; pd.push([d(o[j - 1]), d(o[j])]); } } });
console.log(`=== lag-1 autocorrelation: all-days pattern ${f(lag1(pa))}; day-specific part ${f(lag1(pd))}`);

// composite cuts and rates
console.log(`=== AGG_CUT (q = ${M.AGG_Q}): ` + C.map(i => { const r = ROWS[i]; const p = open(r).map(k => TURN[i].all.pTurn[k]); return `${r.label} ${Math.round(100 * AGG_CUT[i])}% (row spread ${Math.round(100 * Math.min(...p))}–${Math.round(100 * Math.max(...p))}%) lighting ${open(r).filter(k => TURN[i].all.pTurn[k] >= AGG_CUT[i]).length} all-days, ${MODES.reduce((a, m) => a + open(r).filter(k => TURN[i][m].pTurn[k] >= AGG_CUT[i]).length, 0)} across profiles; mu range across profiles ${f(Math.min(...MODES.map(m => Math.min(...open(r).map(k => TURN[i][m].c[k] / r.days[m])))), 3)}–${f(Math.max(...MODES.map(m => Math.max(...open(r).map(k => TURN[i][m].c[k] / r.days[m])))), 3)}`; }).join('; '));
console.log(`=== composite max count/days (a rate, not a probability): ` + C.map(i => `${ROWS[i].label} ${f(Math.max(...TURN[i].all.c) / ROWS[i].days.all)}`).join(', '));
// count recovery: every row's lambda is below 100 on this board?
console.log(`=== max lambda on the board ${f(Math.max(...ROWS.map((r, i) => TURN[i].all.lam)), 1)} (count recovery is exact below 100)`);
// misc
console.log(`=== tooltips at default profile: ${ROWS.reduce((a, r) => a + open(r).length, 0)}; printed % max ${f(100 * Math.max(...ROWS.map((r, i) => Math.max(...MODES.map(m => Math.max(...TURN[i][m].pTurn))))), 1)}%`);
// examples the comments name: rows that fail the omnibus yet own a red window, rows that pass yet own none
console.log(`=== flat-yet-marked: ` + (ROWS.map((r, i) => TURN[i].flat && TURN[i].marked ? `${r.label} (omni ${f(TURN[i].all.omni, 2)}, ${open(r).filter(k => TURN[i].all.tier[k] === 2).length} red all-days)` : null).filter(Boolean).join(', ') || 'none'));
console.log(`=== non-flat-yet-few: ` + ROWS.map((r, i) => !TURN[i].flat && open(r).filter(k => TURN[i].all.tier[k] === 2).length <= 1 ? `${r.label} (omni ${f(TURN[i].all.omni, 4)}, ${open(r).filter(k => TURN[i].all.tier[k] === 2).length} red, ${open(r).filter(k => TURN[i].all.tier[k] === 1).length} capped all-days)` : null).filter(Boolean).join(', '));
