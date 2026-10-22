# /// script
# dependencies = ["duckdb"]
# ///
"""Build state/{universe}/requeue.json: jobs seen after AFTER that left the latest
observation before capture reached them (#69). drainRequeue in src/index.ts drains it.

    uv run scripts/requeue.py bioc 96895555778 > bioc.json
    npx wrangler r2 object put bioc-prop/state/bioc/requeue.json --remote --file bioc.json

Jobs still in the latest observation are left out: the cursor captures handle those.
"""
import json
import sys
import tempfile
import urllib.request
from concurrent.futures import ThreadPoolExecutor
from pathlib import Path

import duckdb

BASE = "https://bioc-registry.seandavi.workers.dev"
universe, after = sys.argv[1], int(sys.argv[2])


def get(url: str) -> bytes:
    # The default Python-urllib agent gets a Cloudflare 403.
    req = urllib.request.Request(url, headers={"user-agent": "bioc-registry-requeue"})
    with urllib.request.urlopen(req) as r:
        return r.read()


tmp = Path(tempfile.mkdtemp())
keys = [k for k in json.loads(get(f"{BASE}/manifest.json")) if f"universe={universe}/" in k]
with ThreadPoolExecutor(8) as ex:
    for i, data in enumerate(ex.map(lambda k: get(f"{BASE}/data/{k}"), keys)):
        (tmp / f"{i}.parquet").write_bytes(data)

latest_key = json.loads(get(f"{BASE}/data/state/{universe}/latest"))["key"]
latest = {int(j["job"]) for p in json.loads(get(f"{BASE}/data/{latest_key}"))
          for j in p.get("_jobs", []) if j.get("job")}

# Isolated: ~/.duckdb/stored_secrets on onclappc02 breaks clients that lack its secret types.
db = duckdb.connect(config={"secret_directory": str(tmp / "secrets")})
rows = db.execute(
    f"select job, max(artifact) from read_parquet('{tmp}/*.parquet', union_by_name=true)"
    " where job > ? group by job order by job", [after]
).fetchall()
json.dump([[job, art] for job, art in rows if job not in latest], sys.stdout)
