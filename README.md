# bioc-registry

The Bioconductor package registry: package metadata, propagated versions,
installable artifacts, provenance, and build/check state, behind one HTTP API.
Grown from the tier-0 observer for the Bioconductor → r-universe build
propagation system; the observation → gate → index state machine is still the
core.

Scope note: this is *a* producer in the Bioconductor data plane — the
build/propagation/metadata one — not the whole plane. Other producers (download
statistics, site data snapshots) publish artifacts under the same contract
(docs/DATAPLANE.md) from their own homes.

A Cloudflare Worker polls `https://{bioc,bioc-release}.r-universe.dev/api/packages`
every 15 minutes (build-relevant fields only, ~15MB vs ~70MB full), sha256-digests
the body, and on change:

1. archives it to R2 `bioc-prop` at `obs/{universe}/dt=YYYY-MM-DD/{ts}-{digest12}.json`
2. updates `state/{universe}/latest` ({digest, key, ts})
3. creates a `bioc-prop-observe` Workflow instance with the digest as instance ID
   (exactly-once reaction per distinct upstream state)

The Workflow then runs per-observation steps:

1. `jobs-parquet` — flattens `_jobs` into `parquet/jobs/universe=…/dt=…/…​.parquet`
   (hive-partitioned; queryable with DuckDB)
2. `evaluate` — gates every package: build `_status == success`, and checks pass
   on **at least one architecture** (linux, win, mac — per-family verdicts from
   the BBS-equivalent gating jobs on the gating R line; NOTE/WARNING pass,
   ERROR/FAIL block, BiocCheck and wasm advisory). Only the passing families'
   binaries propagate — the rest are simply not available; source always rides
   with an eligible package, and the passing set is recorded as `archs` on the
   index entry. Version must parse as an R version and be a strict bump over the
   previously propagated one. Writes candidates to
   `prop/{universe}/pending/{digest}.json`.
3. `propagate-N` — batches of 20: copies each candidate's source + binary
   artifacts (all content-addressed on r2.ropensci.org) into
   `prop/{universe}/cas/{sha256}` (HEAD-first, idempotent), writes a per-package
   ledger entry under `prop/{universe}/log/`, and updates
   `prop/{universe}/index.json` (package → propagated version). release and devel
   universes are fully independent.

## Routes

- `/` — dashboard (per-universe stat tiles, config × check-status table)
- `/sql` — DuckDB-WASM query page over the parquet archive (view: `jobs`)
- `/data/<key>` — serves any R2 key with Range + CORS (DuckDB httpfs works)
- `/manifest.json` — list of parquet keys
- `/poll` — manual poll (idempotent)
- `/backfill` — write missing parquet + re-run workflow for latest observations

## Ops

- Deploy: `CLOUDFLARE_API_TOKEN=... CLOUDFLARE_ACCOUNT_ID=... npx wrangler deploy`
  (token: `cdsci-cloudflare-workers-token`, account: `cdsci-r2-account-id`,
  both in Google Secret Manager project `cdsci-infra`)
- Manual poll: `curl https://bioc-registry.seandavi.workers.dev/` (idempotent)
- Instances: `npx wrangler workflows instances list bioc-prop-observe`
- Note: `wrangler tail` shows spurious "code had hung" errors on workflow runs;
  check instance status instead — they complete fine.
