#!/usr/bin/env node
// Out-of-sample check and null simulation for the board in index.html (CLAUDE.md §7).
//   node tools/loo_harness.js [--reps 200]
//
// Leave-one-weekday-out: for every row and every weekday w, pool the recovered counts of the
// other four weekdays, estimate lambda and phi from that pool alone (reusing TURN[i].phi would
// leak the held-out day), flag windows by BH at FDR (tier 2) and MID_FDR (tier 1), and score each
// flagged window as the held-out weekday's own ratio minus one (t_w[k] - 1). The comparator is a
// single amplitude cutoff on the pooled training ratio, tuned to fire the same number of windows
// as tier 2 board-wide; the baseline hit rate is the share of all windows with t_w > 1.
//
// Null simulation: flat Poisson counts at every row's real weekday lambdas, all-days as their
// sum, through the real dispersion / poisUpper / BH / MIN_LAM pipeline; false marks per board
// replicate, averaged. Mulberry32 PRNG — a naive LCG overflows 2^53 and degenerates.
const fs = require('fs'), path = require('path');
const html = fs.readFileSync(path.join(__dirname, '..', 'index.html'), 'utf8');
const js = html.split('<script>')[1].split('</script>')[0];
const stub = 'const document={getElementById:()=>({textContent:"",innerHTML:"",addEventListener(){},style:{},value:"75",classList:{toggle(){},add(){},remove(){}},querySelector:()=>({textContent:""}),querySelectorAll:()=>[],appendChild(){},getBoundingClientRect:()=>({left:0,width:900})}),createElement:()=>({style:{},classList:{add(){},toggle(){}},dataset:{},appendChild(){},querySelector:()=>({appendChild(){},querySelectorAll:()=>[]}),querySelectorAll:()=>[],firstChild:{style:{}}}),querySelectorAll:()=>[],addEventListener(){}};const window={addEventListener(){}};const setInterval=()=>0;';
const M = new Function(stub + js.replace(/^build\(\); tick\(\); setInterval\(tick, 1000\);$/m, '') + '\nreturn {ROWS,TURN,TURNC,MODES,SLOTS,COMPOSITE,FDR,MID_FDR,MIN_LAM,poisUpper,bhCutoff};')();
const { ROWS, TURN, MODES, SLOTS, FDR, MID_FDR, MIN_LAM, poisUpper, bhCutoff } = M;
const args = {}; for (let i = 2; i < process.argv.length; i++){ const a = process.argv[i]; if (a.startsWith('--')){ args[a.slice(2)] = process.argv[i+1]; i++; } }
const REPS = +(args.reps || 200);
const WD = MODES.slice(0, 5);
const open = r => { const o = []; for (let k = 0; k < SLOTS; k++) if (!r.closed[k]) o.push(k); return o; };
const f = (x, d = 3) => Number(x).toFixed(d);
// Weekday x slot interaction statistic over a set of weekday columns, as dispersion() computes it.
function phiOf(cols, o){ const C = cols.map(c => o.reduce((a, k) => a + c[k], 0)), Ct = C.reduce((a, b) => a + b, 0); let num = 0, used = 0;
  for (const k of o){ const tot = cols.reduce((a, c) => a + c[k], 0); if (tot < 5) continue; for (let j = 0; j < cols.length; j++){ const e = tot*C[j]/Ct; num += (cols[j][k]-e)**2/e; } used++; }
  const df = (cols.length-1)*(used-1); return { phi: used > 1 ? Math.max(1, num/df) : 1, raw: used > 1 ? num/df : 1, df }; }
function tiers(c, o, lam, phi){ const p = {}; for (const k of o) p[k] = poisUpper(c[k], lam, phi); const ps = o.map(k => p[k]);
  const c2 = bhCutoff(ps, FDR), c1 = bhCutoff(ps, MID_FDR); const t = {}; for (const k of o) t[k] = p[k] <= c2 ? 2 : p[k] <= c1 ? 1 : 0; return t; }

// ---- leave-one-weekday-out ------------------------------------------------------------------
const fl = { 2: [], 1: [] }, amp = [], all = []; let skipped = 0, families = 0;
ROWS.forEach((r, i) => { const o = open(r);
  for (const w of WD){ const train = WD.filter(m => m !== w); const cols = train.map(m => TURN[i][m].c);
    const pooled = new Array(SLOTS).fill(0); for (const k of o) for (const c of cols) pooled[k] += c[k];
    const total = o.reduce((a, k) => a + pooled[k], 0), lamT = total/o.length;
    if (lamT < MIN_LAM){ skipped++; continue; } families++;
    const phi = phiOf(cols, o).phi, t = tiers(pooled, o, lamT, phi), held = r.data[w].t;
    for (const k of o){ const s = held[k] - 1; all.push(s); if (t[k] === 2) fl[2].push(s); else if (t[k] === 1) fl[1].push(s); amp.push([pooled[k]/lamT, s]); } } });
const mean = a => a.length ? a.reduce((x, y) => x + y, 0)/a.length : NaN, hit = a => a.length ? a.filter(x => x > 0).length/a.length : NaN;
amp.sort((a, b) => b[0] - a[0]);
const n2 = fl[2].length, ampTop = amp.slice(0, n2).map(x => x[1]), ampCut = n2 ? amp[n2-1][0] : NaN;
const union = fl[2].concat(fl[1]);
console.log('=== leave-one-weekday-out (' + families + ' row x held-out-weekday families scored, ' + skipped + ' skipped for lambda < ' + MIN_LAM + ')');
console.log('tier 2: ' + n2 + ' flags, mean lift ' + f(mean(fl[2])) + ', hit rate ' + f(100*hit(fl[2]), 1) + '%');
console.log('tier 1: ' + fl[1].length + ' flags, mean lift ' + f(mean(fl[1])) + ', hit rate ' + f(100*hit(fl[1]), 1) + '%');
console.log('both:   ' + union.length + ' flags, mean lift ' + f(mean(union)) + ', hit rate ' + f(100*hit(union), 1) + '%');
console.log('amplitude cutoff matched to tier 2\'s budget (pooled ratio >= ' + f(ampCut, 2) + 'x, ' + ampTop.length + ' flags): mean lift ' + f(mean(ampTop)) + ', hit rate ' + f(100*hit(ampTop), 1) + '%');
console.log('random window: mean lift ' + f(mean(all)) + ' (0 by construction), hit rate ' + f(100*hit(all), 1) + '% of ' + all.length);
for (const q of [0.05, 0.10, 0.15, 0.20]){ const s = []; let n = 0;
  ROWS.forEach((r, i) => { const o = open(r); for (const w of WD){ const cols = WD.filter(m => m !== w).map(m => TURN[i][m].c); const pooled = new Array(SLOTS).fill(0); for (const k of o) for (const c of cols) pooled[k] += c[k];
    const lamT = o.reduce((a, k) => a + pooled[k], 0)/o.length; if (lamT < MIN_LAM) continue; const phi = phiOf(cols, o).phi; const ps = o.map(k => poisUpper(pooled[k], lamT, phi)); const cut = bhCutoff(ps, q);
    o.forEach((k, j) => { if (ps[j] <= cut){ s.push(r.data[w].t[k] - 1); } }); } });
  console.log('FDR sweep q = ' + q + ': ' + s.length + ' flags, mean lift ' + f(mean(s)) + ', hit rate ' + f(100*hit(s), 1) + '%'); }

// ---- null simulation ------------------------------------------------------------------------
function rng(seed){ let a = seed >>> 0; return () => { a = (a + 0x6D2B79F5) >>> 0; let t = Math.imul(a ^ (a >>> 15), 1 | a); t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t; return ((t ^ (t >>> 14)) >>> 0)/4294967296; }; }
function pois(lam, u){ if (lam > 30){ let x; do { x = Math.round(lam + Math.sqrt(lam)*Math.sqrt(-2*Math.log(u()))*Math.cos(2*Math.PI*u())); } while (x < 0); return x; } const L = Math.exp(-lam); let k = 0, p = 1; do { k++; p *= u(); } while (p > L); return k-1; }
const u = rng(20260925);
let red = 0, cap = 0, redWd = 0, capWd = 0;
for (let rep = 0; rep < REPS; rep++){
  ROWS.forEach((r, i) => { const o = open(r); const cols = WD.map(m => { const c = new Array(SLOTS).fill(0); const lam = TURN[i][m].lam; for (const k of o) c[k] = pois(lam, u); return c; });
    const allc = new Array(SLOTS).fill(0); for (const k of o) for (const c of cols) allc[k] += c[k];
    const phi = phiOf(cols, o).phi;
    const prof = cols.map((c, j) => [c, TURN[i][WD[j]].lam, true]).concat([[allc, TURN[i].all.lam, false]]);
    for (const [c, lamReal, wd] of prof){ const lam = o.reduce((a, k) => a + c[k], 0)/o.length; if (lam < MIN_LAM) continue; const t = tiers(c, o, lam, phi);
      for (const k of o){ if (t[k] === 2){ red++; if (wd) redWd++; } else if (t[k] === 1){ cap++; if (wd) capWd++; } } } }); }
console.log('\n=== null board (' + REPS + ' replicates, flat Poisson at each profile\'s real lambda, MIN_LAM ' + MIN_LAM + ')');
console.log('false marks per board: red ' + f(red/REPS, 1) + ' (' + f(redWd/REPS, 1) + ' weekday), capped ' + f(cap/REPS, 1) + ' (' + f(capWd/REPS, 1) + ' weekday)');
let realRed = 0, realCap = 0; ROWS.forEach((r, i) => { const o = open(r); for (const m of MODES) for (const k of o){ if (TURN[i][m].tier[k] === 2) realRed++; else if (TURN[i][m].tier[k] === 1) realCap++; } });
console.log('real board: red ' + realRed + ', capped ' + realCap);
