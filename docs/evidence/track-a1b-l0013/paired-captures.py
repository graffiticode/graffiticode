# Fresh captures of the same items on TypeScript l0013 (writes production thumbnails, as any
# snap does) and Rust l0013r (writes the isolated bucket), compared with each other.
import io, json, sys, time, urllib.request
import numpy as np
from PIL import Image
TS, RUST = sys.argv[1], sys.argv[2]
ITEMS = sys.argv[3].split(",")
AST = lambda item: {"3": {"tag": "STR", "elts": [item]}, "4": {"tag": "RECORD", "elts": []},
                    "7": {"tag": "ITEM", "elts": [3, 4]}, "9": {"tag": "SNAP", "elts": [7]},
                    "11": {"tag": "EXPRS", "elts": [9]}, "12": {"tag": "PROG", "elts": [11]}, "root": 12}
UA = {"user-agent": "Mozilla/5.0 (Macintosh) Chrome/130 Safari/537.36"}
def fetch(url, body=None):
    req = urllib.request.Request(url, json.dumps(body).encode() if body is not None else None,
                                 {**UA, **({"content-type": "application/json"} if body is not None else {})})
    with urllib.request.urlopen(req, timeout=240) as r:
        return r.read()
def snap(base, item):
    t = time.time()
    a = json.loads(fetch(f"{base}/compile", {"code": AST(item), "data": {}}))
    if a.get("errors"): return None, a["errors"][0]["message"][:160], int((time.time()-t)*1000)
    return fetch(a["data"]["url"]), a["data"]["url"], int((time.time()-t)*1000)
out = []
for item in ITEMS:
    row = {"item": item}
    try:
        tp, tu, tms = snap(TS, item); rp, ru, rms = snap(RUST, item)
        row.update(ts=tu, rust=ru, ts_ms=tms, rust_ms=rms)
        if tp and rp:
            a, b = Image.open(io.BytesIO(rp)).convert("L"), Image.open(io.BytesIO(tp)).convert("L")
            row.update(rust_size=a.size, ts_size=b.size, same_size=a.size == b.size)
            if a.size != b.size: b = b.resize(a.size)
            d = np.abs(np.asarray(a, np.float32) - np.asarray(b, np.float32))
            row.update(mean_abs_diff=round(float(d.mean())/255, 4), pixels_over_32=round(float((d > 32).mean()), 4))
    except Exception as e:
        row["error"] = f"{type(e).__name__}: {e}"[:200]
    out.append(row); print(json.dumps(row))
print(json.dumps({"ranAt": time.strftime("%Y-%m-%dT%H:%M:%SZ", time.gmtime()), "ts": TS, "rust": RUST, "results": out}))
