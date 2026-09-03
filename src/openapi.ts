// Hand-written OpenAPI spec for the public read-only surface, plus the /docs page
// that renders it. See CLAUDE.md: a route change is not done until this and
// docs/api.md are updated with it — nothing here is generated, so nothing breaks
// loudly when it drifts.
//
// Deliberately omitted: /poll, /backfill, /reindex, /seed, /publish. They are
// side-effecting routes gated only by a shared secret, and a try-it button next
// to /backfill (or /publish) is an invitation. See docs/api.md for these instead.

const UNIVERSE = {
  name: "universe",
  in: "path",
  required: true,
  description: "r-universe instance to read.",
  schema: { type: "string", enum: ["bioc", "bioc-release"], default: "bioc" },
} as const;

const html = (description: string) => ({
  description,
  content: { "text/html": { schema: { type: "string" } } },
});

const notFound = { description: "Unknown universe, package, or path." };

export const OPENAPI = {
  openapi: "3.1.0",
  info: {
    title: "bioc-registry",
    version: "1.0.0",
    description:
      "Tracks r-universe builds for the Bioconductor universes, archives the history " +
      "(upstream artifacts carry a ~3 month expiry), and serves the packages that pass " +
      "the propagation gate as a real CRAN repository.\n\n" +
      "Everything below is GET, unauthenticated, and CORS-open. Data endpoints stream " +
      "objects straight out of R2, so a response is exactly the stored object — this " +
      "API adds Range and CORS plumbing, not transformation.",
  },
  servers: [{ url: "https://bioc-registry.seandavi.workers.dev" }],
  tags: [
    { name: "repo", description: "CRAN-layout repository of propagated packages." },
    { name: "data", description: "Raw archived objects and the observation history." },
    { name: "pages", description: "Server-rendered HTML." },
  ],
  paths: {
    "/repo/{universe}/src/contrib/PACKAGES": {
      get: {
        tags: ["repo"],
        summary: "Source package index (DCF)",
        description:
          "The PACKAGES index generated from the propagation index. Point R at the " +
          "parent: `install.packages(\"S4Vectors\", repos=\"https://bioc-registry.seandavi.workers.dev/repo/bioc\")`.\n\n" +
          "`PACKAGES.gz` is served at the same path with gzip encoding. There is " +
          "deliberately no `PACKAGES.rds` (available.packages falls back to the gz) and " +
          "no `MD5sum` field, since r-universe exposes sha256 only.",
        parameters: [UNIVERSE],
        responses: {
          200: { description: "DCF index.", content: { "text/plain": { schema: { type: "string" } } } },
          404: notFound,
        },
      },
    },
    "/repo/{universe}/VIEWS": {
      get: {
        tags: ["repo"],
        summary: "VIEWS metadata index (DCF)",
        description:
          "The VIEWS file the legacy Bioconductor repositories published at the repo root: " +
          "every PACKAGES field plus Title/Description/biocViews/Author/Maintainer/URL/" +
          "BugReports/SystemRequirements/VignetteBuilder/Date, git provenance " +
          "(git_last_commit, git_last_commit_date), per-platform artifact paths " +
          "(source.ver, win.binary.ver, mac.binary.ver), vignettes/vignetteTitles, and " +
          "first-order reverse dependencies within the propagated set (dependsOnMe, " +
          "importsMe, suggestsMe).\n\n" +
          "`VIEWS.gz` is served at the same path with gzip encoding. Omitted because this " +
          "data plane cannot know them: MD5sum, Rank, dependencyCount, hasREADME/hasNEWS/" +
          "hasINSTALL/hasLICENSE, Rfiles, htmlDocs, htmlTitles.",
        parameters: [UNIVERSE],
        responses: {
          200: { description: "DCF metadata index.", content: { "text/plain": { schema: { type: "string" } } } },
          404: notFound,
        },
      },
    },
    "/repo/{universe}/src/contrib/{file}": {
      get: {
        tags: ["repo"],
        summary: "Source tarball",
        description: "Resolved through the content-addressed store; the bytes are the upstream artifact.",
        parameters: [
          UNIVERSE,
          {
            name: "file",
            in: "path",
            required: true,
            description: "`{package}_{version}.tar.gz` exactly as listed in PACKAGES.",
            schema: { type: "string", example: "S4Vectors_0.50.1.tar.gz" },
          },
        ],
        responses: {
          200: { description: "Package tarball.", content: { "application/gzip": { schema: { type: "string", format: "binary" } } } },
          404: { description: "Not in the propagation index for this universe." },
        },
      },
    },
    "/repo/{universe}/bin/windows/contrib/{r}/{file}": {
      get: {
        tags: ["repo"],
        summary: "Windows binary",
        description:
          "Binaries propagate per architecture family: a package appears here only if its " +
          "Windows checks passed, independently of whether its macOS build did.",
        parameters: [
          UNIVERSE,
          { name: "r", in: "path", required: true, description: "R minor version.", schema: { type: "string", example: "4.7" } },
          { name: "file", in: "path", required: true, schema: { type: "string", example: "S4Vectors_0.50.1.zip" } },
        ],
        responses: { 200: { description: "Zip archive." }, 404: notFound },
      },
    },
    "/repo/{universe}/bin/macosx/{arch}/contrib/{r}/{file}": {
      get: {
        tags: ["repo"],
        summary: "macOS binary",
        parameters: [
          UNIVERSE,
          {
            name: "arch",
            in: "path",
            required: true,
            description: "CRAN-style arch directory; matched against the artifact's bare arch.",
            schema: { type: "string", enum: ["big-sur-arm64", "big-sur-x86_64"], default: "big-sur-arm64" },
          },
          { name: "r", in: "path", required: true, schema: { type: "string", example: "4.7" } },
          { name: "file", in: "path", required: true, schema: { type: "string", example: "S4Vectors_0.50.1.tgz" } },
        ],
        responses: { 200: { description: "Tgz archive." }, 404: notFound },
      },
    },
    "/manifest.json": {
      get: {
        tags: ["data"],
        summary: "Observation parquet keys",
        description:
          "Every parquet file of per-job build results, one per archived observation. " +
          "Feed these to /data/{key} — the /sql page reads exactly this list with DuckDB-WASM.",
        responses: {
          200: {
            description: "R2 keys, newest last.",
            content: {
              "application/json": {
                schema: { type: "array", items: { type: "string" } },
                example: ["parquet/jobs/universe=bioc/dt=2026-08-11/2026-08-11T06:45:26.708Z-46efec79cb9c.parquet"],
              },
            },
          },
        },
      },
    },
    "/data/{key}": {
      get: {
        tags: ["data"],
        summary: "Raw archived object",
        description:
          "Streams an object out of the bucket verbatim. Supports Range and HEAD, which is " +
          "what lets DuckDB-WASM read parquet footers without pulling whole files.\n\n" +
          "Useful keys: `state/{universe}/latest` (pointer to the newest observation), " +
          "`obs/{universe}/dt={date}/{ts}-{digest}.json` (a full r-universe snapshot, ~19MB), " +
          "`prop/{universe}/index.json` (the propagation index), " +
          "`logs/{universe}/{job}.txt` (captured build log).",
        parameters: [
          {
            name: "key",
            in: "path",
            required: true,
            description: "Full R2 key. Contains slashes — they are part of the key, not path separators.",
            schema: { type: "string", default: "state/bioc/latest" },
          },
        ],
        responses: {
          200: { description: "The stored object." },
          206: { description: "Partial content, when a Range header was sent." },
          404: { description: "No such key." },
        },
      },
    },
    "/logs/{universe}/{job}": {
      get: {
        tags: ["data"],
        summary: "Captured build log",
        description:
          "The GitHub Actions job log, served from our archive rather than proxied. Job ids " +
          "come from `_jobs[].job` in an observation, or from the package page.\n\n" +
          "Capture walks forward from when it was switched on, so jobs older than that are " +
          "404 here — GitHub deletes them at ~90 days, which is the reason for capturing at all.",
        parameters: [
          UNIVERSE,
          { name: "job", in: "path", required: true, schema: { type: "string", pattern: "^\\d+$", example: "93666921965" } },
        ],
        responses: {
          200: { description: "Plain-text log.", content: { "text/plain": { schema: { type: "string" } } } },
          404: { description: "Not captured; the response body links to GitHub while it still has it." },
        },
      },
    },
    "/checks/{universe}/{job}": {
      get: {
        tags: ["data"],
        summary: "Captured check logs",
        description:
          "R CMD check's own output for one job, extracted from the job's GitHub Actions " +
          "artifact — which is where it lives, not in the job log `/logs` serves.\n\n" +
          "An object keyed by file basename. Typically `00check.log` (the verdict and every " +
          "failing section), `00install.out` (that platform's build log), `*-Ex.Rout` (the " +
          "example transcript, `.fail` when examples errored) and `tests/*.Rout`; on the " +
          "`bioc-checks` config, `00BiocCheck.log` and `output.log`; on wasm, `build.log`.\n\n" +
          "Capture walks forward from when it was switched on, and the upstream artifacts " +
          "expire at ~100 days, so anything older is 404 here permanently.",
        parameters: [
          UNIVERSE,
          { name: "job", in: "path", required: true, schema: { type: "string", pattern: "^\\d+$", example: "91651624895" } },
        ],
        responses: {
          200: {
            description: "Log files for that job, keyed by basename.",
            content: {
              "application/json": {
                schema: { type: "object", additionalProperties: { type: "string" } },
                example: { "00check.log": "* checking examples ... ERROR\n…", "00install.out": "* installing *source* package …" },
              },
            },
          },
          404: { description: "Not captured; the response body links to the GitHub run." },
        },
      },
    },
    "/builds/{universe}/{job}": {
      get: {
        tags: ["data"],
        summary: "Build manifest",
        description:
          "What the build ran with: the container image pinned by digest, the repositories " +
          "dependencies were resolved from, and the resolved version of every one of them — " +
          "parsed out of the job log at capture time.\n\n" +
          "This is what makes a failure reproducible. Nothing else records the installed " +
          "versions, and a check that broke without the package changing broke because a " +
          "dependency moved. Note the repos include p3m's moving `.../latest`, which pins " +
          "nothing on its own — `deps` is the record of what it meant that day.\n\n" +
          "Derived from the job log, so it exists exactly where `/logs` does.",
        parameters: [
          UNIVERSE,
          { name: "job", in: "path", required: true, schema: { type: "string", pattern: "^\\d+$", example: "91651011049" } },
        ],
        responses: {
          200: {
            description: "Image, repositories, and resolved dependency versions.",
            content: {
              "application/json": {
                schema: {
                  type: "object",
                  properties: {
                    image: { type: "string", description: "Container image pinned by digest." },
                    repos: { type: "array", items: { type: "string" } },
                    deps: { type: "object", additionalProperties: { type: "string" }, description: "package -> resolved version" },
                  },
                },
                example: {
                  image: "ghcr.io/r-universe-org/build-source@sha256:b9a53fe82cfe…",
                  repos: ["https://p3m.dev/all/__linux__/resolute/latest"],
                  deps: { abind: "1.4-8", bit64: "4.8.2" },
                },
              },
            },
          },
          404: { description: "Not captured; the response body points at the job log." },
        },
      },
    },
    "/": { get: { tags: ["pages"], summary: "Dashboard", responses: { 200: html("Per-universe build and propagation summary.") } } },
    "/pkg/{universe}/{package}": {
      get: {
        tags: ["pages"],
        summary: "Package page",
        description: "Current jobs, propagation entry, and a parquet-backed history pivot.",
        parameters: [
          UNIVERSE,
          { name: "package", in: "path", required: true, schema: { type: "string", default: "S4Vectors" } },
        ],
        responses: { 200: html("Package detail."), 404: { description: "Not in the latest observation." } },
      },
    },
    "/sql": { get: { tags: ["pages"], summary: "SQL console", responses: { 200: html("DuckDB-WASM console over the observation parquet.") } } },
  },
} as const;

// Scalar renders the spec and gives every route a try-it panel. Loaded from CDN:
// vendoring it would mean shipping ~500KB of JS in the Worker bundle to save one
// external request on a docs page.
export const DOCS_PAGE = `<!doctype html>
<html>
  <head>
    <title>bioc-registry API</title>
    <meta charset="utf-8" />
    <meta name="viewport" content="width=device-width, initial-scale=1" />
  </head>
  <body>
    <div id="app"></div>
    <script src="https://cdn.jsdelivr.net/npm/@scalar/api-reference"></script>
    <script>
      Scalar.createApiReference('#app', { url: '/openapi.json', theme: 'default' })
    </script>
  </body>
</html>
`;
