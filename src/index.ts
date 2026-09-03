import { WorkflowEntrypoint, WorkflowStep, WorkflowEvent } from "cloudflare:workers";
import { parquetWriteBuffer } from "hyparquet-writer";
import { parquetReadObjects } from "hyparquet";
import {
  Artifact, Desc, Family, Meta, PropIndex, PKG_EXT, SeedArtifact, MAC_X86_DIR,
  approveByDeps, describe, findArtifact, macArmDir, metaOf, originOf, packagesDcf, parseDcf,
  parseGitmodules, parseRepoDir, passingFamilies, pendingArtifacts, pendingJobIds,
  planCompaction, parseZipCentral, isLogEntry, buildManifest,
  invisible, mergeMeta, mergeRows, seedArtifacts, seedDesc, seedMeta, verGt,
  viewsDcf, writeOnce, JobRow, RowState,
  validatePublish, upsertEntry, mergeAttempt, AttemptRecord,
} from "./repo.js";
import { DOCS_PAGE, OPENAPI } from "./openapi.js";

const UNIVERSES = ["bioc", "bioc-release"];
// Build-relevant fields only: full body is ~70MB and includes volatile fields
// (_score, _stars) that would make the digest churn on every poll.
// _failure: when a newer commit fails, the main record keeps showing the last
// successful build — the failure is ONLY visible in this field.
// The unprefixed fields ARE the parsed DESCRIPTION and feed PACKAGES directly —
// except the dependency fields, which r-universe normalises out of the top level
// into _dependencies [{package, version, role}]. Priority/OS_type are usually
// absent (only set when the DESCRIPTION sets them); requesting them is harmless.
// NB: adding fields changes the digest, so the first poll after this re-archives
// and re-fires every universe once.
const FIELDS =
  "Version,License,NeedsCompilation,Priority,OS_type,_dependencies,_file," +
  "_sha256,_status,_jobs,_created,_expires,_fileid,_binaries,_commit,_failure,_buildurl," +
  // Descriptive metadata for VIEWS and the site's landing pages. All of these
  // change only when the package itself changes, so the digest stays quiet.
  "Title,Description,Author,Maintainer,URL,BugReports,SystemRequirements,Date," +
  "biocViews,VignetteBuilder,_vignettes," +
  // What it takes to reproduce a check, and what the check artifact does not say.
  // _sysdeps carries system library versions (libtbb12 2022.3.0-2, …), _distro the
  // builder's Ubuntu codename, and RemoteUrl/Ref/Sha the exact source pin — the
  // 40-char sha, where _commit.id is abbreviated. Bioconductor's build system
  // publishes the equivalent as NodeInfo + R-instpkgs, and drops R-instpkgs the
  // moment a release is archived, so mirroring it here is the whole point.
  "_sysdeps,_distro,RemoteUrl,RemoteRef,RemoteSha," +
  // _devurl is the maintainer's actual development repository (present for 1,432
  // of 2,419), as opposed to git_url's read-only github.com/bioc mirror. It is the
  // only field here that says where a fix could be sent.
  "_upstream,_devurl," +
  // _bioccheck is BiocCheck's counts — {error, warning, note} — where the index's
  // own bioccheck is just the job's pass/fail verdict.
  "_bioccheck,_bioc,_filesize,_cranurl,Config/Bioconductor/UnsupportedPlatforms";
// Deliberately excluded: _downloads and _score change continuously, so they would
// make every poll a fresh digest and turn ~16 observations a day into 96. _help
// (29MB) and _exports (5.8MB) would more than double the observation to archive
// what an MCP server can ask r-universe for at query time.

export interface Env {
  ARCHIVE: R2Bucket;
  OBSERVE: Workflow;
  // Secret. Required in the x-maint-key header by /poll, /reindex and
  // /backfill when set; leave unset locally to keep dev friction at zero.
  MAINT_KEY?: string;
  // Secret. GHA job-log downloads 403 without auth (job *metadata* is public; only
  // the log body needs a token). Used by captureLogs on the cron path ONLY — never
  // on a public route, so an incoming request can't drive it against GitHub.
  GITHUB_TOKEN?: string;
}

async function poll(universe: string, env: Env): Promise<string> {
  const res = await fetch(
    `https://${universe}.r-universe.dev/api/packages?limit=100000&fields=${FIELDS}`
  );
  if (!res.ok) throw new Error(`${universe}: HTTP ${res.status}`);
  const body = await res.arrayBuffer();
  const digest = [...new Uint8Array(await crypto.subtle.digest("SHA-256", body))]
    .map((b) => b.toString(16).padStart(2, "0"))
    .join("");

  const last = await env.ARCHIVE.get(`state/${universe}/latest`);
  if (last && (await last.json<{ digest: string }>()).digest === digest) {
    return `${universe}: unchanged ${digest.slice(0, 12)}`;
  }

  const ts = new Date().toISOString();
  const key = `obs/${universe}/dt=${ts.slice(0, 10)}/${ts}-${digest.slice(0, 12)}.json`;
  await env.ARCHIVE.put(key, body);
  await env.ARCHIVE.put(`state/${universe}/latest`, JSON.stringify({ digest, key, ts }));

  try {
    // Digest-as-ID: exactly one workflow instance per distinct upstream state.
    await env.OBSERVE.create({
      id: `${universe}-${digest.slice(0, 32)}`,
      params: { universe, key, digest, ts },
    });
  } catch (e) {
    // Duplicate instance (digest reverted to a previously seen state) — already reacted.
    if (!String(e).includes("already exists")) throw e;
  }
  return `${universe}: archived ${key}`;
}

// ---------- log capture ----------
// GHA deletes job logs at ~90 days, which makes them the second unrecoverable
// thing here after the artifacts. Capture runs on the cron and walks forward from
// a stored high-water mark; see pendingJobIds for why one integer is enough state.
// 200/run against a 15-minute cron is 19,200/day per universe, against ~1.5k/day
// of new job ids — the surplus is what drains the backlog (see issue #4: capture
// walks oldest-first, so until that changes throughput is the only lever).
// Two ceilings this stays under, now shared with captureChecks below: GitHub
// allows 5,000 req/hr per token, and the two captures over both universes spend
// ~1,600 + ~800; a cron invocation makes ~1,200 subrequests here and ~1,600 there,
// against the 10,000 default on Workers paid.
const LOGS_PER_RUN = 200;

async function captureLogs(universe: string, env: Env): Promise<string> {
  // Trimmed because the obvious way to set this secret — piping `gcloud secrets
  // versions access` into `wrangler secret put` — stores the trailing newline,
  // and a header value containing one throws "Invalid header value" on every
  // fetch. That failure is invisible: capture is best-effort, so the only
  // symptom is a logcursor that never moves.
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) return `${universe}: capture skipped (no GITHUB_TOKEN)`;
  const last = await env.ARCHIVE.get(`state/${universe}/latest`);
  if (!last) return `${universe}: capture skipped (no observation yet)`;
  const { key } = await last.json<{ key: string }>();
  const obs = await env.ARCHIVE.get(key);
  if (!obs) return `${universe}: capture skipped (${key} missing)`;

  const cur = await env.ARCHIVE.get(`state/${universe}/logcursor`);
  const cursor = cur ? (await cur.json<{ job: number }>()).job : 0;
  const ids = pendingJobIds(await obs.json(), cursor, LOGS_PER_RUN);
  if (!ids.length) return `${universe}: logs current at ${cursor}`;

  let mark = cursor;
  let saved = 0;
  for (const job of ids) {
    const gh = await fetch(
      `https://api.github.com/repos/r-universe/${universe}/actions/jobs/${job}/logs`,
      { headers: { "user-agent": "bioc-registry", authorization: `Bearer ${token}` } }
    );
    // Out of budget: stop without advancing, so these ids are retried next run.
    if (gh.status === 403 && gh.headers.get("x-ratelimit-remaining") === "0") break;
    // Anything else terminal (404/410 = already expired upstream) is unrecoverable,
    // so let the mark pass it rather than wedging the cursor on a dead job.
    if (gh.ok) {
      const log = await gh.text();
      await env.ARCHIVE.put(`logs/${universe}/${job}.txt`, log);
      const manifest = buildManifest(log);
      // Skipped when it found nothing: a log with no install section says nothing
      // about the build, and an empty manifest would read as "no dependencies"
      // rather than "not recorded".
      if (manifest.image || Object.keys(manifest.deps).length)
        await env.ARCHIVE.put(`builds/${universe}/${job}.json`, JSON.stringify(manifest), {
          httpMetadata: { contentType: "application/json" },
        });
      saved++;
    }
    mark = job;
  }
  if (mark > cursor) await env.ARCHIVE.put(`state/${universe}/logcursor`, JSON.stringify({ job: mark }));
  return `${universe}: captured ${saved}/${ids.length} logs, cursor ${mark}`;
}

// ---------- check-log capture ----------
// captureLogs stores the GHA *job* log: the runner's own output — docker pulls,
// dependency installs, compiler noise. A 9.1MB one measured here holds six
// "* checking" lines and no check verdict at all. What a maintainer actually reads
// is in the job's uploaded artifact:
//
//   00check.log      R CMD check's verdict and every failing section
//   00install.out    the build log for that platform
//   *-Ex.Rout        the example transcript (.fail when examples errored)
//   tests/*.Rout     the test transcript (.Rout.fail when tests errored)
//   00BiocCheck.log  BiocCheck's report, on the bioc-checks config
//   build.log        wasm builds
//
// These expire with the artifact — the observation's _expires is the deadline,
// ~100 days out — so a missed one is unrecoverable, exactly like a job log.
//
// The artifact is a zip holding up to 7.6MB of built package around ~65KB of that
// text (measured across 24 jobs: mean 65KB, max 356KB). Fetching them whole would
// be ~11GB/day, so only the text entries are pulled: HEAD for the length, one
// range for the central directory at the end, one per wanted entry. The blob host
// the API redirects to honours ranges but NOT the suffix form — `bytes=-65536`
// comes back 200 with the entire file — which is why the length is looked up
// rather than assumed.
const CHECKS_PER_RUN = 100;
const ZIP_TAIL = 64 * 1024;
// A local file header repeats the name and carries its own extra field, so the
// data does not begin where the central directory alone can say. Over-fetching by
// this much and reading the real lengths costs ~1KB an entry against a second
// round trip for every one of them.
const ZIP_HEADER_SLACK = 1024;
// Upstream text, so it needs a ceiling: one pathological transcript must not take
// down the isolate that is also running poll and compaction.
const MAX_LOG_BYTES = 4_000_000;

const ghHeaders = (token: string) => ({ "user-agent": "bioc-registry", authorization: `Bearer ${token}` });

// Null for anything terminal (expired, missing, malformed). Throws only when the
// run should stop and retry later, which the caller turns into a break.
async function fetchCheckLogs(
  universe: string, artifact: string, token: string
): Promise<Record<string, string> | null> {
  // The API answers 302 to a signed blob URL, and that URL — not the API — is
  // what serves ranges, so the hop is taken by hand instead of followed.
  const res = await fetch(
    `https://api.github.com/repos/r-universe/${universe}/actions/artifacts/${artifact}/zip`,
    { headers: ghHeaders(token), redirect: "manual" }
  );
  if (res.status === 403 && res.headers.get("x-ratelimit-remaining") === "0")
    throw new Error("rate limited");
  // 404/410 is terminal — the artifact expired or never existed — and the cursor
  // should move past it. Anything else without a redirect is NOT terminal, and
  // must throw: a silent null there would march the cursor through the whole
  // backlog marking every job unavailable, burning the one chance to capture it.
  if (res.status === 404 || res.status === 410) return null;
  const url = res.headers.get("location");
  if (!url) throw new Error(`artifact ${artifact}: no redirect (HTTP ${res.status})`);

  const head = await fetch(url, { method: "HEAD" });
  const total = Number(head.headers.get("content-length") ?? 0);
  if (!total) return null;

  const from = Math.max(0, total - ZIP_TAIL);
  const tail = await fetch(url, { headers: { range: `bytes=${from}-${total - 1}` } });
  if (!tail.ok) return null;
  const entries = parseZipCentral(new Uint8Array(await tail.arrayBuffer()), from);
  if (!entries) return null;

  const logs: Record<string, string> = {};
  for (const e of entries) {
    if (!isLogEntry(e.name) || e.size > MAX_LOG_BYTES) continue;
    const end = Math.min(total - 1, e.offset + 30 + ZIP_HEADER_SLACK + e.compressed);
    const part = await fetch(url, { headers: { range: `bytes=${e.offset}-${end}` } });
    if (!part.ok) continue;
    const buf = new Uint8Array(await part.arrayBuffer());
    const start = 30 + (buf[26] | (buf[27] << 8)) + (buf[28] | (buf[29] << 8));
    if (start + e.compressed > buf.length) continue; // slack was not enough
    const data = buf.subarray(start, start + e.compressed);
    const bytes = e.method === 0
      ? data
      : new Uint8Array(
          await new Response(
            new Response(data).body!.pipeThrough(new DecompressionStream("deflate-raw"))
          ).arrayBuffer()
        );
    // Flattened: "GeneGA.Rcheck/00check.log" and "tests/testthat.Rout.fail" are
    // unambiguous by basename, and the .Rcheck prefix is just the package name.
    logs[e.name.split("/").pop()!] = new TextDecoder().decode(bytes);
  }
  return logs;
}

async function captureChecks(universe: string, env: Env): Promise<string> {
  const token = env.GITHUB_TOKEN?.trim();
  if (!token) return `${universe}: check capture skipped (no GITHUB_TOKEN)`;
  const last = await env.ARCHIVE.get(`state/${universe}/latest`);
  if (!last) return `${universe}: check capture skipped (no observation yet)`;
  const { key } = await last.json<{ key: string }>();
  const obs = await env.ARCHIVE.get(key);
  if (!obs) return `${universe}: check capture skipped (${key} missing)`;

  const cur = await env.ARCHIVE.get(`state/${universe}/checkcursor`);
  const cursor = cur ? (await cur.json<{ job: number }>()).job : 0;
  const jobs = pendingArtifacts(await obs.json(), cursor, CHECKS_PER_RUN);
  if (!jobs.length) return `${universe}: check logs current at ${cursor}`;

  let mark = cursor, saved = 0, empty = 0;
  for (const { job, artifact } of jobs) {
    let logs: Record<string, string> | null;
    try {
      logs = await fetchCheckLogs(universe, artifact, token);
    } catch {
      break; // rate limited or transient: stop without advancing, retry next run
    }
    if (logs && Object.keys(logs).length) {
      await env.ARCHIVE.put(`checks/${universe}/${job}.json`, JSON.stringify(logs), {
        httpMetadata: { contentType: "application/json" },
      });
      saved++;
    } else {
      // Expired or artifact-less: unrecoverable, so let the mark move past it
      // rather than wedging the cursor on a job that will never yield anything.
      empty++;
    }
    mark = job;
  }
  if (mark > cursor)
    await env.ARCHIVE.put(`state/${universe}/checkcursor`, JSON.stringify({ job: mark }));
  return `${universe}: captured ${saved} check logs${empty ? `, ${empty} unavailable` : ""}, cursor ${mark}`;
}

// Capture is best-effort: a GitHub outage must not fail the poll it rides with,
// and the cursors mean the skipped ids are simply picked up next run.
const capture = (env: Env) =>
  UNIVERSES.flatMap((u) => [
    captureLogs(u, env).catch((e) => `${u}: capture failed: ${e}`),
    captureChecks(u, env).catch((e) => `${u}: check capture failed: ${e}`),
  ]);

// ---------- parquet ----------

// One schema, shared by the per-observation writer and the compactor so a column
// added to one cannot go missing from the other.
const PQ_COLS = [
  "universe", "obs_ts", "package", "version", "sha256", "created", "expires",
  "config", "r", "check", "time", "job", "artifact", "deleted",
] as const;
type PqCol = (typeof PQ_COLS)[number];

const parquetBuf = (col: Record<PqCol, unknown[]>) =>
  parquetWriteBuffer({
    columnData: PQ_COLS.map((name) => ({
      name,
      data: col[name],
      type: name === "time" || name === "deleted" ? "INT32" : name === "job" ? "INT64" : "STRING",
    })),
  });

// obs/bioc/dt=2026-08-08/2026-08-08T19:01:50.388Z-acd8dfc2015f.json
//   -> parquet/jobs/universe=bioc/dt=2026-08-08/2026-08-08T19:01:50.388Z-acd8dfc2015f.parquet
const parquetKeyFor = (obsKey: string) =>
  obsKey
    .replace(/^obs\/([^/]+)\//, "parquet/jobs/universe=$1/")
    .replace(/\.json$/, ".parquet");

async function writeJobsParquet(env: Env, obsKey: string): Promise<string> {
  const pqKey = parquetKeyFor(obsKey);
  if (await env.ARCHIVE.head(pqKey)) return `exists ${pqKey}`;
  const obs = await env.ARCHIVE.get(obsKey);
  if (!obs) throw new Error(`missing observation ${obsKey}`);
  const pkgs = await obs.json<FullPkg[]>();
  const universe = obsKey.split("/")[1];
  const obsTs = obsKey.split("/").pop()!.slice(0, 24);

  const rows: JobRow[] = [];
  for (const p of pkgs) {
    for (const j of p._jobs ?? []) {
      rows.push({
        package: p.Package, config: j.config,
        version: p.Version ?? null, sha256: p._sha256 ?? null,
        created: p._created ?? null, expires: p._expires ?? null,
        r: j.r ?? null, check: j.check ?? null, time: j.time ?? null,
        job: j.job != null ? BigInt(j.job) : null, artifact: j.artifact || null,
      });
    }
  }

  // Only observations newer than the state may advance it. /backfill and workflow
  // retries can hand us an older one, and diffing that against a future state
  // would record changes that never happened — so those write a full snapshot,
  // which is redundant but correct for a carry-forward reader.
  const st = await env.ARCHIVE.get(`state/${universe}/rowstate`);
  const prev = st ? await st.json<{ ts: string; rows: RowState }>() : null;
  const inOrder = !prev || obsTs > prev.ts;
  const { changed, state } = inOrder
    ? mergeRows(prev?.rows ?? {}, rows)
    : { changed: rows, state: null };

  const col = {} as Record<PqCol, unknown[]>;
  for (const n of PQ_COLS) col[n] = [];
  for (const r of changed) {
    col.universe.push(universe); col.obs_ts.push(obsTs); col.package.push(r.package);
    col.version.push(r.version); col.sha256.push(r.sha256);
    col.created.push(r.created); col.expires.push(r.expires);
    col.config.push(r.config); col.r.push(r.r); col.check.push(r.check);
    col.time.push(r.time); col.job.push(r.job); col.artifact.push(r.artifact);
    col.deleted.push(r.deleted ?? null);
  }
  // Parquet before state: a crash in between leaves the state stale, so the retry
  // recomputes the same delta and rewrites the same key. State first would lose
  // the rows entirely.
  await env.ARCHIVE.put(pqKey, parquetBuf(col));
  if (state) await env.ARCHIVE.put(`state/${universe}/rowstate`, JSON.stringify({ ts: obsTs, rows: state }));
  // A zero-change observation writes no rows, so without this list it leaves no
  // trace and a reader cannot tell "not observed" from "nothing changed".
  // ponytail: rewrites a growing array each time — ~350KB after a year at 40/day,
  // so the O(n) rewrite is cheaper than any structure that avoids it.
  const seen = await env.ARCHIVE.get(`state/${universe}/observations.json`);
  const all = new Set(seen ? await seen.json<string[]>() : []);
  all.add(obsTs);
  await env.ARCHIVE.put(
    `state/${universe}/observations.json`,
    JSON.stringify([...all].sort()),
    { httpMetadata: { contentType: "application/json" } }
  );
  return `wrote ${pqKey} (${changed.length}/${rows.length} rows${inOrder ? "" : ", full: out of order"})`;
}

// ---------- compaction ----------
// One parquet per observation means DuckDB opens every file before it reads a
// row — 200+ already, climbing ~40/day, at roughly 3 range requests each. Merging
// each closed day down to one file per universe holds that at 2/day.
//
// ponytail: merges a bounded slice per cron run rather than a whole day at once.
// The bound is bytes: file count is a bad proxy once merged files exist, and six
// of those decoded to ~560k rows and killed the Worker (1102), stalling poll and
// capture with it. ~3MB is ~120k rows. Note this
// only shrinks file COUNT — every observation is a full snapshot differing from
// the last by ~600 job ids, so the real win is writing changed rows only, which
// costs the pivot queries a carry-forward.
const COMPACT_MAX_BYTES = 3_000_000;

async function compactParquet(universe: string, env: Env): Promise<string> {
  const prefix = `parquet/jobs/universe=${universe}/`;
  // ponytail: one page is ~500 days once compaction is caught up, and the oldest
  // day sorts first regardless. Paginate if that ever stops being true.
  const list = await env.ARCHIVE.list({ prefix, limit: 1000 });
  const plan = planCompaction(
    list.objects.map((o) => ({ key: o.key, size: o.size })),
    new Date().toISOString().slice(0, 10),
    COMPACT_MAX_BYTES
  );
  if (!plan) return `${universe}: nothing to compact`;

  const col = {} as Record<PqCol, unknown[]>;
  for (const n of PQ_COLS) col[n] = [];
  for (const key of plan.sources) {
    const obj = await env.ARCHIVE.get(key);
    if (!obj) continue;
    for (const row of await parquetReadObjects({ file: await obj.arrayBuffer() }))
      for (const n of PQ_COLS) col[n].push((row as Record<string, unknown>)[n] ?? null);
  }
  await env.ARCHIVE.put(plan.out, parquetBuf(col));
  // The output can be one of the sources when the oldest was already a merge; it
  // has just been rewritten as a superset, so deleting it here would lose data.
  const drop = plan.sources.filter((k) => k !== plan.out);
  if (drop.length) await env.ARCHIVE.delete(drop);
  return `${universe}: merged ${plan.sources.length} files of ${plan.day} into ${plan.out} (${col.package.length} rows)`;
}

const compact = (env: Env) =>
  UNIVERSES.map((u) => compactParquet(u, env).catch((e) => `${u}: compaction failed: ${e}`));

// ---------- manifest backfill ----------
// captureLogs writes a manifest alongside each log it captures, but it only ever
// walks forward, so the ~52,000 logs already in the bucket would never get one —
// reproducibility data for the last few days instead of for the whole archive,
// which is the gap this project exists to not have.
//
// A one-time drain, and a cron pass rather than a maintenance route: it needs no
// human to run it, adds no side-effecting GET, and reads only from our own R2, so
// nothing here is racing an upstream expiry. It walks the key listing rather than
// job ids from an observation, because logs exist for jobs that have long since
// dropped out of the current one. The list cursor IS the state — when a page
// comes back untruncated the walk is over and every later run no-ops.
//
// ponytail: 25 a run drains ~52k in ~11 days. Small because the only real cost is
// CPU spent regexing logs that reach 9MB, and nothing is waiting on this.
const MANIFESTS_PER_RUN = 25;

async function backfillManifests(universe: string, env: Env): Promise<string> {
  const stateKey = `state/${universe}/manifestbackfill`;
  const st = await env.ARCHIVE.get(stateKey);
  const state = st ? await st.json<{ cursor?: string; done?: boolean }>() : {};
  if (state.done) return `${universe}: manifest backfill complete`;

  const prefix = `logs/${universe}/`;
  const page = await env.ARCHIVE.list({ prefix, limit: MANIFESTS_PER_RUN, cursor: state.cursor });
  let wrote = 0;
  for (const o of page.objects) {
    const job = o.key.slice(prefix.length).replace(/\.txt$/, "");
    // A key that is not a job id writes nothing rather than a garbage manifest.
    if (!/^\d+$/.test(job)) continue;
    const log = await env.ARCHIVE.get(o.key);
    if (!log) continue;
    const manifest = buildManifest(await log.text());
    // Same rule as capture: an empty manifest would read as "no dependencies"
    // rather than "this log had no install section".
    if (!manifest.image && !Object.keys(manifest.deps).length) continue;
    // Rewritten unconditionally where capture already wrote one — the input is the
    // same log, so the output is identical, and a HEAD per key to find out would
    // cost more than the put.
    await env.ARCHIVE.put(`builds/${universe}/${job}.json`, JSON.stringify(manifest), {
      httpMetadata: { contentType: "application/json" },
    });
    wrote++;
  }
  await env.ARCHIVE.put(
    stateKey,
    JSON.stringify(page.truncated ? { cursor: page.cursor } : { done: true })
  );
  return `${universe}: manifests ${wrote}/${page.objects.length}` +
    (page.truncated ? "" : " (backfill complete)");
}

const backfill = (env: Env) =>
  UNIVERSES.map((u) => backfillManifests(u, env).catch((e) => `${u}: manifest backfill failed: ${e}`));

// ---------- propagation ----------
// Gate: build succeeded, and checks pass on AT LEAST ONE architecture (linux,
// mac, windows) — per-family verdicts from the BBS-equivalent gating jobs, see
// passingFamilies() in repo.ts. Only the passing families' binaries propagate;
// the rest are simply not available. The source tarball always propagates with
// an eligible package. Which R line gates shifts with the R release cycle, so
// it is resolved from bioconductor.org/config.yaml (r_ver_for_bioc_ver) at
// evaluate time, and jobs are matched on their actual R version — not on
// config-name labels. bioc-checks (BiocCheck), wasm, other R lines and
// off-gate chips are advisory: tracked, never blocking; the BiocCheck verdict
// is recorded in the index.
// Package -> source repo, from the universe's own .gitmodules (see #8): one
// ~200KB fetch covers every package, so there is no per-package lookup. Best
// effort — a GitHub blip must not fail a propagation, it just leaves git_url
// unset until the next pass.
async function gitUrls(universe: string): Promise<Record<string, string>> {
  const res = await fetch(
    `https://raw.githubusercontent.com/r-universe/${universe}/HEAD/.gitmodules`
  );
  if (!res.ok) throw new Error(`.gitmodules: HTTP ${res.status}`);
  return parseGitmodules(await res.text());
}

async function gatingRMinor(universe: string): Promise<string> {
  const res = await fetch("https://bioconductor.org/config.yaml");
  if (!res.ok) throw new Error(`config.yaml: HTTP ${res.status}`);
  const y = await res.text();
  const branch = universe === "bioc" ? "devel" : "release";
  const biocVer = y.match(new RegExp(`^${branch}_version: "([\\d.]+)"`, "m"))?.[1];
  const rMinor =
    biocVer && y.split("r_ver_for_bioc_ver:")[1]?.match(new RegExp(`"${biocVer}": "(\\d+\\.\\d+)"`))?.[1];
  if (!rMinor) throw new Error(`cannot resolve gating R version for ${universe} (bioc ${biocVer})`);
  return rMinor;
}

const R_VER = /^\d+([.-]\d+)*$/;
const BATCH = 20;

type Candidate = {
  package: string; version: string; sha256: string;
  bioccheck: string | null; artifacts: Artifact[]; desc: Desc; meta: Meta;
  archs: Family[];
};

async function readIndex(env: Env, universe: string): Promise<PropIndex> {
  const o = await env.ARCHIVE.get(`prop/${universe}/index.json`);
  return o ? await o.json<PropIndex>() : {};
}

async function evaluate(env: Env, universe: string, obsKey: string, digest: string) {
  const obs = await env.ARCHIVE.get(obsKey);
  if (!obs) throw new Error(`missing observation ${obsKey}`);
  const pkgs = await obs.json<FullPkg[]>();
  const idx = await readIndex(env, universe);
  const rMinor = await gatingRMinor(universe);
  const candidates: Candidate[] = [];
  for (const p of pkgs) {
    const jobs = p._jobs ?? [];
    if (p._status !== "success" || !jobs.length) continue;
    const archs = passingFamilies(jobs, rMinor);
    if (!archs.length) continue;
    if (!p.Version || !R_VER.test(p.Version) || !p._sha256) continue;
    const prev = idx[p.Package];
    // Version must be a strict bump over the previously propagated version.
    if (prev && !verGt(p.Version, prev.version)) continue;
    const artifacts: Artifact[] = [
      // Source always rides with an eligible package; binaries only for the
      // families whose checks passed. wasm has no gating job, so it stays
      // advisory and rides along like before.
      {
        os: "src", r: "", sha256: p._sha256,
        file: p._file || `${p.Package}_${p.Version}.tar.gz`,
      },
      ...(p._binaries ?? [])
        .filter((b) => b.status === "success" && b.fileid && b.version === p.Version)
        .filter((b) => b.os === "wasm" || archs.includes(b.os as Family))
        .map((b) => ({
          os: b.os, r: b.r ?? "", sha256: b.fileid!.split("/").pop()!,
          arch: b.arch, distro: b.distro,
          file: `${p.Package}_${p.Version}.${PKG_EXT[b.os] ?? "tar.gz"}`,
        })),
    ];
    candidates.push({
      package: p.Package, version: p.Version, sha256: p._sha256,
      bioccheck: jobs.find((j) => j.config === "bioc-checks")?.check ?? null,
      artifacts,
      desc: describe(p),
      meta: metaOf(p),
      archs,
    });
  }
  // Build gate passed; now the dependency gate (#34). Blocked candidates are
  // simply not written to pending — their version is still ahead of what is
  // published, so they are reconsidered on every later wave and land as soon as
  // whatever they are waiting on propagates.
  const { approved, blocked } = approveByDeps(candidates, idx);
  const pendingKey = `prop/${universe}/pending/${digest.slice(0, 12)}.json`;
  await env.ARCHIVE.put(pendingKey, JSON.stringify(approved));
  // Written next to pending so "why has X not propagated?" is answerable from
  // the archive rather than by re-deriving it. Only when non-empty: the steady
  // state is nothing blocked, and an empty file every wave is just noise.
  if (blocked.length)
    await env.ARCHIVE.put(
      `prop/${universe}/blocked/${digest.slice(0, 12)}.json`,
      JSON.stringify(blocked)
    );
  return { pendingKey, count: approved.length, blocked: blocked.length };
}

async function copyCas(env: Env, universe: string, sha256: string): Promise<boolean> {
  const key = `prop/${universe}/cas/${sha256}`;
  if (await env.ARCHIVE.head(key)) return false;
  const res = await fetch(`https://r2.ropensci.org/${sha256}`);
  if (!res.ok) throw new Error(`fetch ${sha256}: HTTP ${res.status}`);
  const len = Number(res.headers.get("content-length"));
  if (res.body && len) {
    const { readable, writable } = new FixedLengthStream(len);
    res.body.pipeTo(writable);
    await env.ARCHIVE.put(key, readable);
  } else {
    await env.ARCHIVE.put(key, await res.arrayBuffer());
  }
  return true;
}

async function propagateBatch(env: Env, universe: string, pendingKey: string, start: number) {
  const pending = await env.ARCHIVE.get(pendingKey);
  if (!pending) throw new Error(`missing ${pendingKey}`);
  const batch = (await pending.json<Candidate[]>()).slice(start, start + BATCH);
  const ts = new Date().toISOString();
  let copied = 0;
  for (const c of batch) {
    // 3 concurrent copies = 6 connections, the per-invocation cap
    const shas = c.artifacts.map((a) => a.sha256);
    for (let i = 0; i < shas.length; i += 3) {
      const done = await Promise.all(shas.slice(i, i + 3).map((s) => copyCas(env, universe, s)));
      copied += done.filter(Boolean).length;
    }
    await env.ARCHIVE.put(
      `prop/${universe}/log/${ts}-${c.package}_${c.version}.json`,
      JSON.stringify({ ...c, ts })
    );
  }
  // ponytail: read-modify-write; concurrent same-universe instances could clobber an
  // entry, but copies are idempotent and the next wave re-converges the index.
  const idx = await readIndex(env, universe);
  const urls = await gitUrls(universe).catch(() => ({} as Record<string, string>));
  for (const c of batch)
    idx[c.package] = {
      version: c.version, sha256: c.sha256, ts,
      bioccheck: c.bioccheck, artifacts: c.artifacts,
      desc: c.desc, meta: { ...c.meta, ...(urls[c.package] ? { git_url: urls[c.package] } : {}) },
      archs: c.archs, origin: "r-universe",
    };
  await env.ARCHIVE.put(`prop/${universe}/index.json`, JSON.stringify(idx));
  return { start, packages: batch.length, copied };
}

// ---------- one-time seed from the official Bioconductor repos ----------
// ~300 packages Bioconductor ships that have never passed this gate: they build
// in BBS and fail in r-universe's environment, mostly on external services their
// examples reach (measured: 13 of 14 sampled failures were network errors inside
// examples/tests, one a real compile failure). Seeding is strictly additive —
// it only ever fills a hole, never displaces or blocks a propagated entry, and
// the version gate is untouched, so a seeded package is replaced the ordinary
// way: the maintainer bumps the version and r-universe builds it.

const BIOC_BRANCH: Record<string, string> = { bioc: "devel", "bioc-release": "release" };
const SEED_BATCH = 10;
// Small artifacts are hashed in memory — one fetch, one pass. Anything larger is
// fetched twice instead (below), so the threshold only trades bandwidth for
// memory headroom; it is well under the 128MB isolate.
const SEED_BUFFER_MAX = 32 * 1024 * 1024;

type SeedPlan = {
  base: string;
  rMinor: string;
  packages: {
    package: string; version: string; desc: Desc; meta: Meta; artifacts: SeedArtifact[];
  }[];
};

const hex = (b: ArrayBuffer) =>
  [...new Uint8Array(b)].map((x) => x.toString(16).padStart(2, "0")).join("");

// crypto.DigestStream is a Workers runtime API. The ambient Crypto type in scope
// here is the standard one, which does not declare it — and the bare global
// `DigestStream` that the types suggest does not exist at runtime. Verified
// against workerd: `typeof DigestStream` is "undefined", `typeof
// crypto.DigestStream` is "function".
type DigestStreamCtor = new (algorithm: string) =>
  WritableStream<Uint8Array> & { digest: Promise<ArrayBuffer> };
const DigestStream =
  (crypto as unknown as { DigestStream: DigestStreamCtor }).DigestStream;

// The CAS key IS the hash, so an artifact has to be hashed before it can be
// stored — and Bioconductor publishes no checksum to hash against. Small ones
// are buffered. Large ones are streamed twice: once through a DigestStream to
// learn the sha256, once into R2. SwathXtend's source tarball is 346MB, nearly
// three times the isolate's memory ceiling, so this is a real package and not a
// hypothetical one.
async function copySeedArtifact(
  env: Env, universe: string, url: string
): Promise<string | null> {
  const res = await fetch(url);
  if (!res.ok) return null;
  const len = Number(res.headers.get("content-length"));

  // An unknown length takes the streaming path: buffering something that turns
  // out to be a 346MB tarball kills the isolate, and streaming is safe at any
  // size.
  if (len && len <= SEED_BUFFER_MAX) {
    const body = await res.arrayBuffer();
    const sha256 = hex(await crypto.subtle.digest("SHA-256", body));
    const key = `prop/${universe}/cas/${sha256}`;
    if (!(await env.ARCHIVE.head(key))) await env.ARCHIVE.put(key, body);
    return sha256;
  }

  // Counted while digesting, so the second pass has an exact length even when
  // the response carried no content-length.
  let size = 0;
  const counter = new TransformStream<Uint8Array, Uint8Array>({
    transform(chunk, ctrl) { size += chunk.byteLength; ctrl.enqueue(chunk); },
  });
  const digest = new DigestStream("SHA-256");
  await res.body!.pipeThrough(counter).pipeTo(digest);
  const sha256 = hex(await digest.digest);
  const key = `prop/${universe}/cas/${sha256}`;
  if (await env.ARCHIVE.head(key)) return sha256;

  const second = await fetch(url);
  if (!second.ok || !second.body) return null;
  const { readable, writable } = new FixedLengthStream(size);
  second.body.pipeTo(writable);
  await env.ARCHIVE.put(key, readable);
  return sha256;
}

async function fetchText(url: string): Promise<string> {
  const r = await fetch(url);
  if (!r.ok) throw new Error(`${url}: HTTP ${r.status}`);
  return r.text();
}

// The plan is computed once (VIEWS is 5MB, plus three binary PACKAGES) and
// stored, so the ~30 batch invocations that follow do not re-fetch 8MB apiece.
// It also makes the run auditable: what we intended to seed, before we did.
async function seedPlan(env: Env, universe: string): Promise<SeedPlan> {
  const key = `prop/${universe}/seed/plan.json`;
  const cached = await env.ARCHIVE.get(key);
  if (cached) return cached.json<SeedPlan>();

  const base = `https://bioconductor.org/packages/${BIOC_BRANCH[universe]}/bioc`;
  const rMinor = await gatingRMinor(universe);
  const [views, win, macArm, macX86] = await Promise.all([
    fetchText(`${base}/VIEWS`),
    fetchText(`${base}/bin/windows/contrib/${rMinor}/PACKAGES`),
    fetchText(`${base}/bin/macosx/${macArmDir(rMinor)}/contrib/${rMinor}/PACKAGES`),
    fetchText(`${base}/bin/macosx/${MAC_X86_DIR}/contrib/${rMinor}/PACKAGES`),
  ]);
  const versions = (dcf: string) =>
    new Map(parseDcf(dcf).map((r) => [r.Package, r.Version]));
  const w = versions(win), ma = versions(macArm), mx = versions(macX86);

  const idx = await readIndex(env, universe);
  // Absent from the index, or present but invisible: an entry with no recorded
  // DESCRIPTION is skipped by PACKAGES and VIEWS, so it cannot be installed by
  // name and nothing outside can tell it exists (#6). Replacing one with a
  // described, installable entry takes nothing away — but never with an older
  // version than the one already recorded.
  const packages = parseDcf(views)
    .filter((v) => v.Package && v.Version)
    .filter((v) => {
      const e = idx[v.Package];
      return !e || (invisible(e) && !verGt(e.version, v.Version));
    })
    .map((v) => ({
      package: v.Package,
      version: v.Version,
      desc: seedDesc(v),
      meta: seedMeta(v),
      artifacts: seedArtifacts(v.Package, v.Version, rMinor, {
        win: w.get(v.Package) === v.Version,
        macArm: ma.get(v.Package) === v.Version,
        macX86: mx.get(v.Package) === v.Version,
      }),
    }));
  const plan: SeedPlan = { base, rMinor, packages };
  await env.ARCHIVE.put(key, JSON.stringify(plan));
  // Every official version, not just the seedable ones (~60KB against the plan's
  // several MB), so the dashboard can show how far seeded entries have drifted
  // without re-fetching a 5MB VIEWS on every page load.
  await env.ARCHIVE.put(
    `prop/${universe}/seed/official-versions.json`,
    JSON.stringify(Object.fromEntries(parseDcf(views).map((v) => [v.Package, v.Version])))
  );
  return plan;
}

async function seedBatch(
  env: Env, universe: string, start: number, refresh: boolean
): Promise<string> {
  if (refresh) await env.ARCHIVE.delete(`prop/${universe}/seed/plan.json`);
  const plan = await seedPlan(env, universe);
  const batch = plan.packages.slice(start, start + SEED_BATCH);
  if (!batch.length)
    return `${universe}: seed complete (${plan.packages.length} planned)`;

  const before = await readIndex(env, universe);
  const ts = new Date().toISOString();
  const seeded: { package: string; entry: PropIndex[string] }[] = [];
  let copied = 0, already = 0, missing = 0, repaired = 0;

  for (const p of batch) {
    // A package that gained a real gate verdict since the plan was written keeps
    // it; only an invisible entry may still be replaced.
    const prev = before[p.package];
    if (prev && !invisible(prev)) { already++; continue; }
    const artifacts: Artifact[] = [];
    for (const a of p.artifacts) {
      // A binary can vanish between plan and fetch; the package still seeds
      // with whatever else it has.
      const sha256 = await copySeedArtifact(env, universe, `${plan.base}/${a.path}`);
      if (!sha256) { missing++; continue; }
      copied++;
      artifacts.push({ os: a.os, r: a.r, arch: a.arch, sha256, file: a.file });
    }
    const src = artifacts.find((a) => a.os === "src");
    // No source tarball is not a repo entry: PACKAGES would advertise a file
    // that cannot be downloaded.
    if (!src) continue;
    if (prev) repaired++;
    seeded.push({
      package: p.package,
      entry: {
        version: p.version, sha256: src.sha256, ts,
        // Empty archs and null bioccheck are the honest values: this entry
        // never faced the gate. origin is what says so.
        bioccheck: null, artifacts, desc: p.desc, meta: p.meta, archs: [],
        origin: "bioconductor",
      },
    });
  }

  const idx = await readIndex(env, universe);
  for (const s of seeded) {
    await env.ARCHIVE.put(
      `prop/${universe}/log/${ts}-${s.package}_${s.entry.version}.json`,
      JSON.stringify({ package: s.package, ...s.entry })
    );
    idx[s.package] = s.entry;
  }
  if (seeded.length) await env.ARCHIVE.put(`prop/${universe}/index.json`, JSON.stringify(idx));

  const next = start + SEED_BATCH;
  return `${universe}: seeded ${seeded.length}, ${copied} artifacts copied` +
    `${repaired ? `, ${repaired} replaced an invisible entry` : ""}` +
    `${already ? `, ${already} already propagated` : ""}` +
    `${missing ? `, ${missing} artifacts missing upstream` : ""}` +
    ` — next start=${next} of ${plan.packages.length}`;
}

// ---------- CRAN-layout repo ----------

// Fills desc/file on index entries written before those were recorded, using the
// latest observation. Entries whose propagated version no longer matches upstream
// are left alone: their DESCRIPTION is gone from the API and guessing it would put
// the wrong dependencies in PACKAGES. Those re-enter on their next propagation.
async function reindex(universe: string, env: Env): Promise<string> {
  const last = await env.ARCHIVE.get(`state/${universe}/latest`);
  if (!last) return `${universe}: no observations`;
  const meta = await last.json<{ key: string }>();
  const obs = await env.ARCHIVE.get(meta.key);
  if (!obs) return `${universe}: missing ${meta.key}`;
  const byName = new Map((await obs.json<FullPkg[]>()).map((p) => [p.Package, p]));
  const idx = await readIndex(env, universe);
  const urls = await gitUrls(universe).catch(() => ({} as Record<string, string>));
  let renamed = 0, desc = 0, stale = 0, nodesc = 0, linked = 0;
  for (const [name, e] of Object.entries(idx)) {
    const p = byName.get(name);
    // Binaries are only described by the observation while it still reports the
    // version we propagated; a rebuild changes the sha256 and the match is lost.
    const current = p && p.Version === e.version ? p : undefined;
    const bins = new Map(
      (current?._binaries ?? []).filter((b) => b.fileid).map((b) => [b.fileid!.split("/").pop()!, b])
    );
    for (const a of e.artifacts) {
      // Recomputed unconditionally rather than filled-if-missing: an earlier
      // release named every binary .tar.gz, having assumed _binaries[].os was
      // "windows"/"macos" when it is really "win"/"mac".
      const want = a.os === "src" && current?._file
        ? current._file
        : `${name}_${e.version}.${PKG_EXT[a.os] ?? "tar.gz"}`;
      if (a.file !== want) { a.file = want; renamed++; }
      a.arch ??= bins.get(a.sha256)?.arch;
    }
    // git_url comes from the universe's .gitmodules, not the observation, so it
    // is filled for stale entries too — knowing where a package's source lives
    // is exactly what you want for one that stopped propagating.
    if (urls[name] && e.meta?.git_url !== urls[name]) {
      e.meta = { ...(e.meta ?? {}), git_url: urls[name] };
      linked++;
    }
    if (!current) { stale++; continue; }
    const d = describe(current);
    // An observation archived before FIELDS carried the DESCRIPTION yields {}.
    // Leave desc unset so this entry stays out of PACKAGES and a later reindex
    // (after a fresh poll) retries it, rather than freezing in a bare state.
    if (Object.keys(d).length) { e.desc = d; desc++; } else nodesc++;
    // Same rule for the descriptive metadata (VIEWS/landing pages): only set
    // from an observation that actually carried the fields.
    // Replace, don't merge: a field dropped upstream should disappear here too.
    // git_url is the exception — it comes from .gitmodules, not the observation,
    // so a wholesale replace would drop the link that was just made.
    const m = metaOf(current);
    if (Object.keys(m).length) e.meta = mergeMeta(m, e.meta);
  }
  await env.ARCHIVE.put(`prop/${universe}/index.json`, JSON.stringify(idx));
  return `${universe}: described ${desc}, renamed ${renamed}, stale ${stale}, ` +
    `linked ${linked}, no-description-in-observation ${nodesc}, ` +
    `total ${Object.keys(idx).length}`;
}

// ---------- dashboard ----------

type FullPkg = {
  Package: string; Version?: string; _sha256?: string; _created?: string; _expires?: string;
  _status?: string;
  License?: string; NeedsCompilation?: string; Priority?: string; OS_type?: string;
  Title?: string; Description?: string; Author?: string; Maintainer?: string;
  URL?: string; BugReports?: string; SystemRequirements?: string; Date?: string;
  biocViews?: string; VignetteBuilder?: string;
  _vignettes?: { filename?: string; title?: string }[];
  _commit?: { id?: string; time?: number };
  _file?: string;
  _dependencies?: { package: string; version?: string; role: string }[];
  _binaries?: {
    r?: string; os: string; version?: string; fileid?: string; status?: string;
    arch?: string; distro?: string;
  }[];
  _jobs?: { job?: number; config: string; r?: string; check?: string; time?: number; artifact?: string }[];
  _failure?: { version?: string; commit?: { id?: string; time?: number }; buildurl?: string };
  // The workflow run that _jobs came from. Needed to link a job on github.com,
  // which has no URL form that takes a job id alone.
  _buildurl?: string;
  // Reproduction inputs. _sysdeps is only on the ~16% of packages that need a
  // system library; _devurl only where the maintainer declared one.
  _sysdeps?: { name?: string; package?: string; version?: string; source?: string; shlib?: string }[];
  _distro?: string;
  RemoteUrl?: string; RemoteRef?: string; RemoteSha?: string;
  _upstream?: string; _devurl?: string;
  _bioccheck?: { error?: number; warning?: number; note?: number };
  _bioc?: { branch?: string; version?: string; bioc?: string }[];
  _filesize?: number;
  _cranurl?: string | false;
  "Config/Bioconductor/UnsupportedPlatforms"?: string;
};
type Pkg = { Package: string; _jobs?: { config: string; check: string }[] };

type Summary = {
  universe: string;
  ts: string;
  digest: string;
  packages: number;
  notPropagated: string[];
  configs: Record<string, Record<string, number>>;
  recentObs: { key: string; size: number }[];
  obsCount: string;
  propagated: number;
  seeded: number;
  // Seeded entries the official repo has since moved past. A seed is frozen
  // until r-universe propagates the package, so this only grows; visible beats
  // silent drift, and beats re-seeding on a timer.
  seedBehind: number;
  // Entries from bioc-build (issue #12): never faced this gate either, but unlike
  // a seed they DID build and check somewhere — just not through r-universe. Kept
  // out of `propagated` and `seeded` so neither count silently absorbs them.
  built: number;
  rMinor: string;
};

async function summarize(universe: string, env: Env): Promise<Summary | null> {
  const last = await env.ARCHIVE.get(`state/${universe}/latest`);
  if (!last) return null;
  const meta = await last.json<{ digest: string; key: string; ts: string }>();
  const obs = await env.ARCHIVE.get(meta.key);
  if (!obs) return null;
  const pkgs = await obs.json<Pkg[]>();

  const configs: Record<string, Record<string, number>> = {};
  for (const p of pkgs) {
    for (const j of p._jobs ?? []) {
      const c = (configs[j.config] ??= {});
      c[j.check] = (c[j.check] ?? 0) + 1;
    }
  }
  // ponytail: single list call, caps at 1000 observations; paginate when we get there
  const list = await env.ARCHIVE.list({ prefix: `obs/${universe}/`, limit: 1000 });
  // Counting packages with ANY ERROR/FAILURE job contradicted the gate: it was
  // dominated by bioc-checks, which the gate treats as advisory (BBS policy). What
  // actually matters is which observed packages never made it into the index — a
  // set difference, not a subtraction, so index entries for packages that have left
  // the universe cannot make the count go negative.
  const idx = await readIndex(env, universe);
  const notPropagated = pkgs.map((p) => p.Package).filter((n) => !idx[n]).sort();
  // Seeded entries never passed the gate, so folding them into one number would
  // make the propagation rate improve by ~300 without a single package earning
  // it. Counted apart, and labelled apart on the dashboard.
  const entries = Object.entries(idx);
  const seededEntries = entries.filter(([, e]) => originOf(e) === "bioconductor");
  const builtEntries = entries.filter(([, e]) => originOf(e) === "bioc-build");
  const seeded = seededEntries.length;
  const built = builtEntries.length;
  const propagated = entries.length - seeded - built;
  const official = await env.ARCHIVE.get(`prop/${universe}/seed/official-versions.json`);
  const officialVer = official ? await official.json<Record<string, string>>() : {};
  const seedBehind = seededEntries
    .filter(([n, e]) => officialVer[n] && verGt(officialVer[n], e.version)).length;
  return {
    universe,
    ts: meta.ts,
    digest: meta.digest,
    packages: pkgs.length,
    notPropagated,
    // Shown in the gating-criteria panel, so it must be the value the gate really
    // used rather than a hardcoded one; the bioc->R mapping shifts with the R
    // release cycle. A config.yaml outage degrades the panel, not the dashboard.
    rMinor: await gatingRMinor(universe).catch(() => "unresolved"),
    configs,
    recentObs: list.objects.slice(-8).reverse().map((o) => ({ key: o.key, size: o.size })),
    obsCount: list.truncated ? "1000+" : String(list.objects.length),
    propagated,
    seeded,
    seedBehind,
    built,
  };
}

const STATUS_ORDER = ["OK", "NOTE", "WARNING", "ERROR", "FAILURE"];
// Status palette (validated, mode-invariant): OK→good WARNING→warning ERROR→serious FAIL/FAILURE→critical
const STATUS_COLOR: Record<string, string> = {
  OK: "#0ca30c",
  WARNING: "#fab219",
  ERROR: "#ec835a",
  FAIL: "#d03b3b",
  FAILURE: "#d03b3b",
};

const THEME = (maxw: number) => `
  :root { --surface:#fcfcfb; --page:#f9f9f7; --ink:#0b0b0b; --ink2:#52514e; --muted:#898781; --line:#e5e4e0;
    --link:#0a66c2; }
  @media (prefers-color-scheme: dark) {
    :root { --surface:#1a1a19; --page:#0d0d0d; --ink:#ffffff; --ink2:#c3c2b7; --muted:#898781; --line:#33322f;
      --link:#79b8ff; }
  }
  * { box-sizing:border-box; margin:0 }
  /* Without this every page falls back to the UA's #0000EE, which is near-black on
     the light palette and clashes with the warm greys. An author rule on the bare
     element also beats the UA's a:visited purple, so one line covers both states. */
  a { color:var(--link) }
  body { background:var(--page); color:var(--ink); font:15px/1.5 system-ui,sans-serif; max-width:${maxw}px; margin:0 auto; padding:24px 16px }`;

const esc = (s: string) =>
  s.replace(/[&<>"]/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;" }[c]!));

// github.com/{owner}/{repo}/runs/{id} resolves a CHECK RUN id, not an Actions job
// id — different id spaces that collide freely, so that form silently lands on
// some unrelated package. The only URL that takes a job id needs the run id too,
// which is what _buildurl carries. No run, no link: a missing link beats a
// confidently wrong one.
const ghJob = (buildurl: string | undefined, job: number) =>
  buildurl ? ` · <a href="${esc(buildurl)}/job/${job}">gh</a>` : "";

const age = (ts: string, now: number) => {
  const m = Math.round((now - Date.parse(ts)) / 60000);
  return m < 60 ? `${m}m ago` : m < 1440 ? `${Math.round(m / 60)}h ago` : `${Math.round(m / 1440)}d ago`;
};

function universeHtml(s: Summary, now: number): string {
  const statuses = [
    ...STATUS_ORDER.filter((st) => Object.values(s.configs).some((c) => c[st])),
    ...[...new Set(Object.values(s.configs).flatMap(Object.keys))]
      .filter((st) => !STATUS_ORDER.includes(st))
      .sort(),
  ];
  const rows = Object.keys(s.configs)
    .sort()
    .map((cfg) => {
      const cells = statuses
        .map((st) => {
          const n = s.configs[cfg][st] ?? 0;
          const dot = n && STATUS_COLOR[st] ? `<i style="background:${STATUS_COLOR[st]}"></i>` : "";
          return `<td class="${n ? "" : "zero"}">${dot}${n}</td>`;
        })
        .join("");
      return `<tr><th>${esc(cfg)}</th>${cells}</tr>`;
    })
    .join("");

  return `<section>
  <h2>${esc(s.universe)} <span class="digest">${s.digest.slice(0, 12)}</span></h2>
  <div class="tiles">
    <div class="tile"><b>${s.packages}</b><span>packages</span></div>
    <div class="tile"><b>${s.notPropagated.length}</b><span>not propagated</span></div>
    <div class="tile"><b>${age(s.ts, now)}</b><span>last change</span></div>
    <div class="tile"><b>${s.obsCount}</b><span>observations</span></div>
    <div class="tile"><b>${s.propagated}</b><span>propagated</span></div>
    ${s.seeded ? `<div class="tile"><b>${s.seeded}</b><span>seeded from Bioconductor</span></div>` : ""}
    ${s.seedBehind ? `<div class="tile"><b>${s.seedBehind}</b><span>seeded, now behind official</span></div>` : ""}
    ${s.built ? `<div class="tile"><b>${s.built}</b><span>built by bioc-build</span></div>` : ""}
  </div>
  <table>
    <thead><tr><th>config</th>${statuses.map((st) => `<th>${esc(st)}</th>`).join("")}</tr></thead>
    <tbody>${rows}</tbody>
  </table>
  <details><summary>why are packages not propagated? <i class="info">i</i></summary>
    <p>A package propagates when <b>all</b> of the following hold. R ${esc(s.rMinor)} is the gating R for
      ${esc(s.universe)}, resolved from <a href="https://bioconductor.org/config.yaml">config.yaml</a> at
      evaluate time — the bioc&rarr;R mapping shifts with the R release cycle.</p>
    <ol>
      <li><code>_status</code> is <code>success</code> and the build reported at least one job.</li>
      <li>Checks pass on <b>at least one architecture</b>: linux, windows or mac. An architecture passes
        when its gating jobs are free of <code>ERROR</code>, <code>FAIL</code> and <code>FAILURE</code>
        (<code>NOTE</code> and <code>WARNING</code> pass). Gating jobs run R ${esc(s.rMinor)}.x on:
        <code>source</code> + linux x86_64, windows x86_64, macOS arm64 — matching what production BBS
        tests.</li>
      <li>The version is a strict bump over the version already propagated.</li>
    </ol>
    <p><b>Only the passing architectures propagate.</b> The source tarball always rides with an eligible
      package; binaries for a failing architecture are simply not available until a later version passes
      there. The passing set is recorded per entry in the index (<code>archs</code>).</p>
    <p><b>Advisory, never blocking:</b> BiocCheck (<code>bioc-checks</code>) and <code>wasm</code>, plus other R
      lines, arm64 linux, macOS x86_64 and windows arm64. These are tracked and the BiocCheck verdict is
      recorded in the index, but they cannot stop propagation — mirroring BBS, which excludes BiocCheck from
      the propagation decision. Most <code>ERROR</code>s in the table above are BiocCheck.</p></details>
  <details><summary>not propagated (${s.notPropagated.length})</summary>
    <p class="pkgs">${s.notPropagated.map((p) => `<a href="/pkg/${esc(s.universe)}/${encodeURIComponent(p)}">${esc(p)}</a>`).join(", ") || "none"}</p></details>
  <details><summary>recent observations</summary>
    <ul>${s.recentObs.map((o) => `<li>${esc(o.key)} <span class="muted">${(o.size / 1e6).toFixed(1)}MB</span></li>`).join("")}</ul></details>
</section>`;
}

function dashboardHtml(summaries: (Summary | null)[], now: number): string {
  const body = summaries
    .map((s, i) => s ? universeHtml(s, now) : `<section><h2>${UNIVERSES[i]}</h2><p>no observations yet</p></section>`)
    .join("");
  return `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bioc-registry observer</title>
<style>${THEME(880)}
  h1 { font-size:20px; margin-bottom:4px }
  h2 { font-size:17px; margin:0 0 12px }
  .sub { color:var(--ink2); margin-bottom:12px }
  .jump { margin-bottom:24px; display:flex; gap:6px }
  .jump select, .jump input, .jump button { font:14px system-ui; padding:4px 8px; border:1px solid var(--line);
    border-radius:6px; background:var(--surface); color:var(--ink) }
  section { background:var(--surface); border:1px solid var(--line); border-radius:8px; padding:16px 18px; margin-bottom:20px }
  .digest { font:12px ui-monospace,monospace; color:var(--muted); font-weight:normal }
  .tiles { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:16px }
  .tile { flex:1 1 120px; border:1px solid var(--line); border-radius:6px; padding:10px 12px }
  .tile b { display:block; font-size:22px } .tile span { color:var(--ink2); font-size:13px }
  .info { display:inline-flex; align-items:center; justify-content:center; width:15px; height:15px;
    border:1px solid var(--muted); border-radius:50%; font:italic 600 10px/1 serif; color:var(--muted);
    vertical-align:1px }
  details p { margin:8px 0; color:var(--ink2) } details ol { margin:8px 0 8px 20px; color:var(--ink2) }
  details li { margin:3px 0 } code { font:12px ui-monospace,monospace; color:var(--ink) }
  table { border-collapse:collapse; width:100%; font-size:14px }
  th, td { text-align:right; padding:5px 10px; border-bottom:1px solid var(--line) }
  tbody th { text-align:left; font-weight:500; font-family:ui-monospace,monospace; font-size:13px }
  thead th { color:var(--muted); font-weight:500 }
  td i { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px }
  td.zero { color:var(--muted) }
  details { margin-top:12px; font-size:14px } summary { cursor:pointer; color:var(--ink2) }
  .pkgs { color:var(--ink2); font-size:13px; margin-top:6px }
  ul { margin:6px 0 0 18px; font:13px ui-monospace,monospace } .muted { color:var(--muted) }
  footer { color:var(--muted); font-size:13px }
</style></head><body>
<h1>bioc-registry observer</h1>
<p class="sub">r-universe build tracking — polls every 15 min, archives on change</p>
<form class="jump" onsubmit="location='/pkg/'+this.u.value+'/'+encodeURIComponent(this.p.value.trim());return false">
  <select name="u">${UNIVERSES.map((u) => `<option>${u}</option>`).join("")}</select>
  <input name="p" placeholder="package name" required> <button>view</button>
</form>
${body}
<footer>rendered ${new Date(now).toISOString()} · <a href="/sql">sql</a> ·
repo: ${UNIVERSES.map((u) => `<a href="/repo/${u}/src/contrib/PACKAGES">${u}</a>`).join(" · ")}</footer>
</body></html>`;
}

const SQL_PAGE = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>bioc-registry sql</title>
<style>${THEME(1100)}
  h1 { font-size:20px; margin-bottom:12px }
  textarea { width:100%; height:120px; font:13px ui-monospace,monospace; color:var(--ink);
    background:var(--surface); border:1px solid var(--line); border-radius:6px; padding:10px }
  button { font:14px system-ui; padding:6px 16px; margin:8px 0; border:1px solid var(--line);
    border-radius:6px; background:var(--surface); color:var(--ink); cursor:pointer }
  #status { color:var(--muted); font-size:13px; margin-left:8px }
  .wrap { overflow-x:auto }
  table { border-collapse:collapse; font-size:13px; margin-top:8px }
  th, td { text-align:left; padding:4px 10px; border-bottom:1px solid var(--line); white-space:nowrap }
  th { color:var(--ink2); font-weight:500 } td { font-family:ui-monospace,monospace }
</style></head><body>
<h1>bioc-registry sql <a href="/" style="font-size:13px">← dashboard</a></h1>
<textarea id="q">SELECT universe, config, "check", count(*) AS n
FROM jobs GROUP BY ALL ORDER BY universe, config, "check"</textarea>
<div><button id="run">Run</button><span id="status">loading DuckDB…</span></div>
<div class="wrap" id="out"></div>
<script type="module">
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";
const status = (m) => document.getElementById("status").textContent = m;
let conn;
try {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob(['importScripts("' + bundle.mainWorker + '");'], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  conn = await db.connect();
  const files = await (await fetch("/manifest.json")).json();
  if (!files.length) { status("no parquet files yet"); }
  else {
    const urls = files.map((k) => "'" + location.origin + "/data/" + k + "'");
    // union_by_name covers files written before deltas landed, but it only unions
    // columns that SOME file has — when every file predates the change there is no
    // \`deleted\` column at all and anything referencing it fails to bind. So
    // normalise it in, and everything downstream can assume it exists.
    await conn.query("CREATE VIEW raw AS SELECT * FROM read_parquet([" +
      urls.join(",") + "], union_by_name=true)");
    const hasDel = (await conn.query("SELECT 1 FROM (DESCRIBE raw) WHERE column_name = 'deleted'")).numRows > 0;
    await conn.query("CREATE VIEW jobs_delta AS SELECT *" +
      (hasDel ? "" : ", NULL::INTEGER AS deleted") + " FROM raw");
    // Observations that changed nothing store no rows, so they exist only in this
    // list. Older observations predate the list but were stored whole, so their
    // timestamps are still recoverable from the rows themselves.
    const seen = [];
    for (const u of ${JSON.stringify(UNIVERSES)}) {
      const r = await fetch("/data/state/" + u + "/observations.json");
      if (r.ok) for (const ts of await r.json()) seen.push("('" + u + "','" + ts + "')");
    }
    await conn.query("CREATE VIEW observations AS SELECT DISTINCT universe, obs_ts FROM jobs_delta" +
      (seen.length ? " UNION SELECT * FROM (VALUES " + seen.join(",") + ") v(universe, obs_ts)" : ""));
    // jobs reconstructs the full snapshot at every observation, so queries written
    // against the old full-snapshot table keep their meaning. jobs_delta is the
    // rows as actually stored.
    await conn.query(\`CREATE VIEW jobs AS
      SELECT d.universe, o.obs_ts, d.package, d.version, d.sha256, d.created, d.expires,
             d.config, d.r, d."check", d.time, d.job, d.artifact
      FROM observations o
      JOIN (SELECT DISTINCT universe, package, config FROM jobs_delta) k USING (universe)
      ASOF JOIN jobs_delta d ON d.universe = k.universe AND d.package = k.package
        AND d.config = k.config AND d.obs_ts <= o.obs_ts
      WHERE d.deleted IS NULL\`);
    status(files.length + " file(s) → views: jobs (reconstructed), jobs_delta (as stored)");
  }
} catch (e) { status("init failed: " + e); }
async function run() {
  if (!conn) return;
  status("running…");
  const t0 = performance.now();
  try {
    const res = await conn.query(document.getElementById("q").value);
    const rows = res.toArray().slice(0, 500);
    const cols = res.schema.fields.map((f) => f.name);
    document.getElementById("out").innerHTML =
      "<table><thead><tr>" + cols.map((c) => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" +
      rows.map((r) => "<tr>" + cols.map((c) => "<td>" + String(r[c]) + "</td>").join("") + "</tr>").join("") +
      "</tbody></table>";
    status(res.numRows + " rows (" + (res.numRows > 500 ? "showing 500, " : "") + Math.round(performance.now() - t0) + "ms)");
  } catch (e) { status(String(e)); }
}
document.getElementById("run").onclick = run;
document.getElementById("q").addEventListener("keydown", (e) => {
  if ((e.metaKey || e.ctrlKey) && e.key === "Enter") run();
});
</script></body></html>`;

const checkCell = (check?: string | null) => {
  const c = check ?? "—";
  const dot = STATUS_COLOR[c] ? `<i style="background:${STATUS_COLOR[c]}"></i>` : "";
  return dot + esc(c);
};

async function pkgPage(env: Env, universe: string, name: string, now: number): Promise<Response> {
  const last = await env.ARCHIVE.get(`state/${universe}/latest`);
  const meta = last && (await last.json<{ digest: string; key: string; ts: string }>());
  const obs = meta && (await env.ARCHIVE.get(meta.key));
  if (!obs) return new Response("no observations yet", { status: 404 });
  const p = (await obs.json<FullPkg[]>()).find((x) => x.Package === name);
  if (!p) return new Response(`package ${name} not in latest ${universe} observation`, { status: 404 });
  const prop = (await readIndex(env, universe))[name];

  const rows = [...(p._jobs ?? [])]
    .sort((a, b) => a.config.localeCompare(b.config))
    .map((j) => `<tr><th>${esc(j.config)}</th><td>${esc(j.r ?? "")}</td><td>${checkCell(j.check)}</td>
      <td>${j.time != null ? j.time + "s" : ""}</td>
      <td>${j.job ? `<a href="/logs/${universe}/${j.job}">log</a>${ghJob(p._buildurl, j.job)}` : ""}</td></tr>`)
    .join("");

  const failure = p._failure
    ? `<p class="warn">newer commit failed to build${p._failure.version ? ` (version ${esc(p._failure.version)})` : ""} —
       shown results are the last successful build.${p._failure.buildurl ? ` <a href="${esc(p._failure.buildurl)}">build log</a>` : ""}</p>`
    : "";

  // A seeded entry never faced the gate, so saying "propagated" of it would be a
  // claim we did not make. Its bioccheck is null and its archs empty by
  // construction — the tiles say where it came from instead of implying a verdict.
  // A bioc-build entry (issue #12) is a third case: it never faced THIS gate
  // either, but it did build and check in bioc-build's own CI, so it keeps its
  // bioccheck tile rather than the "not gated here" one seeded entries get.
  const seeded = prop && originOf(prop) === "bioconductor";
  const builtByBiocBuild = prop && originOf(prop) === "bioc-build";
  const propOriginLabel = seeded ? "seeded" : builtByBiocBuild ? "built by bioc-build" : "propagated";
  const propHtml = prop
    ? `<div class="tile"><b>${esc(prop.version)}</b><span>${propOriginLabel} ${age(prop.ts, now)}</span></div>
       <div class="tile"><b>${prop.artifacts.length}</b><span>artifacts</span></div>
       ${seeded
         ? `<div class="tile"><b>Bioconductor</b><span>origin — not gated here</span></div>`
         : `<div class="tile"><b>${checkCell(prop.bioccheck ?? "—")}</b><span>bioccheck at prop</span></div>`}`
    : `<div class="tile"><b>—</b><span>not propagated</span></div>`;

  const seededNote = seeded
    ? `<p class="warn">This version was seeded from Bioconductor's own release build, not propagated
       through this registry's gate: it builds in BBS and fails here. It is replaced the ordinary way,
       when the maintainer bumps the version and r-universe builds it.</p>`
    : "";

  // Labelled a mirror because it is one: PRs against github.com/bioc/* go nowhere.
  const src = prop?.meta?.git_url
    ? `<p class="sub">source: <a href="${esc(prop.meta.git_url)}">${esc(prop.meta.git_url)}</a>
       <span class="muted">(mirror of git.bioconductor.org — not a pull-request target)</span></p>`
    : "";

  const artifacts = prop
    ? `<details><summary>propagated artifacts</summary>
       <ul>${prop.artifacts.map((a) => `<li><a href="/data/prop/${universe}/cas/${a.sha256}">${esc(a.os)}${a.r ? " R " + esc(a.r) : ""}</a> <span class="muted">${a.sha256.slice(0, 12)}</span></li>`).join("")}</ul></details>`
    : "";

  const html = `<!doctype html><html lang="en"><head><meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(name)} · ${esc(universe)}</title>
<style>${THEME(880)}
  h1 { font-size:20px; margin-bottom:4px } h2 { font-size:16px; margin:20px 0 8px }
  .sub { color:var(--ink2); margin-bottom:16px } .sub a { color:var(--ink2) }
  .warn { background:color-mix(in srgb, #fab219 12%, var(--surface)); border:1px solid #fab219;
    border-radius:6px; padding:8px 12px; margin-bottom:16px; font-size:14px }
  .tiles { display:flex; flex-wrap:wrap; gap:12px; margin-bottom:16px }
  .tile { flex:1 1 120px; border:1px solid var(--line); border-radius:6px; padding:10px 12px; background:var(--surface) }
  .tile b { display:block; font-size:20px } .tile span { color:var(--ink2); font-size:13px }
  .wrap { overflow-x:auto }
  table { border-collapse:collapse; width:100%; font-size:14px; background:var(--surface);
    border:1px solid var(--line); border-radius:8px }
  th, td { text-align:left; padding:5px 10px; border-bottom:1px solid var(--line); white-space:nowrap }
  tbody th { font-weight:500; font-family:ui-monospace,monospace; font-size:13px }
  thead th { color:var(--muted); font-weight:500 }
  i { display:inline-block; width:8px; height:8px; border-radius:50%; margin-right:6px }
  details { margin-top:12px; font-size:14px } summary { cursor:pointer; color:var(--ink2) }
  ul { margin:6px 0 0 18px; font:13px ui-monospace,monospace } .muted { color:var(--muted) }
  #status { color:var(--muted); font-size:13px }
</style></head><body>
<h1>${esc(name)} <span class="muted">${esc(p.Version ?? "")}</span></h1>
<p class="sub"><a href="/">← dashboard</a> · ${esc(universe)} · status ${esc(p._status ?? "?")} ·
  built ${p._created ? age(p._created, now) : "?"} · observed ${age(meta.ts, now)} ·
  <a href="https://${esc(universe)}.r-universe.dev/${encodeURIComponent(name)}">r-universe</a></p>
${failure}${seededNote}
${src}
<div class="tiles">${propHtml}</div>
<h2>current build jobs</h2>
<div class="wrap"><table>
  <thead><tr><th>config</th><th>R</th><th>check</th><th>time</th><th>links</th></tr></thead>
  <tbody>${rows || "<tr><td colspan=5>no jobs</td></tr>"}</tbody>
</table></div>
${artifacts}
<h2>history <span id="status">loading DuckDB…</span></h2>
<div class="wrap" id="hist"></div>
<script type="module">
import * as duckdb from "https://cdn.jsdelivr.net/npm/@duckdb/duckdb-wasm@1.29.0/+esm";
const status = (m) => document.getElementById("status").textContent = m;
const COLOR = ${JSON.stringify(STATUS_COLOR)};
const PKG = ${JSON.stringify(name)}, UNI = ${JSON.stringify(universe)};
try {
  const bundle = await duckdb.selectBundle(duckdb.getJsDelivrBundles());
  const workerUrl = URL.createObjectURL(new Blob(['importScripts("' + bundle.mainWorker + '");'], { type: "text/javascript" }));
  const db = new duckdb.AsyncDuckDB(new duckdb.ConsoleLogger(duckdb.LogLevel.WARNING), new Worker(workerUrl));
  await db.instantiate(bundle.mainModule, bundle.pthreadWorker);
  const conn = await db.connect();
  const files = (await (await fetch("/manifest.json")).json())
    .filter((k) => k.includes("universe=" + UNI + "/"));
  if (!files.length) { status("no parquet files yet"); }
  else {
    const urls = files.map((k) => "'" + location.origin + "/data/" + k + "'");
    await conn.query("CREATE VIEW raw AS SELECT * FROM read_parquet([" +
      urls.join(",") + "], union_by_name=true)");
    // Same normalisation as /sql: files older than the delta change have no
    // \`deleted\` column for union_by_name to find.
    const hasDel = (await conn.query("SELECT 1 FROM (DESCRIBE raw) WHERE column_name = 'deleted'")).numRows > 0;
    const res = await conn.query(
      "SELECT obs_ts, config, \\"check\\", " + (hasDel ? "deleted" : "NULL AS deleted") +
      " FROM raw WHERE package = '" + PKG.replaceAll("'", "''") + "' ORDER BY obs_ts");
    const rows = res.toArray();
    const configs = [...new Set(rows.map((r) => r.config))].sort();
    // Rows are stored only when they change, so replay them in order and carry the
    // last value forward; a tombstone drops the config again. Same walk the write
    // side is tested against.
    const obsList = await (await fetch("/data/state/" + UNI + "/observations.json"))
      .json().catch(() => []);
    const stamps = [...new Set([...rows.map((r) => r.obs_ts), ...obsList])].sort();
    const delta = {};
    for (const r of rows) (delta[r.obs_ts] ??= []).push(r);
    const byTs = {};
    const live = {};
    for (const ts of stamps) {
      for (const r of delta[ts] ?? []) {
        if (r.deleted) delete live[r.config]; else live[r.config] = r.check;
      }
      byTs[ts] = { ...live };
    }
    const cell = (c) => c == null ? "<td></td>" :
      "<td>" + (COLOR[c] ? '<i style="background:' + COLOR[c] + '"></i>' : "") + c + "</td>";
    document.getElementById("hist").innerHTML =
      "<table><thead><tr><th>observation</th>" + configs.map((c) => "<th>" + c + "</th>").join("") + "</tr></thead><tbody>" +
      Object.keys(byTs).sort().reverse().map((ts) =>
        "<tr><th>" + ts.slice(0, 16).replace("T", " ") + "</th>" + configs.map((c) => cell(byTs[ts][c])).join("") + "</tr>").join("") +
      "</tbody></table>";
    status(Object.keys(byTs).length + " observations");
  }
} catch (e) { status("history failed: " + e); }
</script></body></html>`;
  return new Response(html, { headers: { "content-type": "text/html; charset=utf-8" } });
}

// Everything served here is public and read-only, and the /docs try-it panel is
// itself a cross-origin caller — so CORS goes on in one place rather than being
// remembered (or forgotten) at each of the ~20 return points below.
//
// Cache-control defaults to no-store for the same reason. Every page here is
// generated per request, and a cached GET of /poll or /backfill reports a state
// change that never happened. Routes serving write-once bytes opt out by setting
// their own cache-control, which this leaves alone.
const IMMUTABLE = "public, max-age=31536000, immutable";

const finish = (res: Response) => {
  const out = new Response(res.body, res);
  if (!out.headers.has("access-control-allow-origin")) out.headers.set("access-control-allow-origin", "*");
  if (!out.headers.has("cache-control")) out.headers.set("cache-control", "no-store");
  return out;
};

// Annotated rather than inferred: fetch() refers to handler.route, and TS will not
// infer the type of a binding referenced inside its own initializer.
const handler: ExportedHandler<Env> & { route(req: Request, env: Env): Promise<Response> } = {
  async scheduled(_ctrl: ScheduledController, env: Env, ctx: ExecutionContext) {
    ctx.waitUntil(Promise.all([
      ...UNIVERSES.map((u) => poll(u, env)), ...capture(env), ...compact(env), ...backfill(env),
    ]));
  },
  async fetch(req: Request, env: Env): Promise<Response> {
    return finish(await handler.route(req, env));
  },
  async route(req: Request, env: Env): Promise<Response> {
    const url = new URL(req.url);
    const { pathname } = url;
    // The side-effecting maintenance routes are idempotent, but with the code
    // public "reachable if you read the source" is no protection at all: gate
    // them on a shared secret. Unset MAINT_KEY (local dev) leaves them open.
    if (
      env.MAINT_KEY &&
      (pathname === "/poll" || pathname === "/reindex" || pathname === "/backfill" ||
        pathname === "/seed" || pathname === "/publish") &&
      req.headers.get("x-maint-key") !== env.MAINT_KEY
    ) {
      return new Response("forbidden", { status: 403 });
    }
    if (pathname === "/poll") {
      const results = await Promise.all([...UNIVERSES.map((u) => poll(u, env)), ...capture(env), ...compact(env)]);
      return new Response(results.join("\n") + "\n");
    }
    if (pathname === "/publish") {
      if (req.method !== "POST") return new Response("method not allowed", { status: 405 });
      const json = (obj: unknown, status = 200) =>
        new Response(JSON.stringify(obj), { status, headers: { "content-type": "application/json" } });
      let body: unknown;
      try { body = await req.json(); } catch { return json({ error: "invalid JSON body" }, 400); }
      const v = validatePublish(body, UNIVERSES);
      if (!v.ok) return json({ error: v.reason }, 400);
      const { universe, package: pkg, run_id, attempt, entry } = v.value;
      if (entry && !(await env.ARCHIVE.head(`prop/${universe}/cas/${entry.sha256}`)))
        return json({ error: "cas object missing" }, 409);
      const ts = attempt.ts || new Date().toISOString();
      let changed = false;
      let log_key: string | undefined;
      // Log record before the index, same order as seedBatch — the ledger entry
      // for a version must exist before that version can appear as "current".
      if (entry) {
        log_key = `prop/${universe}/log/${ts}-${pkg}_${entry.version}.json`;
        await env.ARCHIVE.put(log_key, JSON.stringify({ package: pkg, run_id, ...entry, ts }));
        const idx = await readIndex(env, universe);
        const up = upsertEntry(idx, pkg, { ...entry, ts });
        changed = up.changed;
        if (changed) await env.ARCHIVE.put(`prop/${universe}/index.json`, JSON.stringify(up.idx));
      }
      const stream = universe === "bioc" ? "devel" : "release";
      const attemptsObj = await env.ARCHIVE.get("state/bioc-build/attempts.json");
      const attempts: Record<string, Record<string, AttemptRecord>> =
        attemptsObj ? await attemptsObj.json() : {};
      attempts[pkg] ??= {};
      attempts[pkg][stream] = mergeAttempt(attempts[pkg][stream], {
        commit: attempt.commit, status: attempt.status, run_id, run_url: attempt.run_url ?? "", ts,
      });
      await env.ARCHIVE.put("state/bioc-build/attempts.json", JSON.stringify(attempts));
      if (entry) {
        const publishedObj = await env.ARCHIVE.get("state/bioc-build/published.json");
        const published: Record<string, Record<string, PropIndex[string]>> =
          publishedObj ? await publishedObj.json() : {};
        published[universe] ??= {};
        published[universe][pkg] = { ...entry, ts };
        await env.ARCHIVE.put("state/bioc-build/published.json", JSON.stringify(published));
      }
      return json({ ok: true, changed, log_key });
    }
    if (pathname.startsWith("/data/")) {
      const key = decodeURIComponent(pathname.slice(6));
      const cors = { "access-control-allow-origin": "*", "access-control-expose-headers": "*" };
      // Only write-once objects may be cached: observations, parquet, captured
      // logs, CAS artifacts and ledger entries. Worth distinguishing because
      // /sql issues many range reads against the same parquet, and no-store
      // would refetch every one. Everything else is rewritten in place —
      // state/ pointers, prop/*/index.json on every propagation, the seed plan —
      // and a year-long immutable cache on those served a stale index to anyone
      // reading it through /data.
      // Applied to hits only — caching a 404 for a year would outlive the gap
      // between asking for a log and capture writing it.
      const cc = writeOnce(key) ? IMMUTABLE : "no-store";
      if (req.method === "HEAD" || req.method === "OPTIONS") {
        const head = await env.ARCHIVE.head(key);
        if (!head) return new Response(null, { status: 404, headers: cors });
        return new Response(null, {
          headers: { ...cors, "cache-control": cc, "content-length": String(head.size), "accept-ranges": "bytes" },
        });
      }
      const range = req.headers.get("range");
      const obj = await env.ARCHIVE.get(key, range ? { range: req.headers } : undefined);
      if (!obj) return new Response("not found", { status: 404, headers: cors });
      const headers = new Headers(cors);
      headers.set("accept-ranges", "bytes");
      headers.set("cache-control", cc);
      if (range && obj.range && "offset" in obj.range) {
        const { offset, length } = obj.range as { offset: number; length: number };
        headers.set("content-range", `bytes ${offset}-${offset + length - 1}/${obj.size}`);
        headers.set("content-length", String(length));
        return new Response(obj.body, { status: 206, headers });
      }
      headers.set("content-length", String(obj.size));
      return new Response(obj.body, { headers });
    }
    if (pathname === "/manifest.json") {
      const list = await env.ARCHIVE.list({ prefix: "parquet/", limit: 1000 });
      return new Response(JSON.stringify(list.objects.map((o) => o.key)), {
        headers: { "content-type": "application/json", "access-control-allow-origin": "*" },
      });
    }
    if (pathname === "/backfill") {
      // ?run=2 salts the instance IDs so a backfill can be relaunched after an
      // earlier attempt errored (same-ID re-creation throws within retention).
      const run = new URL(req.url).searchParams.get("run") ?? "";
      // Idempotent: writes parquet for any archived observation missing it, then
      // re-runs the workflow for each universe's latest observation (id includes a
      // bf- prefix so it doesn't collide with the original instance).
      const list = await env.ARCHIVE.list({ prefix: "obs/", limit: 1000 });
      const results: string[] = [];
      for (const o of list.objects) results.push(await writeJobsParquet(env, o.key));
      for (const u of UNIVERSES) {
        const last = await env.ARCHIVE.get(`state/${u}/latest`);
        if (!last) continue;
        const meta = await last.json<{ digest: string; key: string; ts: string }>();
        try {
          await env.OBSERVE.create({
            id: `bf${run}-${u}-${meta.digest.slice(0, 28)}`,
            params: { universe: u, key: meta.key, digest: meta.digest, ts: meta.ts },
          });
          results.push(`${u}: workflow bf${run}-${u}-${meta.digest.slice(0, 12)} created`);
        } catch (e) {
          if (!String(e).includes("already exists")) throw e;
          results.push(`${u}: backfill workflow already ran`);
        }
      }
      return new Response(results.join("\n") + "\n");
    }
    // /repo/<universe>/src/contrib/{PACKAGES,PACKAGES.gz,<pkg>_<ver>.tar.gz}
    // and the bin/... equivalents. install.packages(repos="…/repo/<universe>")
    if (pathname.startsWith("/repo/")) {
      const parts = pathname.slice(6).split("/").map(decodeURIComponent);
      const universe = parts.shift()!;
      if (!UNIVERSES.includes(universe)) return new Response("not found", { status: 404 });
      const tail = parts.pop() ?? "";

      // VIEWS sits at the repo root, exactly where the legacy repos kept it
      // (packages/<ver>/bioc/VIEWS): PACKAGES fields plus descriptive metadata.
      if ((tail === "VIEWS" || tail === "VIEWS.gz") && parts.length === 0) {
        const dcf = viewsDcf(await readIndex(env, universe));
        const type = { "content-type": "text/plain; charset=utf-8" };
        if (tail === "VIEWS") return new Response(dcf, { headers: type });
        return new Response(
          new Response(dcf).body!.pipeThrough(new CompressionStream("gzip")),
          { headers: { ...type, "content-encoding": "gzip" } }
        );
      }

      const sel = parseRepoDir(parts);
      if (!sel) return new Response("not found", { status: 404 });
      const idx = await readIndex(env, universe);

      if (tail === "PACKAGES" || tail === "PACKAGES.gz") {
        const dcf = packagesDcf(idx, sel);
        const type = { "content-type": "text/plain; charset=utf-8" };
        if (tail === "PACKAGES") return new Response(dcf, { headers: type });
        return new Response(
          new Response(dcf).body!.pipeThrough(new CompressionStream("gzip")),
          { headers: { ...type, "content-encoding": "gzip" } }
        );
      }
      // No PACKAGES.rds: available.packages() falls back to PACKAGES.gz, and
      // writing RDS would drag R into the serving path for one saved parse.
      if (tail === "PACKAGES.rds") return new Response("not found", { status: 404 });

      const a = findArtifact(idx, tail, sel);
      if (!a) return new Response("not found", { status: 404 });
      const obj = await env.ARCHIVE.get(`prop/${universe}/cas/${a.sha256}`);
      if (!obj) return new Response("artifact not mirrored", { status: 404 });
      return new Response(obj.body, {
        headers: {
          "content-type": "application/octet-stream",
          "content-length": String(obj.size),
          "cache-control": IMMUTABLE,
        },
      });
    }
    if (pathname === "/seed") {
      const u = url.searchParams.get("universe") ?? "";
      if (!UNIVERSES.includes(u))
        return new Response("seed: ?universe=bioc|bioc-release required\n", { status: 400 });
      const start = Math.max(0, Number(url.searchParams.get("start") ?? 0) || 0);
      const refresh = url.searchParams.get("refresh") === "1";
      return new Response(await seedBatch(env, u, start, refresh) + "\n");
    }
    if (pathname === "/reindex") {
      const results = await Promise.all(UNIVERSES.map((u) => reindex(u, env)));
      // Mutating GET: without no-store the edge caches the result and a later
      // run silently returns the previous run's counts.
      return new Response(results.join("\n") + "\n", {
        headers: { "cache-control": "no-store" },
      });
    }
    if (pathname.startsWith("/pkg/")) {
      const [u, name] = pathname.slice(5).split("/").map(decodeURIComponent);
      if (!UNIVERSES.includes(u) || !name) return new Response("not found", { status: 404 });
      return pkgPage(env, u, name, Date.now());
    }
    if (pathname.startsWith("/logs/")) {
      const [u, job] = pathname.slice(6).split("/");
      if (!UNIVERSES.includes(u) || !/^\d+$/.test(job ?? ""))
        return new Response("not found", { status: 404 });
      const text = { "content-type": "text/plain; charset=utf-8" };
      // Served from our own archive, never proxied: no token on a public route, and
      // the log stays readable long after GHA has deleted it.
      const obj = await env.ARCHIVE.get(`logs/${u}/${job}.txt`);
      // A captured log never changes; the 404 below deliberately stays no-store,
      // since it turns into a hit as soon as capture reaches that job.
      if (obj) return new Response(obj.body, { headers: { ...text, "cache-control": IMMUTABLE } });
      return new Response(
        `log not captured (capture only walks forward from when it was switched on).\n` +
          `While GHA still has it: https://github.com/r-universe/${u}/runs/${job}\n`,
        { status: 404, headers: text }
      );
    }
    if (pathname.startsWith("/checks/")) {
      const [u, job] = pathname.slice(8).split("/");
      if (!UNIVERSES.includes(u) || !/^\d+$/.test(job ?? ""))
        return new Response("not found", { status: 404 });
      const json = { "content-type": "application/json" };
      const obj = await env.ARCHIVE.get(`checks/${u}/${job}.json`);
      // One object per job rather than one per file: a caller diagnosing a failure
      // wants the check log and the transcript it points at together, and it makes
      // capture one R2 write instead of five.
      if (obj) return new Response(obj.body, { headers: { ...json, "cache-control": IMMUTABLE } });
      return new Response(
        JSON.stringify({
          error: "not captured",
          detail: "capture walks forward from when it was switched on; artifacts expire upstream at ~100 days",
          job: `https://github.com/r-universe/${u}/runs/${job}`,
        }),
        { status: 404, headers: json }
      );
    }
    if (pathname.startsWith("/builds/")) {
      const [u, job] = pathname.slice(8).split("/");
      if (!UNIVERSES.includes(u) || !/^\d+$/.test(job ?? ""))
        return new Response("not found", { status: 404 });
      const json = { "content-type": "application/json" };
      const obj = await env.ARCHIVE.get(`builds/${u}/${job}.json`);
      if (obj) return new Response(obj.body, { headers: { ...json, "cache-control": IMMUTABLE } });
      return new Response(
        JSON.stringify({
          error: "not captured",
          detail: "derived from the job log, so it exists only where /logs does",
          log: `/logs/${u}/${job}`,
        }),
        { status: 404, headers: json }
      );
    }
    if (pathname === "/sql") {
      return new Response(SQL_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/docs") {
      return new Response(DOCS_PAGE, { headers: { "content-type": "text/html; charset=utf-8" } });
    }
    if (pathname === "/openapi.json") {
      return new Response(JSON.stringify(OPENAPI), { headers: { "content-type": "application/json" } });
    }
    if (pathname !== "/") return new Response("not found", { status: 404 });
    const now = Date.now();
    const summaries = await Promise.all(UNIVERSES.map((u) => summarize(u, env)));
    return new Response(dashboardHtml(summaries, now), {
      headers: { "content-type": "text/html; charset=utf-8" },
    });
  },
};

export default handler;

type ObserveParams = { universe: string; key: string; digest: string; ts: string; offset?: number };

// Empirically an instance's engine exhausts its API-request budget around batch
// 460-480 regardless of sleeps, so an instance handles at most this many packages
// and then spawns a continuation instance for the rest.
const MAX_PER_INSTANCE = 200;

export class ObserveWorkflow extends WorkflowEntrypoint<Env, ObserveParams> {
  async run(event: WorkflowEvent<ObserveParams>, step: WorkflowStep) {
    const { universe, key, digest } = event.payload;
    const offset = event.payload.offset ?? 0;
    if (offset === 0) {
      await step.do("jobs-parquet", () => writeJobsParquet(this.env, key));
    }
    const { pendingKey, count } = await step.do(`evaluate-${offset}`, async () => {
      if (offset === 0) return evaluate(this.env, universe, key, digest);
      const pk = `prop/${universe}/pending/${digest.slice(0, 12)}.json`;
      const o = await this.env.ARCHIVE.get(pk);
      return { pendingKey: pk, count: o ? (await o.json<Candidate[]>()).length : 0 };
    });
    const end = Math.min(count, offset + MAX_PER_INSTANCE);
    for (let start = offset; start < end; start += BATCH) {
      await step.do(`propagate-${start}`, () =>
        propagateBatch(this.env, universe, pendingKey, start)
      );
      await step.sleep(`pause-${start}`, "1 second");
    }
    if (end < count) {
      await step.do("continue", async () => {
        await this.env.OBSERVE.create({
          id: `${universe}-${digest.slice(0, 24)}-c${end}`,
          params: { ...event.payload, offset: end },
        });
        return `continued at ${end}/${count}`;
      });
    }
  }
}
