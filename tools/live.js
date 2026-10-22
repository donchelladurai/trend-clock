#!/usr/bin/env node
// tools/live.js — live bars for the TrendClock board, served from the owner's machine.
//
// index.html is a static time-of-day climatology; its live layer reads the 20SMA slope state of
// each instrument on the 15-, 5- and 2-minute charts from live bars. The page cannot fetch quotes
// itself (CORS), so this helper keeps seven days of 1-minute bars per instrument in memory, fed
// by one of two sources, and serves:
//
//   GET /live.json     the last 120 bars of the 2-, 5- and 15-minute charts for the 21
//                      instruments, each instrument's daily ATR by the generator's rule
//                      (CLAUDE.md §1b), its feed delay and update mode, and how old its data is.
//                      Sent with Access-Control-Allow-Origin: * so the GitHub Pages copy of the
//                      board can read it from http://localhost:8787/live.json as well as the
//                      local copy.
//   GET /live/status   a plain-text summary of the store
//   GET /<anything>    the repo's static files (index.html for /)
//
//   node tools/live.js [--port 8787] [--poll 30] [--source tradingview|yahoo] [--root <dir>]
//
// Then open http://localhost:8787/. Ctrl-C stops it. Node 24 or later (built-in fetch and
// WebSocket), no packages.
//
// Sources:
//   tradingview (default)  TradingView's public websocket, streaming real-time 1-minute bars for
//                          the OANDA CFD symbols that match the board's instruments — the
//                          European indices and gold included, which Yahoo only gives delayed —
//                          on 24-hour CFD sessions (17:00-17:00 New York) like the histdata feeds
//                          the climatology was built from. It is an unofficial, undocumented
//                          feed that may change or block at any time, which is why the second
//                          source stays. Without --source it is tried first and yahoo takes over
//                          by itself when the stream has not come up within 45 s or three
//                          reconnects in a row have failed; --source tradingview turns that
//                          fallback off.
//   yahoo                  Yahoo Finance's v8 chart API, polled every --poll seconds: real-time
//                          FX and US cash indices, the European cash indices 15 minutes delayed
//                          and only 08:00-16:30 UK, gold futures 10 minutes delayed.
//
// A failed fetch or a feed error keeps the previous bars and is reported in the instrument's
// `error`; nothing here throws past its own request. TV_TEST_DROP=<seconds> in the environment
// closes the TradingView socket once, that long after start, to exercise the reconnect.
//
// Sections: instruments and constants / command line / shared helpers / store / source: yahoo /
// source: tradingview / aggregation / ATR / server / start.
'use strict';
const http = require('http');
const fs = require('fs');
const path = require('path');

// ---------------------------------------------------------------------------------------------
// Instruments and constants
// ---------------------------------------------------------------------------------------------

// Board label, Yahoo symbol, Yahoo feed delay in minutes, TradingView symbol. On Yahoo the
// European cash indices are 15 minutes delayed and trade 08:00-16:30 UK, the US cash indices
// are real-time and trade 14:30-21:00 UK, gold futures are 10 minutes delayed, FX is real-time
// and continuous. TradingView's delay comes from the stream itself (see series_completed below).
// The page reads `delayMin` and `updateMode` and says so.
const INSTRUMENTS = [
  ['FTSE 100',    '^FTSE',    15, 'OANDA:UK100GBP'],
  ['Germany 40',  '^GDAXI',   15, 'OANDA:DE30EUR'],
  ['France 40',   '^FCHI',    15, 'OANDA:FR40EUR'],
  ['Wall Street', '^DJI',      0, 'OANDA:US30USD'],
  ['US Tech 100', '^NDX',      0, 'OANDA:NAS100USD'],
  ['US 500',      '^GSPC',     0, 'OANDA:SPX500USD'],
  ['Spot Gold',   'GC=F',     10, 'OANDA:XAUUSD'],
  ['EUR/USD',     'EURUSD=X',  0, 'OANDA:EURUSD'],
  ['GBP/USD',     'GBPUSD=X',  0, 'OANDA:GBPUSD'],
  ['AUD/USD',     'AUDUSD=X',  0, 'OANDA:AUDUSD'],
  ['USD/CAD',     'CAD=X',     0, 'OANDA:USDCAD'],
  ['USD/JPY',     'JPY=X',     0, 'OANDA:USDJPY'],
  ['USD/CHF',     'CHF=X',     0, 'OANDA:USDCHF'],
  ['NZD/USD',     'NZDUSD=X',  0, 'OANDA:NZDUSD'],
  ['EUR/GBP',     'EURGBP=X',  0, 'OANDA:EURGBP'],
  ['EUR/AUD',     'EURAUD=X',  0, 'OANDA:EURAUD'],
  ['EUR/JPY',     'EURJPY=X',  0, 'OANDA:EURJPY'],
  ['EUR/CAD',     'EURCAD=X',  0, 'OANDA:EURCAD'],
  ['EUR/CHF',     'EURCHF=X',  0, 'OANDA:EURCHF'],
  ['EUR/NZD',     'EURNZD=X',  0, 'OANDA:EURNZD'],
  ['AUD/JPY',     'AUDJPY=X',  0, 'OANDA:AUDJPY'],
];

const MINUTE = 60000;
const CHARTS = [2, 5, 15];              // minutes per bar of the charts served
const BARS_SERVED = 120;                // bars per chart, the in-progress one included
const KEEP_MS = 7 * 86400000;           // 1-minute bars older than this are dropped from memory
const KEEP_HISTORY_MS = 120 * 86400000; // and the ATR history older than this
const FETCH_TIMEOUT_MS = 20000;
const ATR_LEN = 14;                     // Wilder length, the generator's ATR_DAYS
const ATR_MIN_DAYS = 5;                 // with fewer completed trading days the ATR is null
const ATR_MIN_HOURS = 6;                // six hours of bars make a trading day (CLAUDE.md §1b)
const UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36';

// ---------------------------------------------------------------------------------------------
// Command line
// ---------------------------------------------------------------------------------------------

const USAGE = 'usage: node tools/live.js [--port 8787] [--poll 30] [--source tradingview|yahoo] [--root <dir>]';
const SOURCE_NAMES = ['tradingview', 'yahoo'];

function parseArgs(argv){
  const opt = { port: 8787, poll: 30, source: null, root: path.resolve(__dirname, '..') };
  for (let i = 0; i < argv.length; i++){
    const flag = argv[i], value = argv[i + 1];
    if (flag === '--port'){ opt.port = Number(value); i++; }
    else if (flag === '--poll'){ opt.poll = Number(value); i++; }
    else if (flag === '--source'){ opt.source = String(value); i++; }
    else if (flag === '--root'){ opt.root = path.resolve(String(value)); i++; }
    else if (flag === '--help' || flag === '-h'){ console.log(USAGE); process.exit(0); }
    else { console.error(`unknown argument ${flag}\n${USAGE}`); process.exit(1); }
  }
  if (!(opt.port > 0) || !(opt.poll > 0)){ console.error(USAGE); process.exit(1); }
  // No --source: tradingview with yahoo as the fallback. An explicit --source is final.
  opt.fallback = opt.source === null;
  if (opt.source === null) opt.source = 'tradingview';
  if (!SOURCE_NAMES.includes(opt.source)){ console.error(`unknown source "${opt.source}"; known: ${SOURCE_NAMES.join(', ')}`); process.exit(1); }
  return opt;
}

const opt = parseArgs(process.argv.slice(2));

// ---------------------------------------------------------------------------------------------
// Shared helpers
// ---------------------------------------------------------------------------------------------

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

function ukClock(t){
  return new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, hour: '2-digit', minute: '2-digit', second: '2-digit' }).format(new Date(t));
}

function log(message){
  console.log(`${ukClock(Date.now())} ${message}`);
}

function fmtAge(sec){
  if (sec === null) return 'n/a';
  if (sec < 90) return `${sec}s`;
  if (sec < 5400) return `${Math.round(sec / 60)}m`;
  return `${Math.floor(sec / 3600)}h${String(Math.round(sec % 3600 / 60)).padStart(2, '0')}m`;
}

// Yahoo serves prices as float32, so a quote of 1.1200718 arrives as 1.1200717687606812 and
// 7803.28 as 7803.27978515625. The shortest decimal that is the same float32 is the quote as
// published; it is also a third of the JSON. A value that is already a short decimal, as
// TradingView's are, comes back unchanged.
function tidy(x){
  const asFloat32 = Math.fround(x);
  for (let digits = 1; digits <= 17; digits++){
    const candidate = Number(x.toPrecision(digits));
    if (Math.fround(candidate) === asFloat32) return candidate;
  }
  return x;
}

// ---------------------------------------------------------------------------------------------
// Store
// ---------------------------------------------------------------------------------------------
// One state per instrument. Both sources feed the same minute store; the ATR history holds the
// source's longer bars — 5-minute from yahoo, 15-minute from tradingview — with its bar length
// recorded so the ATR can apply the same day rule to either.

function makeState([label, yahooSymbol, yahooDelay, tvSymbol]){
  const st = {
    label, yahooSymbol, yahooDelay, tvSymbol,
    symbol: null,             // the active source's symbol
    delayMin: 0,              // the active source's feed delay in minutes
    updateMode: null,         // tradingview's series_completed mode ("streaming", ...); null on yahoo
    minutes: new Map(),       // t -> 1-minute bar, the last seven days
    sorted: null,             // the minute bars sorted by t; rebuilt after a merge
    history: { minutes: 5, bars: new Map(), sorted: null },   // the ATR's bars, keyed by t
    historyAt: 0,             // yahoo: when the history was last fetched (0 = never)
    updated: null,            // utc ms of the last successful poll or stream message
    error: 'no data yet',     // the last failure, or null once data has arrived
    cycleUpdates: 0,          // successful polls or stream messages since the last cycle line
  };
  setSource(st, opt.source);
  return st;
}

function setSource(st, name){
  if (name === 'yahoo'){ st.symbol = st.yahooSymbol; st.delayMin = st.yahooDelay; st.history.minutes = 5; }
  else { st.symbol = st.tvSymbol; st.delayMin = 0; st.history.minutes = 15; }
  st.updateMode = null;
}

const states = INSTRUMENTS.map(makeState);
const STARTED = Date.now();
let active = opt.source;      // what /live.json reports: 'tradingview', 'yahoo' or 'yahoo (fallback)'
let stopping = false, cycles = 0;

// New bars are added, a bar already held (the in-progress one above all) is replaced, and
// anything older than KEEP_MS goes.
function mergeMinutes(st, bars, now){
  for (const b of bars) st.minutes.set(b.t, b);
  const cutoff = now - KEEP_MS;
  for (const t of st.minutes.keys()) if (t < cutoff) st.minutes.delete(t);
  st.sorted = null;
}

function minuteBars(st){
  if (!st.sorted) st.sorted = [...st.minutes.values()].sort((a, b) => a.t - b.t);
  return st.sorted;
}

function lastBarOf(st){
  const bars = minuteBars(st);
  return bars.length ? bars[bars.length - 1].t : null;
}

// Seconds between now and the end of the latest 1-minute bar, floored at 0; null with no bars.
function ageOf(st, now){
  const last = lastBarOf(st);
  return last === null ? null : Math.max(0, Math.floor((now - (last + MINUTE)) / 1000));
}

function replaceHistory(st, bars){
  st.history.bars = new Map(bars.map(b => [b.t, b]));
  st.history.sorted = null;
}

function mergeHistory(st, bars, now){
  for (const b of bars) st.history.bars.set(b.t, b);
  const cutoff = now - KEEP_HISTORY_MS;
  for (const t of st.history.bars.keys()) if (t < cutoff) st.history.bars.delete(t);
  st.history.sorted = null;
}

function historyBars(st){
  if (!st.history.sorted) st.history.sorted = [...st.history.bars.values()].sort((a, b) => a.t - b.t);
  return st.history.sorted;
}

// The once-per-cycle log line, for either source: instruments that got data in the cycle, the
// oldest data on the board, and every instrument carrying an error.
function logCycle(detail){
  const now = Date.now();
  let updated = 0, oldest = null;
  const errors = [];
  for (const st of states){
    if (st.cycleUpdates > 0) updated++;
    st.cycleUpdates = 0;
    const age = ageOf(st, now);
    if (age !== null && (oldest === null || age > oldest.age)) oldest = { label: st.label, age };
    if (st.error) errors.push(`${st.label}: ${st.error}`);
  }
  log(`cycle ${cycles}: ${updated}/${states.length} updated ${detail}; oldest data ${oldest ? `${oldest.label} ${fmtAge(oldest.age)}` : 'none'}; errors ${errors.length ? errors.join('; ') : 'none'}`);
}

// ---------------------------------------------------------------------------------------------
// Source: yahoo — Yahoo Finance's v8 chart API, polled
// ---------------------------------------------------------------------------------------------
// Three calls, each taking the Yahoo symbol and returning a promise of bars {t, o, h, l, c}
// sorted by t, with t the bar's open time in UTC ms aligned to the bar length:
//   backfill(symbol)  seven days of 1-minute bars, fetched once at start
//   poll(symbol)      the current day's 1-minute bars, fetched every --poll seconds
//   history(symbol)   about a month of 5-minute bars, for the ATR, refreshed hourly
// Requests go one instrument at a time, spread over the poll interval and never closer than
// YAHOO_MIN_GAP_MS, so the rate stays well under one a second.

const YAHOO_MIN_GAP_MS = 1000;
const YAHOO_HISTORY_REFRESH_MS = 3600000;
let yahooBackfilled = false;

// Keys the records by the bucket their stamp falls in. An aligned stamp is a bar and takes the
// bucket; an unaligned one is a quote snapshot — Yahoo ends every series with one, at
// meta.regularMarketTime, with open = high = low = close = the last price — and only extends the
// bucket's bar (high, low, close), or opens the bucket when it is new, so the series ends on the
// current price without a flat record overwriting the minute's real open and range.
function alignBars(records, stepMs){
  const byT = new Map();
  for (const r of records){
    const t = Math.floor(r.t / stepMs) * stepMs;
    const bar = byT.get(t);
    if (r.t === t || !bar){ byT.set(t, { t, o: r.o, h: r.h, l: r.l, c: r.c }); continue; }
    if (r.h > bar.h) bar.h = r.h;
    if (r.l < bar.l) bar.l = r.l;
    bar.c = r.c;
  }
  return [...byT.values()].sort((a, b) => a.t - b.t);
}

// One chart request. timestamp[] holds bar open times in seconds (UTC); the quote arrays carry
// null where the feed has nothing for that minute, and those entries are skipped.
async function yahooChart(symbol, range, interval, stepMs){
  const url = `https://query1.finance.yahoo.com/v8/finance/chart/${encodeURIComponent(symbol)}?range=${range}&interval=${interval}`;
  const res = await fetch(url, { headers: { 'User-Agent': UA, 'Accept': 'application/json' }, signal: AbortSignal.timeout(FETCH_TIMEOUT_MS) });
  const text = await res.text();
  let json;
  try { json = JSON.parse(text); }
  catch (e){ throw new Error(`HTTP ${res.status}, not JSON: ${text.slice(0, 80)}`); }
  const chart = json.chart || {};
  if (chart.error) throw new Error(`${chart.error.code}: ${chart.error.description}`);
  if (!res.ok) throw new Error(`HTTP ${res.status}`);
  const result = chart.result && chart.result[0];
  if (!result) throw new Error('empty result');
  const stamps = result.timestamp || [];
  const quote = (result.indicators && result.indicators.quote && result.indicators.quote[0]) || {};
  const records = [];
  for (let i = 0; i < stamps.length; i++){
    const o = quote.open ? quote.open[i] : null, h = quote.high ? quote.high[i] : null;
    const l = quote.low ? quote.low[i] : null, c = quote.close ? quote.close[i] : null;
    if (o == null || h == null || l == null || c == null) continue;
    records.push({ t: stamps[i] * 1000, o: tidy(o), h: tidy(h), l: tidy(l), c: tidy(c) });
  }
  return alignBars(records, stepMs);
}

const YAHOO = {
  backfill: symbol => yahooChart(symbol, '7d', '1m', MINUTE),
  poll:     symbol => yahooChart(symbol, '1d', '1m', MINUTE),
  history:  symbol => yahooChart(symbol, '1mo', '5m', 5 * MINUTE),
};

// One request of one kind ('backfill', 'poll' or 'history') for one instrument. Returns true on
// success. A failure keeps the previous bars and is recorded in st.error for the page to show.
async function yahooRequest(st, kind){
  try {
    const bars = await YAHOO[kind](st.symbol);
    const now = Date.now();
    if (kind === 'history'){ replaceHistory(st, bars); st.historyAt = now; }
    else { mergeMinutes(st, bars, now); st.updated = now; }
    st.cycleUpdates++;
    st.error = null;
    return true;
  } catch (e){
    st.error = `${kind}: ${e.message}`;
    log(`${st.label} (${st.symbol}) ${st.error}`);
    return false;
  }
}

async function yahooBackfill(){
  for (const st of states){
    if (stopping) return;
    await yahooRequest(st, 'backfill');
    await sleep(YAHOO_MIN_GAP_MS);
    await yahooRequest(st, 'history');
    await sleep(YAHOO_MIN_GAP_MS);
    const a = atrFor(st, Date.now());
    log(`backfill ${st.label}: ${st.minutes.size} 1-minute bars, ${st.history.bars.size} 5-minute bars, ATR ${a.atr === null ? 'n/a' : a.atr} over ${a.atrDays} days${st.error ? ' — ' + st.error : ''}`);
  }
}

// Every instrument once per --poll seconds, the requests spread evenly over the interval; the
// hourly history refresh rides along when it is due.
async function yahooPoll(){
  const gapMs = Math.max(YAHOO_MIN_GAP_MS, opt.poll * 1000 / states.length);
  while (!stopping){
    const cycleStart = Date.now();
    for (const st of states){
      if (stopping) break;
      const slotStart = Date.now();
      await yahooRequest(st, 'poll');
      await sleep(YAHOO_MIN_GAP_MS);
      if (Date.now() - st.historyAt >= YAHOO_HISTORY_REFRESH_MS){
        await yahooRequest(st, 'history');
        await sleep(YAHOO_MIN_GAP_MS);
      }
      await sleep(Math.max(0, gapMs - (Date.now() - slotStart)));
    }
    cycles++;
    logCycle(`in ${((Date.now() - cycleStart) / 1000).toFixed(1)} s`);
  }
}

function runYahoo(){
  yahooBackfill()
    .then(() => { yahooBackfilled = true; log('backfill complete'); return yahooPoll(); })
    .catch(e => log(`polling stopped: ${e.message}`));
}

// ---------------------------------------------------------------------------------------------
// Source: tradingview — streaming over TradingView's public websocket
// ---------------------------------------------------------------------------------------------
// Unofficial and undocumented; this is the protocol as a probe found it on 13 Oct 2026:
//   frame      "~m~<len>~m~<payload>", len = payload.length in UTF-16 units; one socket message
//              carries one or more frames. Heartbeats arrive as the payload "~h~<n>" about every
//              10 s and must be echoed back verbatim, or the server closes the socket.
//   message    a JSON line {"m": method, "p": [params]}, one per frame.
//   sequence   set_auth_token ["unauthorized_user_token"], set_locale ["en", "US"], then one chart
//              session per series, because a second create_series in one session is refused:
//              chart_create_session [cs, ""], resolve_symbol [cs, "sds_sym_1", "={symbol...}"],
//              create_series [cs, "sds_1", "s1", "sds_sym_1", resolution, bars, ""].
//   replies    series_completed [cs, "sds_1", mode, ...] with mode "streaming" or
//              "delayed_streaming_<seconds>"; timescale_update [cs, {sds_1: {s: [{i, v}]}}] with
//              the history and later each new bar as it opens; du [cs, {sds_1: {s: [{i, v}]}}]
//              with the in-progress bar about every 5 s; v = [open time in epoch seconds, o, h,
//              l, c, volume]. symbol_error / series_error / critical_error [cs, ...] name the
//              session that failed.
//   limits     without a login: 9,856 one-minute bars (seven days) and 7,191 fifteen-minute
//              bars (75 days) however many are asked for; resolution "2" is refused, so the
//              2-minute chart is built from the minute store as it is for yahoo; 42 sessions on
//              one socket were accepted when tested.
// Each instrument gets two sessions: a 1-minute series that feeds the minute store, and a
// 15-minute series that is the ATR's history. Everything is keyed by the session id, so a
// message for a session this socket did not open (a stale one after a reconnect) is ignored.

const TV_URL = 'wss://data.tradingview.com/socket.io/websocket?from=chart%2F&date=2026_10_13-18_00&type=chart';
const TV_ORIGIN = 'https://www.tradingview.com';
const TV_TOKEN = 'unauthorized_user_token';
const TV_BARS_1M = 10000, TV_BARS_15M = 8000;
const TV_SEND_GAP_MS = 30;          // between sessions while subscribing
const TV_READY_MS = 45000;          // a socket without most instruments streaming by then has failed
const TV_SILENCE_MS = 60000;        // no frame for this long (heartbeats come every ~10 s) and it is dead
const TV_BACKOFF_MIN_MS = 2000, TV_BACKOFF_MAX_MS = 60000;
const TV_FAILS_TO_FALLBACK = 3;     // consecutive failed connections before yahoo takes over

const tv = {
  ws: null,                   // the current socket; events from any other socket are ignored
  sessions: new Map(),        // cs -> { st, minutes, completed } for the current socket
  ready: false,               // this socket has most instruments streaming
  everReady: false,           // some socket has
  failures: 0,                // consecutive connections that never became ready
  reconnects: 0,
  stopped: false,
  connectedAt: 0,
  lastMessageAt: 0,
  readyTimer: null, watchdog: null, cycleTimer: null,
};

function tvFrame(payload){
  return `~m~${payload.length}~m~${payload}`;
}

// Splits a socket message into its payloads by the declared lengths; a malformed frame ends it.
function tvUnframe(text){
  const payloads = [];
  let i = 0;
  while (i < text.length){
    const head = /^~m~(\d+)~m~/.exec(text.slice(i, i + 24));
    if (!head) break;
    const start = i + head[0].length, len = Number(head[1]);
    payloads.push(text.slice(start, start + len));
    i = start + len;
  }
  return payloads;
}

function tvSendRaw(ws, payload){
  try { ws.send(tvFrame(payload)); }
  catch (e){ log(`tradingview: send failed: ${e.message}`); }
}

function tvSend(ws, method, params){
  tvSendRaw(ws, JSON.stringify({ m: method, p: params }));
}

function tvSessionId(){
  const alphabet = 'abcdefghijklmnopqrstuvwxyz0123456789';
  let id = 'cs_';
  for (let i = 0; i < 12; i++) id += alphabet[Math.floor(Math.random() * alphabet.length)];
  return id;
}

function tvDelayMinutes(mode){
  const m = /^delayed_streaming_(\d+)$/.exec(mode);
  return m ? Math.round(Number(m[1]) / 60) : 0;
}

function tvConnect(){
  if (tv.stopped) return;
  tv.sessions.clear();
  tv.ready = false;
  tv.connectedAt = 0;
  tv.lastMessageAt = Date.now();
  let ws;
  try { ws = new WebSocket(TV_URL, { headers: { Origin: TV_ORIGIN, 'User-Agent': UA } }); }
  catch (e){ tvOnClose(null, e.message); return; }
  tv.ws = ws;
  ws.addEventListener('open', () => {
    if (ws !== tv.ws) return;
    tv.connectedAt = Date.now();
    log(`tradingview: connected${tv.reconnects ? ` (reconnect ${tv.reconnects})` : ''}; subscribing ${states.length * 2} series`);
    tvSubscribeAll(ws);
    tv.readyTimer = setTimeout(() => tvReadyCheck(ws), TV_READY_MS);
  });
  ws.addEventListener('message', event => {
    if (ws !== tv.ws) return;
    tv.lastMessageAt = Date.now();
    if (typeof event.data !== 'string') return;
    for (const payload of tvUnframe(event.data)) tvOnPayload(ws, payload);
  });
  ws.addEventListener('error', event => {
    if (ws !== tv.ws) return;
    log(`tradingview: socket error${event.message ? ': ' + event.message : ''}`);
  });
  ws.addEventListener('close', event => {
    if (ws !== tv.ws) return;
    tvOnClose(event.code, event.reason);
  });
}

async function tvSubscribeAll(ws){
  tvSend(ws, 'set_auth_token', [TV_TOKEN]);
  tvSend(ws, 'set_locale', ['en', 'US']);
  for (const st of states){
    for (const [minutes, bars] of [[1, TV_BARS_1M], [15, TV_BARS_15M]]){
      if (ws !== tv.ws || ws.readyState !== WebSocket.OPEN) return;
      const cs = tvSessionId();
      tv.sessions.set(cs, { st, minutes, completed: false });
      tvSend(ws, 'chart_create_session', [cs, '']);
      tvSend(ws, 'resolve_symbol', [cs, 'sds_sym_1', '=' + JSON.stringify({ symbol: st.symbol, adjustment: 'splits' })]);
      tvSend(ws, 'create_series', [cs, 'sds_1', 's1', 'sds_sym_1', String(minutes), bars, '']);
      await sleep(TV_SEND_GAP_MS);
    }
  }
}

function tvOnPayload(ws, payload){
  if (/^~h~\d+$/.test(payload)){ tvSendRaw(ws, payload); return; }
  let msg;
  try { msg = JSON.parse(payload); }
  catch (e){ return; }
  if (!msg || typeof msg.m !== 'string' || !Array.isArray(msg.p)) return;   // the hello, mostly
  const sub = tv.sessions.get(msg.p[0]);
  if (!sub) return;
  const st = sub.st, now = Date.now();
  if (msg.m === 'series_completed'){
    sub.completed = true;
    if (sub.minutes === 1){
      st.updateMode = String(msg.p[2]);
      st.delayMin = tvDelayMinutes(st.updateMode);
      tvCountStreaming();
    }
    return;
  }
  if (msg.m === 'timescale_update' || msg.m === 'du'){
    const bars = [];
    const data = msg.p[1] || {};
    for (const key of Object.keys(data)){
      const items = data[key] && data[key].s;
      if (!Array.isArray(items)) continue;
      for (const item of items){
        const v = item && item.v;
        if (!Array.isArray(v) || v.length < 5) continue;
        bars.push({ t: v[0] * 1000, o: tidy(v[1]), h: tidy(v[2]), l: tidy(v[3]), c: tidy(v[4]) });
      }
    }
    if (!bars.length) return;
    if (sub.minutes === 1) mergeMinutes(st, bars, now);
    else mergeHistory(st, bars, now);
    st.updated = now;
    st.error = null;
    st.cycleUpdates++;
    return;
  }
  if (msg.m === 'symbol_error' || msg.m === 'series_error' || msg.m === 'critical_error'){
    const detail = msg.p.slice(1).map(x => typeof x === 'string' ? x : JSON.stringify(x)).join(' ');
    st.error = `${msg.m}: ${detail}`.slice(0, 200);
    log(`${st.label} (${st.symbol}) ${st.error}`);
  }
}

function tvStreamingCount(){
  let n = 0;
  for (const sub of tv.sessions.values()) if (sub.minutes === 1 && sub.completed) n++;
  return n;
}

// A socket is ready once most instruments have their 1-minute series streaming; that resets the
// failure count that drives the backoff and the fallback.
function tvCountStreaming(){
  const n = tvStreamingCount();
  if (!tv.ready && n >= Math.ceil(states.length / 2)){
    tv.ready = true;
    tv.everReady = true;
    tv.failures = 0;
  }
  if (n === states.length) log(`tradingview: all ${n} instruments streaming, ${((Date.now() - tv.connectedAt) / 1000).toFixed(1)} s after connect`);
}

function tvReadyCheck(ws){
  tv.readyTimer = null;
  if (ws !== tv.ws) return;
  const n = tvStreamingCount();
  if (!tv.ready) tvDrop(`only ${n}/${states.length} instruments streaming ${TV_READY_MS / 1000} s after connect`);
  else if (n < states.length) log(`tradingview: ${n}/${states.length} instruments streaming ${TV_READY_MS / 1000} s after connect`);
}

// Gives up on the current socket from our side. Its eventual close event is ignored, because a
// server that has gone silent may never complete the closing handshake.
function tvDrop(reason){
  const ws = tv.ws;
  if (!ws) return;
  tv.ws = null;
  try { ws.close(); } catch (e){ /* already closing */ }
  tvOnClose(null, reason);
}

function tvOnClose(code, reason){
  clearTimeout(tv.readyTimer);
  tv.readyTimer = null;
  const wasReady = tv.ready;
  tv.ws = null;
  tv.ready = false;
  tv.sessions.clear();
  if (tv.stopped) return;
  if (!wasReady) tv.failures++;
  const why = `socket closed (${code === null ? reason : `code ${code}${reason ? ' ' + reason : ''}`})`;
  if (opt.fallback && (tv.failures >= TV_FAILS_TO_FALLBACK || (tv.failures > 0 && !tv.everReady))){
    switchToYahoo(`${why}; ${tv.everReady ? `${tv.failures} reconnects failed in a row` : 'the stream never came up'}`);
    return;
  }
  const delay = Math.min(TV_BACKOFF_MAX_MS, TV_BACKOFF_MIN_MS * 2 ** tv.failures);
  tv.reconnects++;
  log(`tradingview: ${why}; reconnecting in ${delay / 1000} s (reconnect ${tv.reconnects}${tv.failures ? `, ${tv.failures} failed in a row` : ''})`);
  setTimeout(tvConnect, delay);
}

function tvStop(){
  tv.stopped = true;
  clearTimeout(tv.readyTimer);
  clearInterval(tv.watchdog);
  clearInterval(tv.cycleTimer);
  if (tv.ws){ const ws = tv.ws; tv.ws = null; try { ws.close(); } catch (e){ /* already closing */ } }
}

// The fallback: the stream is abandoned, every instrument is re-pointed at its Yahoo symbol with
// an empty store (the two providers' prices differ, so their bars are not mixed), and the poller
// starts from its backfill.
function switchToYahoo(reason){
  tvStop();
  active = 'yahoo (fallback)';
  log(`tradingview: ${reason} — falling back to yahoo`);
  for (const st of states){
    setSource(st, 'yahoo');
    st.minutes.clear();
    st.sorted = null;
    replaceHistory(st, []);
    st.historyAt = 0;
    st.updated = null;
    st.error = 'no data yet';
    st.cycleUpdates = 0;
  }
  runYahoo();
}

function runTradingView(){
  if (typeof WebSocket === 'undefined'){
    if (opt.fallback){ switchToYahoo('this node has no WebSocket (node 22 or later is needed)'); return; }
    console.error('tradingview source needs the built-in WebSocket of node 22 or later');
    process.exit(1);
  }
  tv.watchdog = setInterval(() => {
    if (tv.ws && Date.now() - tv.lastMessageAt > TV_SILENCE_MS) tvDrop(`no frame for ${TV_SILENCE_MS / 1000} s`);
  }, 15000);
  tv.cycleTimer = setInterval(() => { cycles++; logCycle(`in the last ${opt.poll} s`); }, opt.poll * 1000);
  if (process.env.TV_TEST_DROP){
    setTimeout(() => { log('tradingview: TV_TEST_DROP — closing the socket to test the reconnect'); tvDrop('TV_TEST_DROP'); }, Number(process.env.TV_TEST_DROP) * 1000);
  }
  tvConnect();
}

// ---------------------------------------------------------------------------------------------
// Aggregation — 1-minute bars into N-minute bars, buckets aligned to the UTC clock
// ---------------------------------------------------------------------------------------------
// bucket open = floor(t / step) * step; open from the first minute, high and low the extremes,
// close from the last minute. A bucket with no minutes is simply absent — nothing is filled.

function aggregate(bars, stepMs){
  const out = [];
  let bar = null;
  for (const b of bars){
    const t = Math.floor(b.t / stepMs) * stepMs;
    if (!bar || bar.t !== t){ bar = { t, o: b.o, h: b.h, l: b.l, c: b.c }; out.push(bar); continue; }
    if (b.h > bar.h) bar.h = b.h;
    if (b.l < bar.l) bar.l = b.l;
    bar.c = b.c;
  }
  return out;
}

function chartBars(st, minutes){
  return aggregate(minuteBars(st), minutes * MINUTE).slice(-BARS_SERVED).map(b => [b.t, b.o, b.h, b.l, b.c]);
}

// ---------------------------------------------------------------------------------------------
// ATR — the generator's daily scale (CLAUDE.md §1b), from the source's history bars
// ---------------------------------------------------------------------------------------------
// Bars are grouped into Europe/London calendar days. A trading day is Mon-Fri with at least six
// hours of bars (72 five-minute bars on yahoo, 24 fifteen-minute bars on tradingview). For each
// completed trading day (today is never one) TR = max(high - low, |high - prevClose|,
// |low - prevClose|), prevClose the previous trading day's last close, and the ATR is the 14-day
// Wilder average: the mean of the first 14 TRs, then atr = (atr * 13 + tr) / 14 for each further
// day.

// The Europe/London date and weekday of a UTC instant. The UK offset is constant inside any UTC
// hour (the clock changes at 01:00 UTC), so Intl is consulted once per hour and cached.
const UK_DATE = new Intl.DateTimeFormat('en-GB', { timeZone: 'Europe/London', hour12: false, year: 'numeric', month: '2-digit', day: '2-digit', hour: '2-digit', minute: '2-digit' });
const ukOffsetCache = new Map();

function ukOffsetMs(t){
  const hour = Math.floor(t / 3600000);
  let offset = ukOffsetCache.get(hour);
  if (offset === undefined){
    const p = {};
    for (const part of UK_DATE.formatToParts(new Date(hour * 3600000))) p[part.type] = part.value;
    offset = Date.UTC(+p.year, +p.month - 1, +p.day, (+p.hour) % 24, +p.minute) - hour * 3600000;
    ukOffsetCache.set(hour, offset);
  }
  return offset;
}

function ukDay(t){
  const local = new Date(t + ukOffsetMs(t));
  return { date: local.toISOString().slice(0, 10), weekday: local.getUTCDay() };
}

function atrFor(st, now){
  // The series: the history, then the minute store aggregated to the history's bar length from
  // the history's last bucket on — today, and whatever the history has not seen yet.
  const stepMs = st.history.minutes * MINUTE;
  const history = historyBars(st);
  const byT = new Map();
  for (const b of history) byT.set(b.t, b);
  const historyEnd = history.length ? history[history.length - 1].t : -Infinity;
  for (const b of aggregate(minuteBars(st), stepMs)) if (b.t >= historyEnd) byT.set(b.t, b);
  const series = [...byT.values()].sort((a, b) => a.t - b.t);

  // Group into UK calendar days.
  const days = [];
  let day = null;
  for (const b of series){
    const d = ukDay(b.t);
    if (!day || day.date !== d.date){
      day = { date: d.date, weekday: d.weekday, high: b.h, low: b.l, close: b.c, bars: 1 };
      days.push(day);
      continue;
    }
    if (b.h > day.high) day.high = b.h;
    if (b.l < day.low) day.low = b.l;
    day.close = b.c;
    day.bars++;
  }

  // Completed trading days: not today, Mon-Fri, at least six hours of bars.
  const today = ukDay(now).date;
  const minBars = ATR_MIN_HOURS * 60 / st.history.minutes;
  const trading = days.filter(d => d.date < today && d.weekday >= 1 && d.weekday <= 5 && d.bars >= minBars);

  // True range and the Wilder recursion.
  let prevClose = NaN, atr = NaN, sum = 0, n = 0;
  for (const d of trading){
    let tr = d.high - d.low;
    if (!isNaN(prevClose)) tr = Math.max(tr, Math.abs(d.high - prevClose), Math.abs(d.low - prevClose));
    prevClose = d.close;
    n++;
    if (n <= ATR_LEN){ sum += tr; atr = sum / n; }
    else atr = (atr * (ATR_LEN - 1) + tr) / ATR_LEN;
  }
  return {
    atr: n >= ATR_MIN_DAYS ? Number(atr.toPrecision(6)) : null,
    atrDays: n,
    atrAsOf: n ? trading[n - 1].date : null,
  };
}

// ---------------------------------------------------------------------------------------------
// Server
// ---------------------------------------------------------------------------------------------

function buildLive(now){
  const out = { at: now, source: active, poll: opt.poll, started: STARTED, instruments: {} };
  for (const st of states){
    const a = atrFor(st, now);
    const bars = {};
    for (const minutes of CHARTS) bars[minutes] = chartBars(st, minutes);
    out.instruments[st.label] = {
      symbol: st.symbol,
      delayMin: st.delayMin,
      updateMode: st.updateMode,
      lastBar: lastBarOf(st),
      updated: st.updated,
      ageSec: ageOf(st, now),
      atr: a.atr,
      atrDays: a.atrDays,
      atrAsOf: a.atrAsOf,
      bars,
      error: st.error,
    };
  }
  return out;
}

function sourceStatus(){
  if (active === 'tradingview'){
    if (!tv.ws) return 'reconnecting';
    return tv.ready ? `streaming ${tvStreamingCount()}/${states.length} instruments, ${tv.reconnects} reconnects` : 'connecting';
  }
  return yahooBackfilled ? 'backfill complete' : 'backfilling';
}

function statusText(now){
  const pad = (s, n) => String(s).padEnd(n);
  const lines = [];
  lines.push(`TrendClock live helper — source ${active}, ${sourceStatus()}; poll ${opt.poll} s, started ${new Date(STARTED).toISOString()}, up ${fmtAge(Math.floor((now - STARTED) / 1000))}, ${cycles} cycles`);
  lines.push('');
  lines.push(pad('instrument', 13) + pad('symbol', 17) + pad('mode', 11) + pad('1m bars', 9) + pad('hist', 6) + pad('last bar (UK)', 19) + pad('age', 8) + pad('ATR', 11) + pad('days', 6) + pad('as of', 12) + 'error');
  for (const st of states){
    const last = lastBarOf(st);
    const a = atrFor(st, now);
    lines.push(pad(st.label, 13) + pad(st.symbol, 17) + pad(st.updateMode || '-', 11) + pad(st.minutes.size, 9) + pad(st.history.bars.size, 6)
      + pad(last === null ? '-' : `${ukDay(last).date} ${ukClock(last).slice(0, 5)}`, 19)
      + pad(fmtAge(ageOf(st, now)), 8) + pad(a.atr === null ? '-' : a.atr, 11) + pad(a.atrDays, 6) + pad(a.atrAsOf || '-', 12)
      + (st.error || ''));
  }
  return lines.join('\n') + '\n';
}

const TYPES = {
  '.html': 'text/html; charset=utf-8',
  '.js': 'text/javascript; charset=utf-8',
  '.json': 'application/json; charset=utf-8',
  '.svg': 'image/svg+xml',
  '.css': 'text/css; charset=utf-8',
  '.png': 'image/png',
};

function send(req, res, status, type, body){
  res.writeHead(status, { 'Content-Type': type, 'Content-Length': Buffer.byteLength(body), 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
  res.end(req.method === 'HEAD' ? undefined : body);
}

// Files under --root, by the extensions in TYPES; "/" is index.html. The resolved path must stay
// under the root (so "/../x" is refused), and dot-files and dot-directories are not served.
function serveStatic(req, res, pathname){
  const notFound = () => send(req, res, 404, 'text/plain; charset=utf-8', 'not found');
  let decoded;
  try { decoded = decodeURIComponent(pathname); }
  catch (e){ notFound(); return; }
  if (decoded === '/') decoded = '/index.html';
  const file = path.resolve(opt.root, '.' + decoded);
  const rootPrefix = opt.root.endsWith(path.sep) ? opt.root : opt.root + path.sep;
  const type = TYPES[path.extname(file).toLowerCase()];
  const hidden = decoded.split('/').some(segment => segment.startsWith('.'));
  if (!file.startsWith(rootPrefix) || !type || hidden || decoded.includes('\0')){ notFound(); return; }
  fs.stat(file, (err, stat) => {
    if (err || !stat.isFile()){ notFound(); return; }
    res.writeHead(200, { 'Content-Type': type, 'Content-Length': stat.size, 'Cache-Control': 'no-store', 'Access-Control-Allow-Origin': '*' });
    if (req.method === 'HEAD'){ res.end(); return; }
    fs.createReadStream(file).on('error', () => res.destroy()).pipe(res);
  });
}

function handle(req, res){
  if (req.method !== 'GET' && req.method !== 'HEAD'){ send(req, res, 405, 'text/plain; charset=utf-8', 'method not allowed'); return; }
  const pathname = new URL(req.url, 'http://localhost').pathname;
  const now = Date.now();
  if (pathname === '/live.json'){ send(req, res, 200, 'application/json; charset=utf-8', JSON.stringify(buildLive(now))); return; }
  if (pathname === '/live/status'){ send(req, res, 200, 'text/plain; charset=utf-8', statusText(now)); return; }
  serveStatic(req, res, pathname);
}

const server = http.createServer((req, res) => {
  try { handle(req, res); }
  catch (e){
    log(`request ${req.url} failed: ${e.message}`);
    if (!res.headersSent) res.writeHead(500, { 'Content-Type': 'text/plain; charset=utf-8' });
    res.end('error');
  }
});

// ---------------------------------------------------------------------------------------------
// Start
// ---------------------------------------------------------------------------------------------

function shutdown(signal){
  if (stopping) return;
  stopping = true;
  log(`${signal}: stopping`);
  tvStop();
  server.close(() => process.exit(0));
  if (server.closeAllConnections) server.closeAllConnections();
  setTimeout(() => process.exit(0), 1000).unref();
}

process.on('SIGINT', () => shutdown('SIGINT'));
process.on('SIGTERM', () => shutdown('SIGTERM'));

server.on('error', e => {
  console.error(`cannot listen on port ${opt.port}: ${e.message}`);
  process.exit(1);
});

server.listen(opt.port, () => {
  if (!fs.existsSync(path.join(opt.root, 'index.html'))) log(`warning: no index.html under ${opt.root}`);
  const sourceNote = opt.source === 'yahoo'
    ? `yahoo, ${states.length} instruments one request every ${(Math.max(YAHOO_MIN_GAP_MS, opt.poll * 1000 / states.length) / 1000).toFixed(1)} s`
    : `tradingview (unofficial stream)${opt.fallback ? ', yahoo as the fallback' : ', no fallback'}`;
  log(`TrendClock live helper: open http://localhost:${opt.port}/ (bars at /live.json, summary at /live/status); source ${sourceNote}; poll ${opt.poll} s; root ${opt.root}`);
  if (opt.source === 'yahoo') runYahoo();
  else runTradingView();
});
