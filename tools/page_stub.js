// Load index.html's script in node with a DOM stub, for the tools that read its statistics layer
// (board_stats.js, loo_harness.js, gen_row.js --compare). The page has no module boundary; the
// stub satisfies the top-level DOM calls, drops the kick-off line, and returns the names below.
const fs = require('fs'), path = require('path');
function loadPage(file){
  const html = fs.readFileSync(file || path.join(__dirname, '..', 'index.html'), 'utf8');
  const js = html.split('<script>')[1].split('</script>')[0];
  const el = () => ({ textContent: '', innerHTML: '', title: '', className: '', dataset: {}, style: { setProperty(){} }, value: '75', disabled: false, addEventListener(){}, classList: { toggle(){}, add(){}, remove(){} }, querySelector: () => el(), querySelectorAll: () => [], appendChild(){}, remove(){}, getBoundingClientRect: () => ({ left: 0, width: 900 }), firstChild: { style: {} }, closest: () => null });
  const stub = 'const document={getElementById:()=>EL(),createElement:()=>EL(),querySelectorAll:()=>[],querySelector:()=>EL(),addEventListener(){}};const window={addEventListener(){}};const setInterval=()=>0;const innerWidth=1000,innerHeight=800;';
  const body = js.replace(/^build\(\); buildDash\(\); tick\(\); setInterval\(tick, 1000\);$/m, '');
  if (body === js) throw new Error('kick-off line not found in index.html');
  return new Function('EL', stub + body + '\nreturn {BOARDS, LIVE, CLOSE, B, CHARTS, LABELS, MODES, SLOTS, FDR, MID_FDR, MIN_LAM, MIN_N, OMNIBUS, AGG_Q, TURN_RISK, START_LIKELY, poisUpper, bhCutoff, byar, wilson, ciHalfPP, gammp, betai, liveState, buildClose, updateClose};')(el);
}
module.exports = { loadPage };
