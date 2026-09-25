"""Download 1-minute BID candles from the Dukascopy datafeed, one file per calendar day.

    python tools/fetch_dukascopy.py USA30IDXUSD 2026-05-25 2026-09-20 data

Writes data/duka_<SYMBOL>_<YYYY-MM-DD>.bi5 (raw LZMA), skipping files already on disk. Dukascopy
serves slowly and drops connections (HTTP 503, socket timeouts), so requests are paced at 4 s, a failure
retries after a short wait, and a re-run skips what is already on disk. Timestamps inside the files are UTC seconds from that day's midnight;
prices are integers scaled by 1000 for index CFDs. tools/duka2bars.py decodes and aggregates.
This is the source for Wall Street, which histdata.com does not carry.
"""
import sys, os, time, urllib.request, urllib.error
from datetime import date, timedelta

sym, d0, d1 = sys.argv[1], date.fromisoformat(sys.argv[2]), date.fromisoformat(sys.argv[3])
outdir = sys.argv[4] if len(sys.argv) > 4 else 'data'
os.makedirs(outdir, exist_ok=True)
UA = 'Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/128.0 Safari/537.36'
d, failed = d0, []
while d <= d1:
    out = os.path.join(outdir, f'duka_{sym}_{d.isoformat()}.bi5')
    if os.path.exists(out):
        d += timedelta(days=1); continue
    url = f'https://datafeed.dukascopy.com/datafeed/{sym}/{d.year}/{d.month - 1:02d}/{d.day:02d}/BID_candles_min_1.bi5'
    for attempt in range(5):
        try:
            req = urllib.request.Request(url, headers={'User-Agent': UA})
            with urllib.request.urlopen(req, timeout=15) as r:
                buf = r.read()
            open(out, 'wb').write(buf)
            print('got', out, len(buf), 'bytes', flush=True)
            break
        except urllib.error.HTTPError as e:
            if e.code == 404:
                open(out, 'wb').write(b''); print('none', out, flush=True); break
            print('HTTP', e.code, url, 'waiting 20 s', flush=True); time.sleep(20)
        except Exception as e:
            print('ERR', url, e, 'waiting 5 s', flush=True); time.sleep(5)
    else:
        failed.append(d.isoformat())
    time.sleep(4)
    d += timedelta(days=1)
print('DONE', sym, flush=True)
if failed:
    print('FAILED after 5 attempts, no file written (re-run to retry):', ', '.join(failed), flush=True)
