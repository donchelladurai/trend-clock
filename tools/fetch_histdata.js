#!/usr/bin/env node
// Download 1-minute bars from histdata.com: one zip per full year, one per month of the last year.
//   node tools/fetch_histdata.js audjpy 2021 2026 9 data
// → data/hist_audjpy_2021.zip … data/hist_audjpy_2025.zip, data/hist_audjpy_2026_01.zip … _09.zip
// Existing files are skipped, so a re-run only fetches what is new. Requests are paced at 2.5 s.
// Timestamps inside the zips are EST (UTC-5, no DST) — tools/hist2m5.py converts and aggregates.
const fs = require('fs');
const [,, pair, fromYear, toYear, toMonth, dir = 'data'] = process.argv;
if (!pair || !fromYear || !toYear || !toMonth){ console.error('usage: fetch_histdata.js <pair> <fromYear> <toYear> <toMonth> [dir]'); process.exit(1); }
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';
const sleep = ms => new Promise(r => setTimeout(r, ms));
async function fetchZip(year, month){
  const url = `https://www.histdata.com/download-free-forex-historical-data/?/ascii/1-minute-bar-quotes/${pair}/${year}` + (month ? `/${month}` : '');
  const page = await fetch(url, { headers: { 'User-Agent': UA } }); const html = await page.text();
  const inputs = {}; for (const m of html.matchAll(/<input[^>]*id="([^"]+)"[^>]*value="([^"]*)"/g)) inputs[m[1]] = m[2];
  if (!inputs.tk) throw new Error(`no token on ${url} (status ${page.status})`);
  const body = new URLSearchParams({ tk: inputs.tk, date: inputs.date || String(year), datemonth: inputs.datemonth || (month ? `${year}${String(month).padStart(2, '0')}` : String(year)), platform: inputs.platform || 'ASCII', timeframe: inputs.timeframe || 'M1', fxpair: inputs.fxpair || pair.toUpperCase() });
  const res = await fetch('https://www.histdata.com/get.php', { method: 'POST', headers: { 'User-Agent': UA, 'Referer': url, 'Content-Type': 'application/x-www-form-urlencoded', 'Origin': 'https://www.histdata.com' }, body });
  const buf = Buffer.from(await res.arrayBuffer());
  if (res.status !== 200 || buf.length < 1000 || buf[0] !== 0x50 || buf[1] !== 0x4b) throw new Error(`not a zip: status ${res.status}, ${buf.length} bytes`);
  return buf;
}
(async () => {
  fs.mkdirSync(dir, { recursive: true });
  const plan = []; for (let y = +fromYear; y < +toYear; y++) plan.push([y]); for (let m = 1; m <= +toMonth; m++) plan.push([+toYear, m]);
  for (const [y, m] of plan){
    const out = `${dir}/hist_${pair}_${y}${m ? '_' + String(m).padStart(2, '0') : ''}.zip`;
    if (fs.existsSync(out) && fs.statSync(out).size > 1000){ console.log('have', out); continue; }
    try { fs.writeFileSync(out, await fetchZip(y, m)); console.log('got', out, fs.statSync(out).size, 'bytes'); }
    catch (e){ console.log('FAILED', out, e.message); }
    await sleep(2500);
  }
})();
