#!/usr/bin/env node
// Load index.html's statistics layer in node and print every figure the footer and the code
// comments cite (CLAUDE.md §5 step 3). Run after any data refresh: node tools/board_stats.js
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const js = html.split('<script>')[1].split('</script>')[0];
const stub = 'const document={getElementById:()=>({textContent:"",innerHTML:"",addEventListener(){},style:{},value:"75",classList:{toggle(){},add(){},remove(){}},querySelector:()=>({textContent:""}),querySelectorAll:()=>[],appendChild(){},getBoundingClientRect:()=>({left:0,width:900})}),createElement:()=>({style:{},classList:{add(){},toggle(){}},dataset:{},appendChild(){},querySelector:()=>({appendChild(){},querySelectorAll:()=>[]}),querySelectorAll:()=>[],firstChild:{style:{}}}),querySelectorAll:()=>[],addEventListener(){}};const window={addEventListener(){}};const setInterval=()=>0;';
const M = new Function(stub + js.replace(/^build\(\); tick\(\); setInterval\(tick, 1000\);$/m, '') + '\nreturn {ROWS,TURN,TURNC,MODES,SLOTS,COMPOSITE,FDR,MID_FDR,MIN_LAM,MIN_N,OMNIBUS,AGG_CUT,poisUpper,bhCutoff,byar,wilson,ciHalfPP};')();
const { ROWS, TURN, TURNC, MODES, SLOTS, COMPOSITE, FDR, MID_FDR, MIN_LAM, AGG_CUT, bhCutoff, byar, ciHalfPP, poisUpper } = M;
const open = r => { const o = []; for (let k = 0; k < SLOTS; k++) if (!r.closed[k]) o.push(k); return o; };
const f = (x, d = 2) => Number(x).toFixed(d);
const isComp = i => COMPOSITE[i] > 0, isWheat = i => ROWS[i].label === 'Chicago Wheat';
const long = i => ROWS[i].days.all > 400;            // rows sampled over more than the 12-month window
const single = i => !isComp(i) && !isWheat(i) && !long(i);

console.log('=== rows');
console.log('i  label            comp days  phi   omni    flat  marked needs  lam.all lam.wd(min–max)  red/capped by profile [Mon Tue Wed Thu Fri all]');
ROWS.forEach((r, i) => { const t = TURN[i]; const wl = MODES.slice(0, 5).map(m => t[m].lam);
  const tiers = MODES.map(m => { const o = open(r); return o.filter(k => t[m].tier[k] === 2).length + '/' + o.filter(k => t[m].tier[k] === 1).length; });
  console.log(`${String(i).padStart(2)} ${r.label.padEnd(16)} ${String(COMPOSITE[i] || '').padEnd(4)} ${String(r.days.all).padStart(4)}  ${f(t.phi)}  ${f(t.all.omni, 3)}  ${String(t.flat).padEnd(5)} ${String(t.marked).padEnd(6)} ${f(t.needs, 1)}   ${f(t.all.lam, 1).padStart(6)}  ${f(Math.min(...wl), 1)}–${f(Math.max(...wl), 1)}`.padEnd(100) + tiers.join(' ')); });

// tier totals
let red = 0, cap = 0, redWd = 0, capWd = 0, red25 = 0, cap25 = 0, redWd25 = 0, capWd25 = 0, families = 0, expFalse = 0, closedTier = 0, weakTier = 0, t2notIn1 = 0, chipAll = 0, chipAny = 0;
ROWS.forEach((r, i) => { const t = TURN[i], o = open(r); let anyAll = false, anyAny = false;
  for (const m of MODES){ const tm = t[m]; const r2 = o.filter(k => tm.tier[k] === 2).length, r1 = o.filter(k => tm.tier[k] === 1).length;
    red += r2; cap += r1; if (m !== 'all'){ redWd += r2; capWd += r1; } if (!long(i)){ red25 += r2; cap25 += r1; if (m !== 'all'){ redWd25 += r2; capWd25 += r1; } }
    if (r2 + r1) anyAny = true; if (m === 'all' && r2 + r1) anyAll = true;
    for (let k = 0; k < SLOTS; k++){ if (r.closed[k] && tm.tier[k]) closedTier++; if (tm.weak && tm.tier[k]) weakTier++; }
    if (r2){ families++; const cut = bhCutoff(o.map(k => tm.p[k]), FDR); expFalse += o.length * cut; }
    // every tier-2 window must also pass the MID_FDR cut
    if (!tm.weak){ const mid = bhCutoff(o.map(k => tm.p[k]), MID_FDR); for (const k of o) if (tm.tier[k] === 2 && tm.p[k] > mid) t2notIn1++; } }
  if (anyAll) chipAll++; if (anyAny) chipAny++; });
console.log('\n=== tiers');
console.log(`red (tier 2) ${red} = ${redWd} weekday + ${red - redWd} all-days; capped (tier 1) ${cap} = ${capWd} weekday + ${cap - capWd} all-days`);
console.log(`same on the 12-month rows only: red ${red25} (${redWd25} weekday, ${red25 - redWd25} all-days); capped ${cap25} (${capWd25} weekday, ${cap25 - capWd25} all-days)`);
console.log(`rows marked ${ROWS.filter((r, i) => TURN[i].marked).length} of ${ROWS.length}; blank: ${ROWS.filter((r, i) => !TURN[i].marked).map(r => r.label).join(', ') || 'none'}`);
console.log(`rows that can reach the chips: ${chipAll} of ${ROWS.length} on the all-days profile, ${chipAny} on some profile`);
console.log(`FDR bound: sum(m*cut) over ${families} firing families = ${f(expFalse, 1)} expected false of ${red} red = ${f(100 * expFalse / red, 1)}%`);
console.log(`weekday flag rate per window vs all-days: ${f((redWd / 5) / (red - redWd), 3)}x (i.e. about ${f((red - redWd) / (redWd / 5), 1)}x lower)`);
console.log(`checks: tiers on closed ${closedTier}, tiers on weak ${weakTier}, tier-2 not within tier-1 cut ${t2notIn1}`);
console.log(`flat rows (omnibus > ${M.OMNIBUS}): ` + ROWS.map((r, i) => [r, i]).filter(([r, i]) => TURN[i].flat).map(([r, i]) => `${r.label} ${f(TURN[i].all.omni, 2)}`).join(', '));
console.log(`weak (hatched) profiles: ` + ROWS.map((r, i) => MODES.filter(m => TURN[i][m].weak).map(m => `${r.label}/${m}`)).flat().join(', '));

// CI spanning 1.0x
let spanAll = 0, nAll = 0, spanWd = 0, nWd = 0;
ROWS.forEach((r, i) => { const t = TURN[i]; for (const m of MODES){ const tm = t[m]; if (tm.weak) continue; for (const k of open(r)){ const [lo, hi] = byar(tm.c[k] / tm.phi, 1.96).map(x => x * tm.phi / tm.lam); const sp = lo <= 1 && 1 <= hi; if (m === 'all'){ nAll++; if (sp) spanAll++; } else { nWd++; if (sp) spanWd++; } } } });
console.log(`\n=== Byar interval spans 1.0x: all-days ${f(100 * spanAll / nAll, 1)}% of ${nAll}, weekday ${f(100 * spanWd / nWd, 1)}% of ${nWd}`);
// verdict vs CI: printed CI excludes 1 while text says "within ordinary variation" (text says that only when rlo <= 1)
let contra = 0; ROWS.forEach((r, i) => { for (const m of MODES){ const tm = TURN[i][m]; if (tm.weak) continue; for (const k of open(r)){ const [lo, hi] = byar(tm.c[k] / tm.phi, 1.96).map(x => x * tm.phi / tm.lam); if (!tm.tier[k] && lo.toFixed(2) > 1 && !(lo > 1)) contra++; } } });
console.log(`CI-vs-verdict contradictions: ${contra}`);

// lambda ranges by class
const rng = (idx, ms) => { const v = []; for (const i of idx) for (const m of ms) v.push(TURN[i][m].lam); return v.length ? `${f(Math.min(...v), 1)}–${f(Math.max(...v), 1)}` : '-'; };
const idxS = ROWS.map((r, i) => i).filter(single), idxC = ROWS.map((r, i) => i).filter(isComp), idxW = ROWS.map((r, i) => i).filter(isWheat), idxL = ROWS.map((r, i) => i).filter(long);
console.log(`\n=== turns per window (lambda): singles weekday ${rng(idxS, MODES.slice(0, 5))}, all-days ${rng(idxS, ['all'])}; composites ${rng(idxC, MODES.slice(0, 5))} / ${rng(idxC, ['all'])}; wheat ${rng(idxW, MODES.slice(0, 5))} / ${rng(idxW, ['all'])}; long rows (${idxL.map(i => ROWS[i].label).join(', ')}) ${rng(idxL, MODES.slice(0, 5))} / ${rng(idxL, ['all'])}`);

// Wilson half-widths
const meanHW = (idx, ms) => { let s = 0, n = 0; for (const i of idx) for (const m of ms) for (const k of open(ROWS[i])){ s += ciHalfPP(ROWS[i].data[m].s[k], ROWS[i].days[m]); n++; } return f(s / n, 1); };
const idx12 = ROWS.map((r, i) => i).filter(i => !long(i) && !isWheat(i));
console.log(`=== Wilson half-width (pp): 12-month rows weekday ±${meanHW(idx12, MODES.slice(0, 5))}, all-days ±${meanHW(idx12, ['all'])}; long rows weekday ±${meanHW(idxL, MODES.slice(0, 5))}, all-days ±${meanHW(idxL, ['all'])}`);

// lag-1 autocorrelation, pooled over rows: all-days pattern, and the day-specific part t_wd - t_all
function lag1(pairs){ const n = pairs.length; let mx = 0, my = 0; for (const [x, y] of pairs){ mx += x; my += y; } mx /= n; my /= n; let sxy = 0, sxx = 0, syy = 0; for (const [x, y] of pairs){ sxy += (x - mx) * (y - my); sxx += (x - mx) ** 2; syy += (y - my) ** 2; } return sxy / Math.sqrt(sxx * syy); }
const pa = [], pd = [], pa25 = [], pd25 = [];
ROWS.forEach((r, i) => { const o = open(r); for (let j = 1; j < o.length; j++){ const a = r.data.all.t; pa.push([a[o[j - 1]], a[o[j]]]); if (!long(i)) pa25.push([a[o[j - 1]], a[o[j]]]);
  for (const m of MODES.slice(0, 5)){ const d = k => r.data[m].t[k] - a[k]; pd.push([d(o[j - 1]), d(o[j])]); if (!long(i)) pd25.push([d(o[j - 1]), d(o[j])]); } } });
console.log(`=== lag-1 autocorrelation: all-days pattern ${f(lag1(pa))} (12-month rows ${f(lag1(pa25))}); day-specific part ${f(lag1(pd))} (12-month rows ${f(lag1(pd25))})`);

// composite cuts
console.log(`=== AGG_CUT: ` + ROWS.map((r, i) => isComp(i) ? `${r.label} ${Math.round(100 * AGG_CUT[i])}% lighting ${open(r).filter(k => TURN[i].all.pTurn[k] >= AGG_CUT[i]).length} all-days, ${MODES.reduce((a, m) => a + open(r).filter(k => TURN[i][m].pTurn[k] >= AGG_CUT[i]).length, 0)} across profiles` : null).filter(Boolean).join('; '));
// misc
console.log(`=== tooltips at default profile: ${ROWS.reduce((a, r) => a + open(r).length, 0)}; printed % max ${f(100 * Math.max(...ROWS.map((r, i) => Math.max(...MODES.map(m => Math.max(...TURN[i][m].pTurn))))), 1)}%`);
ROWS.forEach((r, i) => { if (!long(i)) return; const t = TURN[i]; console.log(`=== ${r.label}: days ${r.days.all} (${MODES.slice(0, 5).map(m => r.days[m]).join('/')}), phi ${f(t.phi)}, omnibus ${f(t.all.omni, 4)}, needs ${f(t.needs, 2)}x, red/capped per profile ${MODES.map(m => open(r).filter(k => t[m].tier[k] === 2).length + '/' + open(r).filter(k => t[m].tier[k] === 1).length).join(' ')}, pTurn all-days ${Math.round(100 * Math.min(...t.all.pTurn))}–${Math.round(100 * Math.max(...t.all.pTurn))}%, max count/lam ${Math.max(...t.all.c)}/${f(t.all.lam, 1)}, smallest p<=0.05 count ${(() => { let c = Math.ceil(t.all.lam); while (poisUpper(c, t.all.lam, t.phi) > 0.05) c++; return c; })()}`); });
