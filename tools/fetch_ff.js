// Pulls the Forex Factory weekly calendar feed into data/ff_week.json for brief.html.
// Writes only when the events change, so the Action commits nothing on a quiet run.
// Usage: node tools/fetch_ff.js [outfile]
const fs = require('fs');

const URL = 'https://nfs.faireconomy.media/ff_calendar_thisweek.json';
const KEEP = new Set(['USD', 'EUR', 'GBP', 'JPY', 'CHF', 'CAD', 'AUD', 'NZD', 'CNY']);
const out = process.argv[2] || 'data/ff_week.json';

(async () => {
  const res = await fetch(URL, {headers: {'User-Agent': 'trend-clock-brief (github.com/donchelladurai/trend-clock)'}});
  if (!res.ok) throw new Error(`Feed returned ${res.status}`);
  const text = await res.text();
  let raw;
  try {
    raw = JSON.parse(text);
  } catch (e) {
    throw new Error('Feed did not return JSON (often a rate limit): ' + text.slice(0, 120));
  }
  if (!Array.isArray(raw)) throw new Error('Feed did not return a list of events');

  const events = raw
    .filter(e => KEEP.has(e.country))
    .map(e => ({
      title: e.title,
      country: e.country,
      date: e.date,
      impact: e.impact,
      forecast: e.forecast || '',
      previous: e.previous || ''
    }));
  // An empty week for the kept currencies is not a calendar; writing it would make both pages read
  // the week as clear.
  if (!events.length) throw new Error(`Feed returned ${raw.length} events but none for the kept currencies`);

  let old = null;
  try {
    old = JSON.parse(fs.readFileSync(out, 'utf8'));
  } catch (e) {}

  if (old && old.source === 'forexfactory' && JSON.stringify(old.events) === JSON.stringify(events)) {
    console.log(`No change (${events.length} events)`);
    return;
  }

  fs.writeFileSync(out, JSON.stringify({source: 'forexfactory', feed: URL, fetchedAt: new Date().toISOString(), events}, null, 1) + '\n');
  console.log(`Wrote ${events.length} events to ${out}`);
})().catch(err => {
  console.error(err.message);
  process.exit(1);
});
