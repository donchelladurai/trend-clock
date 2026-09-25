#!/usr/bin/env node
// Insert or replace one row in index.html's ROWS / TURNC / GROUPS literals.
//   node tools/inject_row.js data/row_audjpy.json
// The row file is what tools/gen_row.js --out writes: { row, turnc, meta }.
// A row whose label already exists is replaced in place. A new row goes after the last row of
// its group; a new group is added to GROUPS before "Commodities" with the FX guide lines and the
// 5-minute chart (GROUPS entries are [name, guideLines, minutesPerBar] — CLAUDE.md §1).
// For a whole-board rebuild use tools/build_board.js; this is for one row at a time.
const fs = require('fs'), path = require('path');
const file = path.join(__dirname, '..', 'index.html');
const { row, turnc } = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let h = fs.readFileSync(file, 'utf8');
const grab = (re) => { const m = h.match(re); if (!m) throw new Error('literal not found: ' + re); return m; };
const mR = grab(/const ROWS = (\[.*?\]);\n/s), mT = grab(/const TURNC = (\[.*\]);/), mG = grab(/const GROUPS = (\[.*\]);/);
const ROWS = JSON.parse(mR[1]), TURNC = JSON.parse(mT[1]), GROUPS = JSON.parse(mG[1]);
if (ROWS.length !== TURNC.length) throw new Error('ROWS/TURNC length mismatch');
if (turnc.length !== 6 || turnc.slice(0, 5).reduce((a, b) => a + b, 0) !== turnc[5]) throw new Error('turnc must be [Mon..Fri, all] with all = sum');
let i = ROWS.findIndex(r => r.label === row.label);
if (i >= 0){ ROWS[i] = row; TURNC[i] = turnc; console.log('replaced', row.label, 'at', i); }
else {
  if (!GROUPS.some(g => g[0] === row.group)){
    const at = GROUPS.findIndex(g => g[0] === 'Commodities'); GROUPS.splice(at < 0 ? GROUPS.length : at, 0, [row.group, [330, 390, 480], 5]);
    console.log('added group', row.group);
  }
  const order = GROUPS.map(g => g[0]), gi = order.indexOf(row.group);
  i = ROWS.length; for (let j = 0; j < ROWS.length; j++) if (order.indexOf(ROWS[j].group) > gi){ i = j; break; }
  ROWS.splice(i, 0, row); TURNC.splice(i, 0, turnc); console.log('inserted', row.label, 'at', i);
}
h = h.replace(mR[0], 'const ROWS = ' + JSON.stringify(ROWS) + ';\n').replace(mT[0], 'const TURNC = ' + JSON.stringify(TURNC) + ';').replace(mG[0], 'const GROUPS = ' + JSON.stringify(GROUPS) + ';');
fs.writeFileSync(file, h);
console.log('rows now', ROWS.length, '| groups', GROUPS.map(g => g[0]).join(' / '));
