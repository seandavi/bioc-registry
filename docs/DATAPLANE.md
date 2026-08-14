# The Bioconductor data plane: producer contract

"The data plane" is a contract, not a repo. bioc-registry is one producer —
the build/propagation/package-metadata one. Download statistics, site data
snapshots, and any future producer publish from their own homes under the
same rules, and a future gateway (`data.bioconductor.org`-style) can front
any of them by prefix without merging codebases.

## The contract

1. **Artifacts over HTTP GET.** Everything a consumer needs is a plain
   object fetchable by URL — JSON for indexes and state, parquet for
   history, raw bytes for content-addressed artifacts. No SDK, no auth for
   reads.
2. **Documented keys, stable shapes.** Storage keys and record shapes are
   part of the API. Document them (here: `docs/api.md` + `/openapi.json`);
   never change a shape in place — add fields, tolerate absences.
   Consumers must accept both old and new records (see `archs`/`meta` on
   index entries, absent on entries written before those fields existed).
3. **Immutable where possible.** Write-once keys (observations, parquet,
   CAS, logs) are served with immutable cache headers; only pointers
   (`state/…`, indexes) are rewritten. Idempotent, replayable writes:
   every derived artifact is a pure function of an identified input (here,
   a digest-keyed observation).
4. **CORS open, Range supported.** `Access-Control-Allow-Origin: *` and
   Range/HEAD on data routes, so browsers and remote DuckDB/httpfs are
   first-class consumers.
5. **Fields that never change vs fields that always change.** Archive
   stable data (metadata, verdicts, provenance); leave volatile signals
   (download counts, stars) to live queries by consumers who want them.
   Volatile fields in archived inputs are digest churn — exclude them.
6. **Side-effecting routes are guarded.** Reads are open; anything that
   writes or triggers work requires a shared secret and stays out of the
   published spec.
7. **Producers fail alone.** A producer being down must not break another
   producer or any consumer's build beyond degrading its own data
   (consumers treat live queries as best-effort; archived artifacts keep
   serving).

## Current producers

| producer | artifacts | home |
|---|---|---|
| bioc-registry | observations, jobs parquet, prop index + CAS, PACKAGES/VIEWS, GHA logs | this repo |
| download stats | monthly parquet of raw access logs; per-package count artifacts (planned publish step) | private infra repo (ingestion is bound to private logging config) |
| site data snapshots | `astro/data` + assets tarballs consumed by site CI | published from pipeline runs (bioconductor-website) |
