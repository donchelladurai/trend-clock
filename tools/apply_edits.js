#!/usr/bin/env node
// Apply exact-string replacements from a JSON file of [{old, new}], each of which must occur
// exactly once, to index.html (default) or to the file named second:
//   node tools/apply_edits.js edits.json [CLAUDE.md]
// Shell quoting mangles the template literals and the ×/— characters in these files, so prose
// edits go through here rather than through inline shell commands.
const fs = require('fs'), path = require('path');
const file = process.argv[3] ? path.resolve(process.argv[3]) : path.join(__dirname, '..', 'index.html');
let h = fs.readFileSync(file, 'utf8');
const edits = JSON.parse(fs.readFileSync(process.argv[2], 'utf8'));
let bad = 0;
for (const { old, new: nu } of edits){ const n = h.split(old).length - 1; if (n !== 1){ console.error(`occurs ${n} times, not 1: ${old.slice(0, 90)}…`); bad++; } }
if (bad){ console.error(`${bad} edit(s) did not match; nothing written`); process.exit(1); }
for (const { old, new: nu } of edits) h = h.replace(old, () => nu);
fs.writeFileSync(file, h);
console.log(`applied ${edits.length} edits`);
