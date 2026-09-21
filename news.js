// news.js — the Forex Factory week, shared by index.html (news bands and chips on the board) and
// brief.html (the spike map and the briefing). Pure functions plus one fetch; nothing here
// touches the DOM. Rules are documented in CLAUDE.md §9.
(function (global) {
  const TZ = 'Europe/London';
  // Which board instruments an event's currency hits. USD reaches the US indices and gold, EUR the
  // continental indices, GBP the FTSE, CNY the Australasian pairs; crude oil titles add the CAD pairs.
  const CCY = {
    USD: ['EUR/USD','GBP/USD','USD/JPY','USD/CHF','USD/CAD','AUD/USD','NZD/USD','US 500','US Tech 100','Wall Street','Spot Gold'],
    EUR: ['EUR/USD','EUR/GBP','EUR/JPY','EUR/CHF','EUR/AUD','EUR/CAD','EUR/NZD','Germany 40','France 40'],
    GBP: ['GBP/USD','EUR/GBP','FTSE 100'],
    JPY: ['USD/JPY','EUR/JPY','AUD/JPY'],
    CHF: ['USD/CHF','EUR/CHF'],
    CAD: ['USD/CAD','EUR/CAD'],
    AUD: ['AUD/USD','EUR/AUD','AUD/JPY'],
    NZD: ['NZD/USD','EUR/NZD'],
    CNY: ['AUD/USD','AUD/JPY','NZD/USD'],
    WHEAT: ['Chicago Wheat']
  };
  const IMPACT = {High: 'H', Medium: 'M', Low: 'L', Holiday: 'X'};
  const DAYN = ['Sun','Mon','Tue','Wed','Thu','Fri','Sat'];

  function ukParts(d) {
    const p = {};
    new Intl.DateTimeFormat('en-GB', {timeZone: TZ, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', second: '2-digit', weekday: 'short', hourCycle: 'h23'})
      .formatToParts(d).forEach(x => { p[x.type] = x.value; });
    return { ymd: `${p.year}-${p.month}-${p.day}`, min: (+p.hour) * 60 + (+p.minute), sec: +p.second, hm: `${p.hour}:${p.minute}`, dow: DAYN.indexOf(p.weekday), day: +p.day };
  }
  function hm(m) {
    m = ((m % 1440) + 1440) % 1440;
    return String(Math.floor(m / 60)).padStart(2, '0') + ':' + String(m % 60).padStart(2, '0');
  }
  function zonedToDate(ymd, hhmm, zone) {
    const [y, mo, d] = ymd.split('-').map(Number);
    const [h, mi] = hhmm.split(':').map(Number);
    let guess = Date.UTC(y, mo - 1, d, h, mi);
    for (let i = 0; i < 2; i++) {
      const p = {};
      new Intl.DateTimeFormat('en-US', {timeZone: zone, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit', hourCycle: 'h23'})
        .formatToParts(new Date(guess)).forEach(x => { p[x.type] = x.value; });
      const asUtc = Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour, +p.minute);
      guess += Date.UTC(y, mo - 1, d, h, mi) - asUtc;
    }
    return new Date(guess);
  }
  // Spike window [minutes before, minutes after] by weight and kind: where the move usually falls. "Unemployment Rate" and
  // "Inflation Rate" are data, not decisions, so the rate-decision test is anchored to policy rates.
  function windowFor(e) {
    const t = e.title.toLowerCase();
    if (e.imp === 'H' && !/speaks|unemployment|inflation|participation|savings/.test(t) && /(policy|cash|funds|refinancing|interest|bank|official|deposit|prime|overnight|ocr|repo) rate|rate (decision|statement)|monetary policy|policy (decision|statement|summary)|fomc statement|rate$/.test(t)) return [10, 30];
    if (/(speaks|speech|press conference|testifies|remarks)/.test(t)) return [0, 30];
    if (e.imp === 'H') return [5, 20];
    if (e.imp === 'M') return [5, 15];
    return [0, 5];
  }
  // Instruments hit, in the caller's board order.
  function instrumentsFor(e, order) {
    const base = CCY[e.country] ? CCY[e.country].slice() : [];
    const t = e.title.toLowerCase();
    if (/crude oil/.test(t) && !base.includes('USD/CAD')) base.push('USD/CAD', 'EUR/CAD');
    return order ? order.filter(i => base.includes(i)) : base;
  }
  // USDA's recurring slots for Chicago Wheat: Crop Progress Mondays 16:00 ET (April-November),
  // Export Sales Thursdays 08:30 ET. Not checked against holiday shifts or WASDE dates.
  function usdaSlots(weekMon) {
    const out = [];
    const month = +weekMon.slice(5, 7);
    const add = (offset, hhmm, title) => {
      const dt = new Date(zonedToDate(weekMon, '12:00', TZ).getTime() + offset * 86400000);
      const ymd = ukParts(dt).ymd;
      out.push({title, country: 'WHEAT', date: zonedToDate(ymd, hhmm, 'America/New_York').toISOString(), impact: 'Medium', forecast: '', previous: '', recurring: true});
    };
    if (month >= 4 && month <= 11) add(0, '16:00', 'USDA Crop Progress');
    add(3, '08:30', 'USDA Export Sales');
    return out;
  }
  // Feed rows → events with UK date, minute, window and instruments. Weekdays only.
  function prepare(raw, order) {
    return raw.map(r => {
      const d = new Date(r.date);
      const u = ukParts(d);
      const e = {title: r.title, country: r.country, imp: IMPACT[r.impact] || 'L', forecast: r.forecast || '', previous: r.previous || '', recurring: !!r.recurring, at: d, ymd: u.ymd, min: u.min, dow: u.dow};
      e.win = windowFor(e);
      e.ins = instrumentsFor(e, order);
      return e;
    }).filter(e => e.dow >= 1 && e.dow <= 5);
  }
  function shortName(t) {
    const s = t
      .replace(/^(FOMC Member|FOMC|Fed Chair|Fed Vice Chair|ECB President|ECB Vice President|ECB|BOE Gov|BOE|MPC Member|SNB Chairman|BOC Gov|RBA Gov|RBNZ Gov|BOJ Gov)\s+/i, '')
      .replace(/\s+Speaks$/i, '')
      .replace(/Flash Manufacturing PMI|Flash Services PMI/i, 'PMI')
      .replace(/Unemployment Claims/i, 'Claims')
      .replace(/Core Durable Goods Orders m\/m|Durable Goods Orders m\/m/i, 'Durables')
      .replace(/Monetary Policy Assessment/i, 'Policy Assessment')
      .replace(/Revised UoM /i, 'UoM ');
    // Over 22 characters, cut at a word boundary rather than mid-word; hard-cut only if that leaves too little.
    if (s.length <= 22) return s;
    const cut = s.slice(0, 22).replace(/\s+\S*$/, '');
    return cut.length >= 10 ? cut : s.slice(0, 22);
  }
  // Fetch data/ff_week.json and add the USDA slots for the week it covers, unless the feed already
  // carries wheat. Returns {source, fetchedAt, raw}; throws on a failed fetch or a non-JSON body.
  async function fetchWeek(url) {
    const r = await fetch(url, {cache: 'no-cache'});
    const j = await r.json();
    const raw = (j.events || []).slice();
    const pre = prepare(raw);
    const first = pre.length ? pre[0] : null;
    if (first && !raw.some(e => e.country === 'WHEAT')) {
      const monday = ukParts(new Date(zonedToDate(first.ymd, '12:00', TZ).getTime() - (first.dow - 1) * 86400000)).ymd;
      raw.push(...usdaSlots(monday));
    }
    return { source: j.source || 'forexfactory', fetchedAt: j.fetchedAt ? new Date(j.fetchedAt) : null, raw };
  }
  global.NewsFeed = { TZ, CCY, IMPACT, DAYN, ukParts, hm, zonedToDate, windowFor, instrumentsFor, usdaSlots, prepare, shortName, fetchWeek };
})(window);
