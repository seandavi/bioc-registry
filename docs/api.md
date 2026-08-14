# bioc-prop API

Base URL: `https://bioc-registry.seandavi.workers.dev`

Everything is read-only GET and unauthenticated, except the maintenance routes
(`/poll`, `/backfill`, `/reindex`, `/seed`), which require an `x-maint-key` header
matching the `MAINT_KEY` worker secret when one is set. All data
endpoints serve straight from the R2 bucket, so responses are exactly the
stored objects — this API adds Range/CORS plumbing, not transformation.

## Routes

### `GET /`

Human dashboard (server-rendered HTML). Per universe: stat tiles (packages, not
propagated, last change, observations, propagated, and — when any exist — seeded
from Bioconductor and how many of those the official repo has moved past) and a config × check-status table from the latest observation.
Propagated and seeded are counted separately: a seeded package never passed the
gate, so folding the two together would improve the propagation rate by ~300
without a single package earning it.

### `GET /pkg/{universe}/{package}`

Package page (server-rendered HTML + client-side history). Shows, for the
latest observation: version, build status, per-config job table (check status,
R version, wall time, links to the log proxy and the GHA job page), a
newer-commit-failed banner when `_failure` is set, and the propagation index
entry (propagated version, artifacts with download links, source repo, and —
for a seeded entry — a banner saying it came from Bioconductor's release build
rather than this gate). The history section
loads DuckDB-WASM in the browser and pivots the package's rows from every
parquet observation into an observation × config check-status table.
404 if the package is not in the latest observation.

### `GET /logs/{universe}/{job}`

Plain-text GHA job log (`job` ids come from `_jobs[].job`), served from
`logs/{universe}/{job}.txt` in the bucket — not proxied, so no token sits on a
public route and the log stays readable after GitHub deletes it at ~90 days.

Capture runs on the cron (`captureLogs`), 50 jobs per run, walking forward from
a high-water mark in `state/{universe}/logcursor`. It only captures jobs seen
after it was switched on; anything older 404s here with a link to GHA. Capture
no-ops entirely without the `GITHUB_TOKEN` worker secret — GitHub returns 403
for unauthenticated log downloads, though job *metadata* is public.

The token lives in Google Secret Manager (project `cdsci-infra`) as
`cdsci-github-actions-read-token` — a fine-grained PAT with read-only Actions
access to public repositories. It is not stored in this repo or in
`wrangler.jsonc`; it is a worker secret, set once per environment:

```bash
gcloud secrets versions access latest \
  --secret=cdsci-github-actions-read-token --project=cdsci-infra |
  tr -d '\r\n' | npx wrangler secret put GITHUB_TOKEN   # tr -d: see below
```

A token stored **with a trailing newline** (what piping `gcloud` straight into
`wrangler secret put` gives you) is worse than no token at all: every request
throws `TypeError: Invalid header value` before it is sent, and capture's
`.catch` swallows it, so the only visible symptom is a `logcursor` that never
moves. `captureLogs` trims the secret defensively, but set it clean anyway.

Finding a job id to test with, and reading the log:

```bash
B=https://bioc-registry.seandavi.workers.dev
K=$(curl -s $B/data/state/bioc/latest | jq -r .key)
curl -s "$B/data/$K" | jq -c '.[] | select(.Package=="edgeR")
  | {Version, jobs: [._jobs[] | {config, check, job}]}'
curl -s $B/logs/bioc/<job>
```

**Whether capture is alive is visible in one place:**
`curl -s .../data/state/bioc/logcursor`. That integer must move within a cron
tick or two. It stays frozen when the token is missing (capture returns early)
and also when the cron invocation dies before the cursor is written — capture is
wrapped in a `.catch` so nothing surfaces either way. A frozen cursor with the
secret present means the invocation is failing, not the token.

### `GET /docs` and `GET /openapi.json`

Browsable API reference with a try-it panel for every route, rendered by Scalar
from `/openapi.json`. The spec is hand-written in `src/openapi.ts` and covers the
read-only surface only — `/poll`, `/backfill`, `/reindex` and `/seed` are
deliberately absent, since they are unauthenticated side-effecting GETs and a try-it button
next to `/backfill` is an invitation.

Nothing generates the spec from the handlers, so **a route change is not finished
until this file and `src/openapi.ts` are both updated** (see `CLAUDE.md`).

### `GET /sql`

In-browser SQL console. Loads DuckDB-WASM, fetches `/manifest.json`, and creates
two views over every parquet file: `jobs_delta` (the rows as stored) and `jobs`
(the full snapshot at each observation, reconstructed by carrying values forward).
Query `jobs` unless you specifically want to see when something changed.
Ctrl/Cmd-Enter runs the query. Example queries:

```sql
-- check status by config, both universes
SELECT universe, config, "check", count(*) AS n
FROM jobs GROUP BY ALL ORDER BY universe, config, "check";

-- one package's full check history across observations
SELECT obs_ts, config, r, "check", time
FROM jobs WHERE package = 'edgeR' ORDER BY obs_ts, config;

-- packages whose source check flipped between observations
SELECT package, count(DISTINCT "check") AS verdicts
FROM jobs WHERE config = 'source'
GROUP BY package HAVING verdicts > 1;

-- every actual change, straight off the stored rows: no reconstruction needed,
-- since a row exists only where something moved
SELECT obs_ts, package, config, "check" FROM jobs_delta
WHERE config = 'source' AND deleted IS NULL ORDER BY obs_ts DESC LIMIT 20;
```

### `GET /data/<r2-key>`

Serves any object in the bucket by key (see [Storage keys](#storage-keys)).

- Supports `Range` requests (returns `206` + `Content-Range`) and `HEAD` —
  this is what makes remote DuckDB/`httpfs` work against the parquet files.
- `Access-Control-Allow-Origin: *`, so any web page or notebook can query it.

```bash
curl -s https://bioc-registry.seandavi.workers.dev/data/prop/bioc-release/index.json | jq '.edgeR'
```

```python
import duckdb
duckdb.sql("""
  SELECT "check", count(*) FROM read_parquet(
    'https://bioc-registry.seandavi.workers.dev/data/parquet/jobs/universe=bioc/dt=2026-08-08/2026-08-08T19:01:50.388Z-acd8dfc2015f.parquet'
  ) GROUP BY ALL
""")
```

### `GET /repo/{universe}/…` — installable CRAN repo

`install.packages(repos="https://bioc-registry.seandavi.workers.dev/repo/bioc")`.
Generated from the propagation index, so a package appears here only once it is
in that index — either by passing the gate or by being seeded from
Bioconductor's own release build (`/seed` below). The entry's `origin` says
which; both are installable the same way.

- `src/contrib/PACKAGES` (and `.gz`) — source index, `write_PACKAGES()` fields
  only. No `PACKAGES.rds`, no `MD5sum` (r-universe exposes sha256 only).
- `VIEWS` (and `.gz`) — at the repo root, like the legacy repos: PACKAGES
  fields plus Title/Description/biocViews/Author/Maintainer/URL/BugReports/
  SystemRequirements/VignetteBuilder/Date, `git_last_commit{,_date}`,
  `source.ver`/`win.binary.ver`/`mac.binary.ver`, `vignettes`/`vignetteTitles`,
  `git_url`, and reverse deps within the propagated set (`dependsOnMe`,
  `importsMe`, `suggestsMe`). The macOS arm64 directory in `mac.binary.ver`
  follows the R version — CRAN renamed it `big-sur-arm64` → `sonoma-arm64` at
  R 4.6 — and a second mac build, when we hold one, is advertised as
  `mac.binary.big-sur-x86_64.ver`, the `mac.binary.<platform>.ver` form the
  legacy Bioconductor VIEWS used for secondary mac builds. Omitted as unknowable here: MD5sum, Rank, dependencyCount,
  hasREADME/hasNEWS/hasINSTALL/hasLICENSE, Rfiles, htmlDocs, htmlTitles.
- `src/contrib/{pkg}_{ver}.tar.gz`, `bin/windows/contrib/{r}/{file}`,
  `bin/macosx/{arch}/contrib/{r}/{file}` — artifact bytes from the CAS.

### `GET /manifest.json`

JSON array of all parquet keys, for programmatic discovery:

```bash
curl -s https://bioc-registry.seandavi.workers.dev/manifest.json | jq length
```

### `GET /poll`

Manually runs one poll cycle for both universes (same code path as the cron).
Requires `x-maint-key`; 403 without it.
Idempotent: unchanged upstream state is a no-op. Returns one line per universe:

```
bioc: unchanged acd8dfc2015f
bioc-release: archived obs/bioc-release/dt=…/….json
```

### `GET /backfill?run=N`

Maintenance. Writes parquet for any archived observation missing it, then
re-creates the workflow for each universe's **latest** observation (instance id
`bf{N}-{universe}-{digest}`). Safe to repeat — every downstream action is
idempotent; `run=N` salts the instance id so a relaunch isn't blocked by a
previous errored instance. Use after a gate change to re-evaluate the current
state without waiting for the next upstream change.

### `GET /seed?universe={bioc|bioc-release}&start=N&refresh=1`

Maintenance. One-time backfill of packages the official Bioconductor repositories
ship that have never passed this gate — they build in BBS and fail in
r-universe's environment, usually because an example reaches an external service
the runner cannot get to. Requires `x-maint-key`.

Strictly additive: it only fills holes. A package already in the index keeps its
entry, whatever its origin, so a `/seed` run can never displace or block a
propagated package. The version gate is untouched — a seeded package is replaced
the ordinary way, when its maintainer bumps the version and r-universe builds it.

Seeded entries carry `"origin": "bioconductor"`, an empty `archs`, and a null
`bioccheck`, because they never faced the gate.

The first call (per universe) builds a plan from the official `VIEWS` plus the
Windows and both macOS `PACKAGES` files, and stores it at
`prop/{universe}/seed/plan.json`; later calls read the plan instead of re-fetching
~8MB. `refresh=1` discards it, which is what a new Bioconductor release needs.

A seeded entry is frozen: nothing re-reads Bioconductor for it, so it drifts as
the official release gets patch bumps. The dashboard counts how many have fallen
behind rather than re-seeding on a timer — the fix for a drifted entry is the
package propagating normally.

Ten packages per call, walking with `start=N`, same as `/backfill`:

```
bioc-release: seeded 10, 34 artifacts copied, 6 artifacts missing upstream — next start=10 of 163
bioc-release: seed complete (163 planned)
```

Binaries come only from the binary directory's own `PACKAGES` at a matching
version — the counts differ from source (release: 2384 source, 2305 Windows,
2332 arm64, 2361 Intel), so a binary is never assumed to exist.

## Storage keys

All addressable through `/data/<key>`.

| key pattern | content |
|---|---|
| `obs/{universe}/dt=YYYY-MM-DD/{ts}-{digest12}.json` | full observation: array of package records (`Package`, `Version`, `_sha256`, `_status`, `_jobs`, `_binaries`, `_created`, `_expires`, `_fileid`, `_commit`, `_failure`) |
| `state/{universe}/latest` | `{digest, key, ts}` of the newest observation |
| `parquet/jobs/universe={u}/dt=…/{ts}-{digest12}.parquet` | jobs table for that observation (schema below) |
| `parquet/jobs/universe={u}/dt=…/{ts}-m.parquet` | same schema, holding several observations of a closed day merged together |
| `state/{universe}/logcursor` | `{job}` high-water mark for log capture |
| `state/{universe}/rowstate` | `{ts, rows}` — value hash per `(package, config)`, the baseline the next observation is diffed against |
| `state/{universe}/observations.json` | every observation timestamp, including ones that changed nothing |
| `logs/{universe}/{job}.txt` | captured GHA job log |
| `prop/{universe}/index.json` | `{ [package]: {version, sha256, ts, bioccheck, artifacts[], desc, meta, archs} }` — the propagated set |
| `prop/{universe}/cas/{sha256}` | artifact bytes (source tarball or platform binary), keyed by content hash |
| `prop/{universe}/pending/{digest12}.json` | gate output for one observation: array of candidates |
| `prop/{universe}/seed/plan.json` | what a `/seed` run intends to seed: package, version, desc, meta, artifact paths |
| `prop/{universe}/seed/official-versions.json` | every package version the official Bioconductor repo ships, for the seeded-drift count |
| `prop/{universe}/log/{ts}-{pkg}_{ver}.json` | propagation ledger entry |

`{universe}` is `bioc` (devel) or `bioc-release`. `{digest12}` is the first 12
hex chars of the observation body's sha256.

### Rows are stored as changes, not snapshots

Consecutive observations are ~99.9% identical (measured: 0-50 differing rows out
of ~26,850), so a row is written only when it differs from the previous
observation's row for the same `(package, config)`. `obs_ts` is the valid-from
stamp. A `deleted` column of `1` is a tombstone marking that a `(package, config)`
has gone away — without it a carry-forward reader keeps a removed row alive
forever.

Reading therefore means carrying the last value forward. The `/sql` page exposes
both: `jobs_delta` is the rows as stored, and `jobs` reconstructs the full
snapshot at every observation so queries written against the old table keep their
meaning. An observation that changed nothing writes no rows at all, which is why
`state/{universe}/observations.json` exists — it is the only record that such an
observation happened.

Two caveats on data archived before this change. It was stored whole, so it
contains no tombstones: a `(package, config)` that disappeared back then will
appear to persist in `jobs`. And those files have no `deleted` column, so readers
must normalise one in — `union_by_name=true` only unions columns that at least
one file actually has.

The cron compacts closed days in the background, merging up to 6 parquet files
per run into one `-m.parquet`. Consumers should read whatever `/manifest.json`
currently lists rather than deriving parquet keys from observation keys — a
given observation's rows may have moved into a merged file. Nothing is lost;
`obs_ts` still identifies the observation each row came from.

## Parquet schema (`jobs`)

One row per (package × build job), written only when it differs from the previous
observation — see [Rows are stored as changes](#rows-are-stored-as-changes-not-snapshots).

| column | type | notes |
|---|---|---|
| `universe` | STRING | `bioc` \| `bioc-release` |
| `obs_ts` | STRING | ISO timestamp of the observation |
| `package` | STRING | |
| `version` | STRING | package version at that observation |
| `sha256` | STRING | source tarball digest (`prop/{u}/cas/` key when propagated) |
| `created`, `expires` | STRING | upstream build time / artifact expiry (ISO) |
| `config` | STRING | job config: `source`, `linux-release-x86_64`, `bioc-checks`, `wasm-release`, … |
| `r` | STRING | R version the job ran, e.g. `4.6.1` |
| `check` | STRING | `OK` \| `NOTE` \| `WARNING` \| `ERROR` \| `FAIL` \| `FAILURE` \| null |
| `time` | INT32 | job wall time, seconds |
| `job` | INT64 | GitHub Actions job id |
| `artifact` | STRING | GHA artifact id of the check-log zip (may be empty) |
| `deleted` | INT32 | `1` = tombstone: this `(package, config)` is gone as of `obs_ts`; otherwise null. Absent entirely from files written before deltas landed |

Hive partitioning (`universe=`, `dt=` in paths) is redundant with the columns,
so globbing with or without `hive_partitioning` both work.

## Index entry shape

```json
{
  "edgeR": {
    "version": "4.10.1",
    "sha256": "edfb982969cc…",
    "ts": "2026-08-09T00:12:34.567Z",
    "bioccheck": "ERROR",
    "artifacts": [
      { "os": "src",   "r": "",      "sha256": "edfb98…" },
      { "os": "linux", "r": "4.6.1", "sha256": "fbece7…" },
      { "os": "mac",   "r": "4.6.1", "sha256": "00e4f9…" },
      { "os": "win",   "r": "4.6.1", "sha256": "93d826…" }
    ],
    "desc": { "Depends": "R (>= 4.1.0), limma", "License": "GPL (>=2)" },
    "meta": {
      "Title": "Empirical Analysis of Digital Gene Expression Data in R",
      "Description": "Differential expression analysis …",
      "biocViews": "GeneExpression, DifferentialExpression, …",
      "Maintainer": "Yunshun Chen <yuchen@wehi.edu.au>",
      "vignettes": [{ "filename": "edgeR.html", "title": "edgeR vignette" }],
      "commit": { "id": "fe0a5fe…", "time": 1786329705 },
      "git_url": "https://github.com/bioc/edgeR"
    },
    "archs": ["linux", "win", "mac"],
    "origin": "r-universe"
  }
}
```

`desc` carries exactly the `write_PACKAGES()` DESCRIPTION fields; `meta` the
descriptive rest (VIEWS, landing pages). Entries written before an observation
carried these fields lack them until `/reindex` runs after a fresh poll.

`bioccheck` is the advisory BiocCheck verdict at propagation time — recorded,
never gating. Each artifact's bytes are at `prop/{universe}/cas/{sha256}`.

`meta.git_url` is where the package's source is built from, taken from the
universe's own `.gitmodules` (or the official VIEWS for a seeded entry). For a
Bioconductor package this is a `github.com/bioc/*` **read-only mirror** of
`git.bioconductor.org`, or that git server itself — never a maintainer's
development repo, so it is not somewhere a pull request can go. It is filled on
propagation, on seeding, and for existing entries by `/reindex`.

`origin` says where the entry came from: `r-universe` for anything that passed
the gate, `bioconductor` for an entry seeded from Bioconductor's own release
build. A seeded entry has an empty `archs` and a null `bioccheck` because it
never faced this gate at all — without `origin` it would be indistinguishable
from a gate verdict that was never made. Entries written before the field
existed are propagations and read as `r-universe`.
