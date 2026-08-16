// node --test --experimental-strip-types src/repo.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { buildManifest, described, describe, findArtifact, gateFamily, isLogEntry, macArmDir, metaOf, originOf, packagesDcf, parseDcf, parseGitmodules, parseRepoDir, parseZipCentral, passingFamilies, matchSel, pendingArtifacts, pendingJobIds, planCompaction, mergeMeta, mergeRows, seedArtifacts, seedDesc, seedMeta, verGt, viewsDcf, writeOnce } from "./repo.ts";

const IDX = {
  S4Vectors: {
    version: "0.50.1",
    sha256: "aaa",
    ts: "2026-08-09T00:00:00Z",
    desc: {
      Depends: "R (>= 4.1.0), methods, BiocGenerics (>= 0.53.2)",
      Imports: "stats",
      License: "Artistic-2.0",
      NeedsCompilation: "yes",
    },
    // os values are r-universe's own: win/mac/linux/wasm, not windows/macosx.
    artifacts: [
      { os: "src", r: "", sha256: "aaa", file: "S4Vectors_0.50.1.tar.gz" },
      { os: "win", r: "4.7.0", sha256: "bbb", arch: "x86_64", file: "S4Vectors_0.50.1.zip" },
      { os: "win", r: "4.7.0", sha256: "bb2", arch: "aarch64", file: "S4Vectors_0.50.1.zip" },
      { os: "mac", r: "4.7.0", sha256: "ccc", arch: "aarch64", file: "S4Vectors_0.50.1.tgz" },
      { os: "linux", r: "4.6.2", sha256: "ddd", arch: "x86_64", file: "S4Vectors_0.50.1.tar.gz" },
      { os: "wasm", r: "4.6.0", sha256: "fff", file: "S4Vectors_0.50.1.tar.gz" },
    ],
  },
  // Propagated before desc was recorded — must never reach PACKAGES, since an
  // empty Depends line reads as "no dependencies".
  legacyPkg: {
    version: "1.0.0",
    sha256: "eee",
    ts: "2026-08-01T00:00:00Z",
    artifacts: [{ os: "src", r: "", sha256: "eee", file: "legacyPkg_1.0.0.tar.gz" }],
  },
};

test("describe regroups _dependencies back into DCF fields", () => {
  const d = describe({
    License: "GPL (>= 2)",
    NeedsCompilation: "yes",
    _dependencies: [
      { package: "R", version: ">= 4.1.0", role: "Depends" },
      { package: "methods", role: "Depends" },
      { package: "stats", role: "Imports" },
      { package: "knitr", role: "Suggests" },
    ],
  });
  assert.equal(d.Depends, "R (>= 4.1.0), methods");
  assert.equal(d.Imports, "stats");
  assert.equal(d.Suggests, "knitr");
  assert.equal(d.LinkingTo, undefined); // absent roles emit no field at all
  assert.equal(d.License, "GPL (>= 2)");
});

test("PACKAGES is DCF in write_PACKAGES field order, no MD5sum", () => {
  const dcf = packagesDcf(IDX, { os: "src" });
  assert.equal(dcf, [
    "Package: S4Vectors",
    "Version: 0.50.1",
    "Depends: R (>= 4.1.0), methods, BiocGenerics (>= 0.53.2)",
    "Imports: stats",
    "License: Artistic-2.0",
    "NeedsCompilation: yes",
    "File: S4Vectors_0.50.1.tar.gz",
    "",
  ].join("\n"));
  assert.ok(!dcf.includes("MD5sum"));
});

test("entries without desc are skipped, not emitted bare", () => {
  assert.ok(!packagesDcf(IDX, { os: "src" }).includes("legacyPkg"));
});

test("an EMPTY desc is skipped too — it means the data was never captured", () => {
  const idx = { ...IDX, emptyDesc: { ...IDX.legacyPkg, desc: {} } };
  const dcf = packagesDcf(idx, { os: "src" });
  assert.ok(!dcf.includes("emptyDesc"));
});

test("each binary dir picks its own artifact, by File and by sha", () => {
  const sha = (dir) => {
    const sel = parseRepoDir(dir);
    const f = packagesDcf(IDX, sel).match(/^File: (.*)$/m)?.[1];
    return f && findArtifact(IDX, f, sel)?.sha256;
  };
  assert.equal(sha(["bin", "windows", "contrib", "4.7"]), "bbb"); // x86_64, not the arm64 zip
  assert.equal(sha(["bin", "macosx", "big-sur-arm64", "contrib", "4.7"]), "ccc");
  // wrong R minor selects nothing rather than falling back to another R
  assert.equal(packagesDcf(IDX, parseRepoDir(["bin", "windows", "contrib", "4.5"])), "");
});

test("linux and wasm get no repo path — contrib.url() on Linux wants source", () => {
  assert.equal(parseRepoDir(["bin", "linux", "resolute", "4.6"]), null);
  assert.equal(parseRepoDir(["bin", "wasm", "contrib", "4.6"]), null);
});

test("repo paths parse to selectors", () => {
  assert.deepEqual(parseRepoDir(["src", "contrib"]), { os: "src" });
  assert.deepEqual(parseRepoDir(["bin", "windows", "contrib", "4.7"]),
    { os: "win", r: "4.7", arch: "x86_64" });
  assert.deepEqual(parseRepoDir(["bin", "macosx", "big-sur-arm64", "contrib", "4.7"]),
    { os: "mac", arch: "big-sur-arm64", r: "4.7" });
  assert.equal(parseRepoDir(["src"]), null);
  assert.equal(parseRepoDir(["etc", "passwd"]), null);
});

test("an arch-less binary is valid for every arch, not for none", () => {
  // A package with no compiled code builds one arch-independent binary and
  // r-universe omits the arch field entirely (~69% of binary records).
  const noarch = { os: "mac", r: "4.7.0", sha256: "zzz", file: "X_1.0.tgz" };
  assert.ok(matchSel(noarch, { os: "mac", arch: "big-sur-arm64", r: "4.7" }));
  assert.ok(matchSel(noarch, { os: "mac", arch: "big-sur-x86_64", r: "4.7" }));
});

test("mac arch normalises CRAN spelling against the bare uname", () => {
  const mac = IDX.S4Vectors.artifacts.find((a) => a.os === "mac"); // arch: aarch64
  assert.ok(matchSel(mac, { os: "mac", arch: "big-sur-arm64", r: "4.7" }));
  assert.ok(!matchSel(mac, { os: "mac", arch: "big-sur-x86_64", r: "4.7" }));
});

test("findArtifact resolves a filename within its own directory only", () => {
  assert.equal(findArtifact(IDX, "S4Vectors_0.50.1.tar.gz", { os: "src" })?.sha256, "aaa");
  assert.equal(findArtifact(IDX, "S4Vectors_0.50.1.zip", { os: "src" }), undefined);
  assert.equal(findArtifact(IDX, "nope_1.0.0.tar.gz", { os: "src" }), undefined);
});

test("planCompaction merges the oldest closed day, never today, within a byte budget", () => {
  const k = (dt, ts) => `parquet/jobs/universe=bioc/dt=${dt}/${dt}T${ts}.000Z-abc.parquet`;
  const o = (dt, ts, size = 100) => ({ key: k(dt, ts), size });
  const objs = [
    o("2026-08-11", "06:00:00"),
    o("2026-08-09", "12:00:00"), o("2026-08-09", "06:00:00"), o("2026-08-09", "18:00:00"),
    o("2026-08-10", "06:00:00"), o("2026-08-10", "07:00:00"),
  ];
  const p = planCompaction(objs, "2026-08-11", 1000)!;
  assert.equal(p.day, "2026-08-09", "oldest day first");
  assert.deepEqual(p.sources, [k("2026-08-09", "06:00:00"), k("2026-08-09", "12:00:00"), k("2026-08-09", "18:00:00")]);
  assert.equal(p.out, "parquet/jobs/universe=bioc/dt=2026-08-09/2026-08-09T06:00:00.000Z-m.parquet");

  assert.equal(planCompaction(objs, "2026-08-09", 1000)?.day, undefined, "nothing closed yet");
  assert.equal(planCompaction([o("2026-08-10", "06:00:00")], "2026-08-11", 1000), null, "single file is done");

  // Re-merging: the previous output is the oldest source, so the new file takes the
  // same key and must not be deleted as a source.
  const again = planCompaction(
    [{ key: "parquet/jobs/universe=bioc/dt=2026-08-09/2026-08-09T06:00:00.000Z-m.parquet", size: 100 },
     o("2026-08-09", "20:00:00")],
    "2026-08-11", 1000
  )!;
  assert.equal(again.out, again.sources[0]);
  assert.deepEqual(again.sources.filter((s) => s !== again.out), [k("2026-08-09", "20:00:00")]);

  // The budget caps the batch — this is what stops a merge from killing the Worker.
  assert.equal(planCompaction(objs, "2026-08-11", 250)!.sources.length, 2);

  // A file bigger than the whole budget is skipped, and the rest of its day still
  // merges. Without this an oversized day file wedges its day forever.
  const withHuge = [
    o("2026-08-09", "01:00:00", 99999), o("2026-08-09", "06:00:00"), o("2026-08-09", "12:00:00"),
  ];
  const skipped = planCompaction(withHuge, "2026-08-11", 1000)!;
  assert.deepEqual(skipped.sources, [k("2026-08-09", "06:00:00"), k("2026-08-09", "12:00:00")]);
  assert.equal(skipped.out, "parquet/jobs/universe=bioc/dt=2026-08-09/2026-08-09T06:00:00.000Z-m.parquet",
    "output is named for the oldest file actually merged, not the skipped one");

  // Only one file fits: no merge at all rather than a pointless rewrite.
  assert.equal(planCompaction([o("2026-08-09", "01:00:00", 99999), o("2026-08-09", "06:00:00")], "2026-08-11", 1000), null);

  // The stall seen in production: a previous merge sorts first and sits just under
  // the budget, so nothing else fits beside it and the day is never touched again.
  // The tail must merge into a second -m rather than the day wedging.
  const nearFull = [
    { key: k("2026-08-09", "01:00:00").replace(/-abc\.parquet$/, "-m.parquet"), size: 900 },
    o("2026-08-09", "06:00:00", 300), o("2026-08-09", "12:00:00", 300),
  ];
  const tail = planCompaction(nearFull, "2026-08-11", 1000)!;
  assert.deepEqual(tail.sources, [k("2026-08-09", "06:00:00"), k("2026-08-09", "12:00:00")]);
  assert.equal(tail.out, "parquet/jobs/universe=bioc/dt=2026-08-09/2026-08-09T06:00:00.000Z-m.parquet");

  // …and once every survivor is a near-full merge, the day is genuinely done.
  assert.equal(
    planCompaction(
      [{ key: k("2026-08-09", "01:00:00"), size: 900 }, { key: k("2026-08-09", "06:00:00"), size: 900 }],
      "2026-08-11", 1000
    ),
    null
  );
});

// A real zip built by `zip -X`: a deflated log, a deflated "tarball" standing in
// for the built package, and a stored entry. 412 bytes, so it doubles as the
// short-file case where the whole archive is smaller than the tail slab.
const FIXTURE_ZIP =
  "UEsDBBQAAAAIAKN8D12BzVauMgAAAEQBAAAWAAAAUGtnLlJjaGVjay8wMGNoZWNrLmxvZ9NSSM5ITc7OzEtXSK1I" +
  "zC3ISS1W0NPTU3ANCvIP4goqzctDkUpLzMxJTeHSGtWFpAsAUEsDBBQAAAAIAKN8D10TLUMbBwAAACwBAAAQAAAA" +
  "UGtnXzEuMC4wLnRhci5nequoGAXEAgBQSwMECgAAAAAAo3wPXeKcU6UHAAAABwAAAAsAAABwa2dkYXRhLnR4dHN0" +
  "b3JlZApQSwECHgMUAAAACACjfA9dgc1WrjIAAABEAQAAFgAAAAAAAAABAAAAoIEAAAAAUGtnLlJjaGVjay8wMGNo" +
  "ZWNrLmxvZ1BLAQIeAxQAAAAIAKN8D10TLUMbBwAAACwBAAAQAAAAAAAAAAEAAACggWYAAABQa2dfMS4wLjAudGFy" +
  "Lmd6UEsBAh4DCgAAAAAAo3wPXeKcU6UHAAAABwAAAAsAAAAAAAAAAAAAAKCBmwAAAHBrZ2RhdGEudHh0UEsFBgAA" +
  "AAADAAMAuwAAAMsAAAAAAA==";

test("parseZipCentral reads the directory without the rest of the archive", () => {
  const zip = Uint8Array.from(atob(FIXTURE_ZIP), (c) => c.charCodeAt(0));
  const entries = parseZipCentral(zip, 0)!;
  assert.deepEqual(entries.map((e) => e.name),
    ["Pkg.Rcheck/00check.log", "Pkg_1.0.0.tar.gz", "pkgdata.txt"]);
  assert.deepEqual(entries.map((e) => [e.method, e.compressed, e.size, e.offset]),
    [[8, 50, 324, 0], [8, 7, 300, 102], [0, 7, 7, 155]], "deflated and stored both read");

  // The built package is ~99% of a real artifact and must not be fetched.
  assert.deepEqual(entries.filter((e) => isLogEntry(e.name)).map((e) => e.name),
    ["Pkg.Rcheck/00check.log", "pkgdata.txt"]);

  // The point of the whole thing: given only the tail, the offsets still resolve,
  // so the caller can range-fetch the entries it wants out of a 7.6MB archive.
  const from = 150; // directory starts at 203, so this slab holds it and nothing else
  const fromTail = parseZipCentral(zip.subarray(from), from)!;
  assert.deepEqual(fromTail.map((e) => e.offset), [0, 102, 155]);

  // A slab that misses part of the directory must say so rather than return half
  // of it — the caller re-fetches a larger one.
  assert.equal(parseZipCentral(zip.subarray(340), 340), null, "directory truncated");
  assert.equal(parseZipCentral(zip.subarray(0, 100), 0), null, "no end-of-directory record");
});

// Shaped like the real thing: GHA prefixes every line with a timestamp, the image
// digest is printed away from the image name, and dependencies appear only as
// tarball URLs. Verified against two real job logs (11 and 126 deps).
const JOB_LOG = [
  "2026-07-31T12:43:40.1Z ##[group]Run docker pull ghcr.io/r-universe-org/build-source:latest",
  "2026-07-31T12:43:41.2Z latest: Pulling from r-universe-org/build-source",
  "2026-07-31T12:43:47.3Z Digest: sha256:" + "b9".repeat(32),
  "2026-07-31T12:43:50.1Z trying URL 'https://p3m.dev/all/__linux__/resolute/latest/src/contrib/abind_1.4-8.tar.gz'",
  "2026-07-31T12:43:51.2Z trying URL 'https://p3m.dev/all/__linux__/resolute/latest/src/contrib/bit64_4.8.2.tar.gz'",
  "2026-07-31T12:43:52.3Z trying URL 'https://bioc.r-universe.dev/bin/linux/resolute-x86_64/4.6/src/contrib/msa_1.45.1.tar.gz'",
  // Only Linux installs from source. Windows and macOS pull binaries, and missing
  // these left 52% of jobs with no dependency versions at all.
  "2026-07-31T12:43:53.4Z trying URL 'https://cloud.r-project.org/bin/windows/contrib/4.7/utf8_1.2.6.zip'",
  "2026-07-31T12:43:54.5Z trying URL 'https://cloud.r-project.org/bin/macosx/big-sur-arm64/contrib/4.6/pillar_1.11.1.tgz'",
  "2026-07-31T12:44:01.9Z * DONE (abind)",
].join("\n");

test("buildManifest recovers the image and resolved dependency versions", () => {
  const m = buildManifest(JOB_LOG);
  assert.equal(m.image, `ghcr.io/r-universe-org/build-source@sha256:${"b9".repeat(32)}`,
    "pinned by digest, not by the :latest tag it was pulled with");
  assert.deepEqual(m.deps,
    { abind: "1.4-8", bit64: "4.8.2", msa: "1.45.1", utf8: "1.2.6", pillar: "1.11.1" },
    "source .tar.gz, Windows .zip and macOS .tgz all parse");
  assert.deepEqual(m.repos, [
    "https://bioc.r-universe.dev",
    "https://cloud.r-project.org",
    "https://p3m.dev/all/__linux__/resolute/latest",
  ]);

  // A log with no install section must not claim the build had no dependencies —
  // captureLogs uses this emptiness to decide not to write a manifest at all.
  const none = buildManifest("2026-07-31T12:43:40.1Z nothing to see");
  assert.equal(none.image, undefined);
  assert.deepEqual(none.deps, {});
  assert.deepEqual(none.repos, []);

  // An image with no digest line is not a pin, so it is not recorded as one.
  assert.equal(buildManifest("pulled ghcr.io/r-universe-org/build-source:latest").image, undefined);

  // Windows and macOS run on GitHub-hosted runners, not in a container, so there
  // is no digest. The runner image is the only environment they can be pinned to,
  // and without this fallback half the jobs would record none at all.
  const hosted = [
    "2026-07-31T12:43:40.1Z ##[group]Runner Image",
    "2026-07-31T12:43:40.2Z Image: windows-2025-vs2026",
    "2026-07-31T12:43:40.3Z Version: 20260628.158.1",
    "2026-07-31T12:43:41.1Z trying URL 'https://cloud.r-project.org/bin/windows/contrib/4.7/utf8_1.2.6.zip'",
  ].join("\n");
  const h = buildManifest(hosted);
  assert.equal(h.image, "windows-2025-vs2026@20260628.158.1");
  assert.deepEqual(h.deps, { utf8: "1.2.6" });
});

test("pendingArtifacts carries the artifact id and skips jobs without one", () => {
  const pkgs = [
    { _jobs: [{ job: 30, artifact: "c" }, { job: 10, artifact: "a" }] },
    { _jobs: [{ job: 20, artifact: "" }, { job: 25, artifact: "b" }, { job: 10, artifact: "a" }] },
  ];
  assert.deepEqual(pendingArtifacts(pkgs, 0, 10),
    [{ job: 10, artifact: "a" }, { job: 25, artifact: "b" }, { job: 30, artifact: "c" }],
    "sorted, deduped, and job 20 has nothing to fetch");
  assert.deepEqual(pendingArtifacts(pkgs, 10, 10),
    [{ job: 25, artifact: "b" }, { job: 30, artifact: "c" }], "cursor is exclusive");
  assert.deepEqual(pendingArtifacts(pkgs, 0, 1), [{ job: 10, artifact: "a" }], "capped");
});

test("pendingJobIds walks forward from the cursor, deduped and rate-capped", () => {
  const pkgs = [
    { _jobs: [{ job: 30 }, { job: 10 }] },
    { _jobs: [{ job: 20 }, { job: 30 }] }, // same job id on two packages
    {}, // a package with no jobs at all
  ];
  assert.deepEqual(pendingJobIds(pkgs, 0, 50), [10, 20, 30]);
  assert.deepEqual(pendingJobIds(pkgs, 10, 50), [20, 30], "cursor is exclusive");
  assert.deepEqual(pendingJobIds(pkgs, 0, 2), [10, 20], "oldest first, so the cap can advance");
  assert.deepEqual(pendingJobIds(pkgs, 30, 50), [], "nothing new");
  // Job ids exceed 2^32 in practice; they must stay numbers, not sort as strings.
  assert.deepEqual(pendingJobIds([{ _jobs: [{ job: 93666921965 }, { job: 9366692196 }] }], 0, 50),
    [9366692196, 93666921965]);
});

test("gateFamily maps BBS-equivalent configs and nothing else", () => {
  assert.equal(gateFamily("source"), "linux");
  assert.equal(gateFamily("linux-release-x86_64"), "linux");
  assert.equal(gateFamily("windows-release-x86_64"), "win");
  assert.equal(gateFamily("macos-release-arm64"), "mac");
  // Advisory configs gate nothing: BiocCheck, wasm, off-gate chips.
  assert.equal(gateFamily("bioc-checks"), null);
  assert.equal(gateFamily("wasm-release"), null);
  assert.equal(gateFamily("linux-release-arm64"), null);
  assert.equal(gateFamily("windows-release-arm64"), null);
  assert.equal(gateFamily("macos-release-x86_64"), null);
});

test("one passing architecture is enough, and only it passes", () => {
  const jobs = [
    { config: "source", r: "4.6.1", check: "OK" },
    { config: "linux-release-x86_64", r: "4.6.1", check: "ERROR" },
    { config: "windows-release-x86_64", r: "4.6.1", check: "NOTE" },
    { config: "macos-release-arm64", r: "4.6.1", check: "WARNING" },
    { config: "bioc-checks", r: "4.6.1", check: "ERROR" }, // advisory, ignored
  ];
  // linux fails (its own job ERRORs even though source is OK); win and mac
  // pass on NOTE/WARNING; BiocCheck cannot block.
  assert.deepEqual(passingFamilies(jobs, "4.6"), ["win", "mac"]);
});

test("every architecture failing means no propagation", () => {
  const jobs = [
    { config: "linux-release-x86_64", r: "4.6.1", check: "ERROR" },
    { config: "windows-release-x86_64", r: "4.6.1", check: "FAIL" },
    { config: "macos-release-arm64", r: "4.6.1", check: "FAILURE" },
  ];
  assert.deepEqual(passingFamilies(jobs, "4.6"), []);
});

test("a family only passes on the gating R line, with at least one job", () => {
  const jobs = [
    { config: "linux-devel-x86_64", r: "4.7.0", check: "OK" },   // wrong R line
    { config: "macos-release-arm64", r: "4.6.1", check: "OK" },
  ];
  assert.deepEqual(passingFamilies(jobs, "4.6"), ["mac"],
    "linux has no gating-R job, so it neither passes nor blocks — it is not available");
  assert.deepEqual(passingFamilies([], "4.6"), []);
});

test("all gating jobs of a family must be clean, source counts against linux", () => {
  const jobs = [
    { config: "source", r: "4.6.1", check: "ERROR" },
    { config: "linux-release-x86_64", r: "4.6.1", check: "OK" },
    { config: "windows-release-x86_64", r: "4.6.1", check: "OK" },
  ];
  assert.deepEqual(passingFamilies(jobs, "4.6"), ["win"]);
});

test("mergeRows stores only changes, and tombstones what disappears", () => {
  const row = (pkg, config, check) => ({
    package: pkg, config, check, version: "1.0", sha256: "a", created: null,
    expires: null, r: "4.6.1", time: 1, job: 7n, artifact: null,
  });

  const first = mergeRows({}, [row("A", "linux", "OK"), row("B", "win", "NOTE")]);
  assert.equal(first.changed.length, 2, "nothing known yet, so everything is a change");

  // Identical observation: nothing stored at all.
  const same = mergeRows(first.state, [row("A", "linux", "OK"), row("B", "win", "NOTE")]);
  assert.deepEqual(same.changed, []);
  assert.deepEqual(same.state, first.state, "state is stable when nothing moves");

  // One check flips; only that row is kept.
  const flip = mergeRows(first.state, [row("A", "linux", "ERROR"), row("B", "win", "NOTE")]);
  assert.equal(flip.changed.length, 1);
  assert.equal(flip.changed[0].package, "A");
  assert.equal(flip.changed[0].check, "ERROR");

  // B vanishes upstream: a tombstone, or carry-forward would keep it alive forever.
  const gone = mergeRows(first.state, [row("A", "linux", "OK")]);
  assert.equal(gone.changed.length, 1);
  assert.deepEqual(
    { package: gone.changed[0].package, config: gone.changed[0].config, deleted: gone.changed[0].deleted },
    { package: "B", config: "win", deleted: 1 }
  );
  assert.ok(!("B\u0001win" in gone.state), "a dead key leaves the state");

  // Coming back after a tombstone is a change again, not a silent no-op.
  const back = mergeRows(gone.state, [row("A", "linux", "OK"), row("B", "win", "NOTE")]);
  assert.equal(back.changed.length, 1);
  assert.equal(back.changed[0].package, "B");
  assert.ok(!back.changed[0].deleted);

  // A field other than check still counts: version bumps must not be swallowed.
  const bumped = { ...row("A", "linux", "OK"), version: "2.0" };
  assert.equal(mergeRows(first.state, [bumped, row("B", "win", "NOTE")]).changed.length, 1);
});

test("metaOf picks descriptive fields, vignettes and commit; skips absences", () => {
  const m = metaOf({
    Title: "T", Description: "line1\nline2", biocViews: "Software, Clustering",
    Maintainer: "A B <a@b.org>",
    _vignettes: [{ filename: "x.html", title: "Intro", source: "x.Rmd" } as never],
    _commit: { id: "abc123", time: 1786329705 },
  });
  assert.equal(m.Title, "T");
  assert.equal(m.biocViews, "Software, Clustering");
  assert.equal(m.URL, undefined);
  assert.deepEqual(m.vignettes, [{ filename: "x.html", title: "Intro" }]);
  assert.deepEqual(m.commit, { id: "abc123", time: 1786329705 });
});

test("VIEWS: metadata, provenance, platform paths, reverse deps", () => {
  const idx = structuredClone(IDX) as never as Parameters<typeof viewsDcf>[0];
  idx.S4Vectors.meta = {
    Title: "Foundation of vector-like containers",
    Description: "S4 classes.\nSecond line.",
    biocViews: "Infrastructure, DataRepresentation",
    Maintainer: "Bioconductor <maintainer@bioconductor.org>",
    vignettes: [{ filename: "S4Vectors.html", title: "An Overview" }],
    commit: { id: "fe0a5fe", time: 1786329705 },
  };
  idx.leaf = {
    version: "2.0.0", sha256: "eee", ts: "2026-08-09T00:00:00Z",
    desc: { Depends: "R (>= 4.4), S4Vectors", Suggests: "legacyPkg", License: "MIT" },
    artifacts: [{ os: "src", r: "", sha256: "eee", file: "leaf_2.0.0.tar.gz" }],
  };
  const dcf = viewsDcf(idx);
  const stanzas = dcf.trim().split("\n\n");
  // legacyPkg has no desc: excluded, same rule as PACKAGES.
  assert.equal(stanzas.length, 2);
  const s4 = stanzas.find((x) => x.startsWith("Package: S4Vectors"))!;
  assert.match(s4, /Title: Foundation of vector-like containers/);
  assert.match(s4, /Description: S4 classes\.\n    Second line\./);
  assert.match(s4, /git_last_commit: fe0a5fe/);
  assert.match(s4, /git_last_commit_date: 2026-08-10/);
  assert.match(s4, /source\.ver: src\/contrib\/S4Vectors_0\.50\.1\.tar\.gz/);
  assert.match(s4, /win\.binary\.ver: bin\/windows\/contrib\/4\.7\/S4Vectors_0\.50\.1\.zip/);
  // R 4.7 is past CRAN's rename, so arm64 lives in sonoma-arm64 — the path R
  // actually asks for. big-sur-arm64 here would advertise a 404.
  assert.match(s4, /mac\.binary\.ver: bin\/macosx\/sonoma-arm64\/contrib\/4\.7\/S4Vectors_0\.50\.1\.tgz/);
  assert.match(s4, /vignettes: S4Vectors\.html/);
  assert.match(s4, /vignetteTitles: An Overview/);
  assert.match(s4, /dependsOnMe: leaf/);
  // leaf depends on R too, but R is a constraint, not an edge.
  const leaf = stanzas.find((x) => x.startsWith("Package: leaf"))!;
  assert.doesNotMatch(leaf, /Title:/);
  assert.match(leaf, /Depends: R \(>= 4\.4\), S4Vectors/);
});

test("originOf: entries predating the field read as propagations", () => {
  assert.equal(originOf({}), "r-universe");
  assert.equal(originOf({ origin: "r-universe" }), "r-universe");
  assert.equal(originOf({ origin: "bioconductor" }), "bioconductor");
});

// ---------- seeding from the official Bioconductor repositories ----------

test("parseDcf: stanzas, continuation lines, trailing record", () => {
  const recs = parseDcf([
    "Package: alpha",
    "Version: 1.0.0",
    "Description: one",
    "    two",
    "",
    "Package: beta",
    "Version: 2.0.0",
  ].join("\n"));
  assert.equal(recs.length, 2);
  assert.equal(recs[0].Description, "one two");
  assert.equal(recs[1].Package, "beta");   // final stanza without a trailing blank line
});

test("parseDcf: a value containing a colon keeps it", () => {
  const [r] = parseDcf("Package: a\nURL: https://example.org/x\n");
  assert.equal(r.URL, "https://example.org/x");
});

test("macArmDir tracks CRAN's rename at R 4.6", () => {
  assert.equal(macArmDir("4.5"), "big-sur-arm64");
  assert.equal(macArmDir("4.6"), "sonoma-arm64");
  assert.equal(macArmDir("4.10"), "sonoma-arm64");  // not a float comparison
});

test("verGt compares numerically, part by part", () => {
  assert.ok(verGt("1.10.0", "1.9.9"));       // not lexical
  assert.ok(!verGt("1.2.0", "1.2.0"));       // equal is not greater: a seed needs a bump
  assert.ok(!verGt("1.2.0", "1.2"));         // missing parts are zero, so these are equal
  assert.ok(verGt("1.2.1", "1.2"));
  assert.ok(verGt("1.2-1", "1.2-0"));
});

test("seedArtifacts: source always, binaries only where they exist", () => {
  const only = seedArtifacts("edgeR", "4.10.1", "4.6", {});
  assert.deepEqual(only.map((a) => a.os), ["src"]);
  assert.equal(only[0].path, "src/contrib/edgeR_4.10.1.tar.gz");

  const all = seedArtifacts("edgeR", "4.10.1", "4.6", { win: true, macArm: true, macX86: true });
  assert.deepEqual(all.map((a) => `${a.os}/${a.arch ?? "-"}`),
    ["src/-", "win/x86_64", "mac/arm64", "mac/x86_64"]);
  assert.equal(all[1].path, "bin/windows/contrib/4.6/edgeR_4.10.1.zip");
  assert.equal(all[2].path, "bin/macosx/sonoma-arm64/contrib/4.6/edgeR_4.10.1.tgz");
  assert.equal(all[3].path, "bin/macosx/big-sur-x86_64/contrib/4.6/edgeR_4.10.1.tgz");
  // Both mac builds share a filename and are told apart by arch alone.
  assert.equal(all[2].file, all[3].file);
});

test("seeded artifacts resolve through the same selectors as propagated ones", () => {
  const arts = seedArtifacts("edgeR", "4.10.1", "4.6", { win: true, macArm: true, macX86: true });
  const idx = {
    edgeR: {
      version: "4.10.1", sha256: "s0", ts: "2026-08-14T00:00:00Z", origin: "bioconductor",
      desc: { License: "GPL" }, artifacts: arts.map((a, i) => ({ ...a, sha256: "s" + i })),
    },
  };
  const sha = (dir) => {
    const sel = parseRepoDir(dir);
    const f = packagesDcf(idx, sel).match(/^File: (.*)$/m)?.[1];
    return f && findArtifact(idx, f, sel)?.sha256;
  };
  assert.equal(sha(["bin", "windows", "contrib", "4.6"]), "s1");
  assert.equal(sha(["bin", "macosx", "sonoma-arm64", "contrib", "4.6"]), "s2");
  assert.equal(sha(["bin", "macosx", "big-sur-x86_64", "contrib", "4.6"]), "s3");
  assert.equal(sha(["src", "contrib"]), "s0");
});

test("seedDesc/seedMeta split a VIEWS stanza the way propagation does", () => {
  const v = {
    Package: "TPP", Version: "3.41.0",
    Depends: "R (>= 3.4),\n  Biobase", Imports: "ggplot2", License: "Artistic-2.0",
    NeedsCompilation: "no", Title: "Analyze TPP experiments",
    Description: "A toolbox.", biocViews: "Software, Proteomics",
    Maintainer: "Someone <s@example.org>",
    vignettes: "vignettes/TPP/inst/doc/intro.html, vignettes/TPP/inst/doc/adv.html",
    vignetteTitles: "Introduction, Advanced",
    git_last_commit: "abc1234", git_last_commit_date: "2026-05-01",
    // Fields the official VIEWS carries that we deliberately do not store.
    dependencyCount: "88", hasREADME: "TRUE",
  };
  const d = seedDesc(v);
  assert.equal(d.Depends, "R (>= 3.4), Biobase");   // folded, no bare newline in DCF
  assert.equal(d.NeedsCompilation, "no");
  assert.equal(d.Title, undefined);                 // Title is meta, not PACKAGES

  const m = seedMeta(v);
  assert.equal(m.Title, "Analyze TPP experiments");
  assert.equal(m.biocViews, "Software, Proteomics");
  assert.deepEqual(m.vignettes, [
    { filename: "vignettes/TPP/inst/doc/intro.html", title: "Introduction" },
    { filename: "vignettes/TPP/inst/doc/adv.html", title: "Advanced" },
  ]);
  assert.equal(m.commit.id, "abc1234");
  assert.equal(m.dependencyCount, undefined);
});

test("a seeded commit date round-trips back through VIEWS unchanged", () => {
  const m = seedMeta({ git_last_commit: "abc1234", git_last_commit_date: "2026-05-01" });
  const dcf = viewsDcf({
    TPP: {
      version: "3.41.0", sha256: "s0", ts: "2026-08-14T00:00:00Z",
      desc: { License: "Artistic-2.0" }, meta: m,
      artifacts: [{ os: "src", r: "", sha256: "s0", file: "TPP_3.41.0.tar.gz" }],
      origin: "bioconductor",
    },
  });
  assert.match(dcf, /^git_last_commit_date: 2026-05-01$/m);
});

test("parseGitmodules maps package name to source repo", () => {
  // Verbatim shape of r-universe/bioc/.gitmodules, including the .registry
  // submodule and the handful of packages served straight off Bioconductor git.
  const map = parseGitmodules([
    '[submodule ".registry"]',
    "\tpath = .registry",
    "\turl = https://github.com/r-universe-org/cran-to-git",
    "\tbranch = HEAD",
    '[submodule "edgeR"]',
    "\tpath = edgeR",
    "\turl = https://github.com/bioc/edgeR",
    '[submodule "h5vc"]',
    "\tpath = h5vc",
    "\turl = https://git.bioconductor.org/packages/h5vc",
  ].join("\n"));
  assert.equal(map.edgeR, "https://github.com/bioc/edgeR");
  assert.equal(map.h5vc, "https://git.bioconductor.org/packages/h5vc");
  assert.equal(map[".registry"], "https://github.com/r-universe-org/cran-to-git");
  // branch = HEAD must not be mistaken for a url
  assert.equal(Object.keys(map).length, 3);
});

test("git_url reaches VIEWS, from either origin", () => {
  const idx = {
    edgeR: {
      version: "4.10.1", sha256: "s0", ts: "2026-08-14T00:00:00Z",
      desc: { License: "GPL" }, meta: { git_url: "https://github.com/bioc/edgeR" },
      artifacts: [{ os: "src", r: "", sha256: "s0", file: "edgeR_4.10.1.tar.gz" }],
    },
  };
  assert.match(viewsDcf(idx), /^git_url: https:\/\/github\.com\/bioc\/edgeR$/m);
  // and the seeder picks it up from the official VIEWS stanza
  assert.equal(seedMeta({ git_url: "https://git.bioconductor.org/packages/h5vc" }).git_url,
    "https://git.bioconductor.org/packages/h5vc");
});

test("VIEWS mac paths: arm64 tracks the R version, Intel gets its own field", () => {
  const entry = (arts) => ({
    X: {
      version: "1.0.0", sha256: "s0", ts: "2026-08-14T00:00:00Z",
      desc: { License: "MIT" },
      artifacts: [{ os: "src", r: "", sha256: "s0", file: "X_1.0.0.tar.gz" }, ...arts],
    },
  });
  const arm = { os: "mac", r: "4.6.1", arch: "arm64", sha256: "s1", file: "X_1.0.0.tgz" };
  const x86 = { os: "mac", r: "4.6.1", arch: "x86_64", sha256: "s2", file: "X_1.0.0.tgz" };

  const both = viewsDcf(entry([arm, x86]));
  assert.match(both, /^mac\.binary\.ver: bin\/macosx\/sonoma-arm64\/contrib\/4\.6\/X_1\.0\.0\.tgz$/m);
  assert.match(both, /^mac\.binary\.big-sur-x86_64\.ver: bin\/macosx\/big-sur-x86_64\/contrib\/4\.6\/X_1\.0\.0\.tgz$/m);

  // Intel-only must not be advertised as the arm64 build.
  const intelOnly = viewsDcf(entry([x86]));
  assert.doesNotMatch(intelOnly, /^mac\.binary\.ver:/m);
  assert.match(intelOnly, /^mac\.binary\.big-sur-x86_64\.ver:/m);

  // Before R 4.6 the arm64 directory was big-sur-arm64.
  const old = viewsDcf(entry([{ ...arm, r: "4.5.1" }]));
  assert.match(old, /^mac\.binary\.ver: bin\/macosx\/big-sur-arm64\/contrib\/4\.5\/X_1\.0\.0\.tgz$/m);
});

test("mergeMeta keeps git_url, which no observation carries", () => {
  // /reindex replaces meta wholesale so a field dropped upstream disappears.
  // git_url comes from .gitmodules instead, so a plain replace silently unlinked
  // every entry on the next reindex.
  const fresh = { Title: "T", Description: "D" };
  const kept = mergeMeta(fresh, { Title: "old", git_url: "https://github.com/bioc/X" });
  assert.equal(kept.git_url, "https://github.com/bioc/X");
  assert.equal(kept.Title, "T");
  assert.equal(mergeMeta(fresh, { Title: "old" }).git_url, undefined);
  assert.equal(mergeMeta(fresh).Title, "T");
  // A field the package dropped upstream must not survive.
  assert.equal(mergeMeta(fresh, { URL: "https://gone.example" }).URL, undefined);
});

test("writeOnce: only immutable objects may be cached", () => {
  for (const k of [
    "obs/bioc/dt=2026-08-14/x.json",
    "parquet/jobs/universe=bioc/dt=2026-08-14/x.parquet",
    "logs/bioc/123.txt",
    "prop/bioc/cas/abc123",
    "prop/bioc/log/2026-08-14T00:00:00Z-edgeR_4.10.1.json",
    "prop/bioc/pending/abc123.json",
  ]) assert.ok(writeOnce(k), k);

  // These are rewritten in place; caching them serves a stale index.
  for (const k of [
    "prop/bioc/index.json",
    "prop/bioc/seed/plan.json",
    "prop/bioc/seed/official-versions.json",
    "state/bioc/latest",
    "state/bioc/logcursor",
  ]) assert.ok(!writeOnce(k), k);
});

test("described: the one rule that decides whether R can see an entry", () => {
  assert.ok(described({ desc: { License: "MIT" } }));
  assert.ok(!described({}), "no desc at all");
  assert.ok(!described({ desc: {} }), "empty desc means the data was never captured");
});
