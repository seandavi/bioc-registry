// CRAN-layout repository format. Pure functions only — no Worker bindings — so
// they are testable with `node --test` (see repo.test.ts).

// arch/distro are carried purely so binary artifacts can be placed in a CRAN
// binary path; nothing reads them for the source repo.
export type Artifact = {
  os: string; r: string; sha256: string;
  arch?: string; distro?: string; file?: string;
};

// The DCF fields of PACKAGES that come from DESCRIPTION. Package/Version/File are
// held elsewhere on the entry, so they are not repeated here.
export type Desc = Partial<Record<
  "Priority" | "Depends" | "Imports" | "LinkingTo" | "Suggests" | "Enhances" |
  "License" | "OS_type" | "NeedsCompilation", string
>>;

// Descriptive DESCRIPTION fields, kept apart from Desc so PACKAGES stays
// exactly write_PACKAGES()-shaped while VIEWS and the site get the rest.
export const META_FIELDS = [
  "Title", "Description", "biocViews", "Author", "Maintainer", "URL",
  "BugReports", "SystemRequirements", "VignetteBuilder", "Date",
] as const;

export type Meta = Partial<Record<(typeof META_FIELDS)[number], string>> & {
  vignettes?: { filename?: string; title?: string }[];
  commit?: { id?: string; time?: number };
  // Where the package's source is built from, per the universe's .gitmodules or
  // the official VIEWS. For a Bioconductor package this is a github.com/bioc/*
  // READ-ONLY MIRROR of git.bioconductor.org, or that git server itself — never
  // a maintainer's development repo. Anything acting on it must not treat it as
  // a place to send a pull request.
  git_url?: string;
};

export function metaOf(p: Partial<Record<(typeof META_FIELDS)[number], string>> & {
  _vignettes?: { filename?: string; title?: string }[];
  _commit?: { id?: string; time?: number };
}): Meta {
  const m: Meta = {};
  for (const k of META_FIELDS) if (p[k]) m[k] = p[k];
  if (p._vignettes?.length)
    m.vignettes = p._vignettes.map((v) => ({ filename: v.filename, title: v.title }));
  if (p._commit?.id) m.commit = { id: p._commit.id, time: p._commit.time };
  return m;
}

// Keys whose bytes never change once written. Everything else — the state/
// pointers, prop/*/index.json, the seed plan — is rewritten in place, and
// serving those with a long immutable cache hands out a stale index.
export const writeOnce = (key: string) =>
  /^(obs|parquet|logs|checks|builds)\/|\/(cas|log|pending|blocked)\//.test(key);

// Fresh metadata from an observation replaces what was stored, so a field the
// package dropped upstream disappears here too. git_url is the exception: it
// comes from the universe's .gitmodules rather than the observation, so a
// wholesale replace would drop it every time /reindex runs.
export function mergeMeta(fresh: Meta, existing?: Meta): Meta {
  return existing?.git_url ? { ...fresh, git_url: existing.git_url } : { ...fresh };
}

export type PropIndex = Record<string, {
  version: string; sha256: string; ts: string;
  bioccheck?: string | null; artifacts: Artifact[]; desc?: Desc; meta?: Meta;
  // Gate families that passed for this propagation (entries written before
  // per-arch gating lack it). Families absent here are "not available": their
  // binaries were not propagated.
  archs?: string[];
  // Where the entry came from. A "bioconductor" entry was seeded from
  // Bioconductor's own release build and never passed this gate — its archs is
  // empty and its bioccheck is null, so without this field it would be
  // indistinguishable from a gate verdict we never made.
  origin?: Origin;
}>;

export type Origin = "r-universe" | "bioconductor" | "bioc-build";

// Entries predating the field are propagations, which is what they are.
export const originOf = (e: { origin?: Origin }): Origin => e.origin ?? "r-universe";

// ---------- publish (bioc-build ingest, issue #12) ----------
// POST /publish body per SPEC-014. `entry` is absent for a failed/rejected build
// (attempt-only record); `attempt.ts` defaults to "now" by the caller when absent.
export type PublishEntry = {
  version: string; sha256: string; ts?: string;
  bioccheck?: string | null; archs?: string[]; artifacts: Artifact[];
  desc: Desc; meta?: Meta; origin: "bioc-build";
};
export type PublishAttempt = { commit: string; status: string; run_url?: string; ts?: string };
export type PublishBody = {
  universe: string; package: string; run_id: string;
  attempt: PublishAttempt; entry?: PublishEntry;
};

const PKG_NAME_RE = /^[A-Za-z][A-Za-z0-9.]*$/;
const SHA256_RE = /^[0-9a-f]{64}$/i;

// Pure request validator — every reason a publish.yml bug or a forged request
// should get a 400 instead of writing to R2, checked in one place.
export function validatePublish(
  body: unknown, universes: readonly string[]
): { ok: true; value: PublishBody } | { ok: false; reason: string } {
  const b = body as Partial<PublishBody> | null;
  if (!b || typeof b !== "object") return { ok: false, reason: "body must be an object" };
  if (!universes.includes(b.universe as string)) return { ok: false, reason: "invalid universe" };
  if (typeof b.package !== "string" || !PKG_NAME_RE.test(b.package))
    return { ok: false, reason: "invalid package name" };
  if (typeof b.run_id !== "string" || !b.run_id) return { ok: false, reason: "missing run_id" };
  const a = b.attempt;
  if (!a || typeof a !== "object" || typeof a.commit !== "string" || !a.commit || typeof a.status !== "string" || !a.status)
    return { ok: false, reason: "invalid attempt" };
  if (b.entry !== undefined) {
    const e = b.entry as Partial<PublishEntry> | null;
    if (!e || typeof e !== "object") return { ok: false, reason: "invalid entry" };
    if (typeof e.version !== "string" || !e.version) return { ok: false, reason: "entry.version required" };
    if (typeof e.sha256 !== "string" || !SHA256_RE.test(e.sha256))
      return { ok: false, reason: "entry.sha256 must be 64 hex chars" };
    if (!Array.isArray(e.artifacts) || e.artifacts[0]?.os !== "src" || !e.artifacts[0]?.file)
      return { ok: false, reason: "entry.artifacts[0] must be a src artifact with a file" };
    if (!e.desc || typeof e.desc !== "object" || !Object.keys(e.desc).length)
      return { ok: false, reason: "entry.desc must be non-empty" };
    if (e.origin !== "bioc-build") return { ok: false, reason: "entry.origin must be bioc-build" };
  }
  return { ok: true, value: b as PublishBody };
}

// ponytail: JSON.stringify equality, not a structural deep-equal. Both sides are
// built the same way (self-heal re-sends the stored entry verbatim), so key order
// matches on the no-op path that matters; upgrade to real deep-equal if a
// byte-different-but-equivalent payload ever causes a spurious index write.
export function upsertEntry(
  idx: PropIndex, pkg: string, entry: PropIndex[string]
): { idx: PropIndex; changed: boolean } {
  const prev = idx[pkg];
  if (prev && JSON.stringify(prev) === JSON.stringify(entry)) return { idx, changed: false };
  return { idx: { ...idx, [pkg]: entry }, changed: true };
}

export type AttemptRecord = {
  commit: string; status: string; run_id: string; run_url: string; ts: string; attempts: number;
};

// attempts increments on a repeated attempt at the same commit, resets to 1 when
// the upstream commit moves — the signal dispatch.yml's failed:-with-attempts>=3
// backoff reads.
export function mergeAttempt(
  prev: AttemptRecord | undefined,
  next: { commit: string; status: string; run_id: string; run_url: string; ts: string }
): AttemptRecord {
  return { ...next, attempts: prev && prev.commit === next.commit ? prev.attempts + 1 : 1 };
}

export type Sel = { os: string; r?: string; arch?: string; distro?: string };

// An entry with no recorded DESCRIPTION is skipped by PACKAGES and VIEWS alike —
// emitting a stanza with no dependency fields would read as "this package has
// none". The entry is therefore in the index but invisible to R: it cannot be
// installed by name, and nothing on the outside can tell it exists.
export const described = <T extends { desc?: Desc }>(e: T): e is T & { desc: Desc } =>
  !!e.desc && Object.keys(e.desc).length > 0;
export const invisible = (e: { desc?: Desc }) => !described(e);

// r-universe binary filenames are not in the API, so we name them ourselves; the
// name only has to agree with the File field we emit in the matching PACKAGES.
// _binaries[].os is "win"/"mac"/"linux"/"wasm" — not the longer spellings used in
// the CRAN repo paths.
export const PKG_EXT: Record<string, string> = {
  src: "tar.gz", win: "zip", mac: "tgz", linux: "tar.gz", wasm: "tar.gz",
};

// ---------- the gate ----------
// A package propagates when it builds and its checks pass on AT LEAST ONE
// architecture; only the passing architectures' binaries propagate, and the
// rest are simply not available. NOTE/WARNING pass; ERROR/FAIL block — per
// family, not globally. bioc-checks (BiocCheck) and wasm stay advisory,
// mirroring BBS policy (BBSreportutils.py: bioccheck "not taken into
// consideration ... to determine package overall status or propagation").

export type GateJob = { config: string; r?: string; check?: string };
export const GATE_BAD = new Set(["ERROR", "FAIL", "FAILURE"]);
export const GATE_FAMILIES = ["linux", "win", "mac"] as const;
export type Family = (typeof GATE_FAMILIES)[number];

// Which family a check config verdicts, on production-BBS-equivalent platforms
// only: source + linux x86_64 -> linux, windows x86_64 -> win, mac arm64 ->
// mac. Everything else (bioc-checks, wasm, other chips) gates nothing.
// ponytail: family-level verdicts — linux arm64 binaries ride the x86_64
// verdict, mac x86_64 rides arm64. Split per-chip if that ever bites.
export function gateFamily(config: string): Family | null {
  if (config === "source") return "linux";
  const arm = config.includes("arm64");
  if (config.startsWith("linux-") && !arm) return "linux";
  if (config.startsWith("windows-") && !arm) return "win";
  if (config.startsWith("macos-") && arm) return "mac";
  return null;
}

// Families with at least one gating job on the gating R line and no
// ERROR/FAIL among them. Empty result = the package does not propagate.
export function passingFamilies(jobs: GateJob[], rMinor: string): Family[] {
  const good = new Map<Family, boolean>();
  for (const j of jobs) {
    if (!j.r?.startsWith(rMinor + ".")) continue;
    const f = gateFamily(j.config);
    if (!f) continue;
    good.set(f, (good.get(f) ?? true) && !GATE_BAD.has(j.check ?? ""));
  }
  return GATE_FAMILIES.filter((f) => good.get(f) === true);
}

const DEP_ROLES = ["Depends", "Imports", "LinkingTo", "Suggests", "Enhances"] as const;

// r-universe normalises the dependency fields out of the top level of the record
// into _dependencies [{package, version, role}]; regroup them back into DCF.
export function describe(p: {
  License?: string; NeedsCompilation?: string; Priority?: string; OS_type?: string;
  _dependencies?: { package: string; version?: string; role: string }[];
}): Desc {
  const d: Desc = {};
  for (const role of DEP_ROLES) {
    const deps = (p._dependencies ?? []).filter((x) => x.role === role);
    if (deps.length)
      d[role] = deps.map((x) => x.package + (x.version ? ` (${x.version})` : "")).join(", ");
  }
  if (p.Priority) d.Priority = p.Priority;
  if (p.License) d.License = p.License;
  if (p.OS_type) d.OS_type = p.OS_type;
  if (p.NeedsCompilation) d.NeedsCompilation = p.NeedsCompilation;
  return d;
}

// write_PACKAGES() emits only these fields, in this order — no Title/Description/
// Author. MD5sum is omitted: r-universe exposes sha256 only, and
// available.packages()/install.packages() treat MD5sum as optional. Archs (mac fat
// binaries) is not emitted either.
const DCF_ORDER = [
  "Package", "Version", "Priority", "Depends", "Imports", "LinkingTo", "Suggests",
  "Enhances", "License", "OS_type", "NeedsCompilation", "File",
] as const;

// contrib.url() paths. Only Windows and macOS are served: contrib.url() on Linux
// returns the SOURCE path, so CRAN has no Linux binary layout to target — which is
// why r-universe serves its Linux builds by User-Agent negotiation instead. The
// Linux and wasm artifacts stay mirrored in the CAS, they just have no repo path.
// (_binaries also omits `distro` in the fields= response, so we could not place
// them per-distro even if we wanted to.)
//
// ponytail: the Windows path is pinned to x86_64 because contrib.url() on
// Windows-on-ARM asks for this same directory, and mixing arm64 zips in would hand
// an ARM build to an x86 R. Serve arm64 separately if that ever matters.
export function parseRepoDir(p: string[]): Sel | null {
  if (p[0] === "src" && p[1] === "contrib" && p.length === 2) return { os: "src" };
  if (p[0] !== "bin") return null;
  if (p[1] === "windows" && p[2] === "contrib" && p[3])
    return { os: "win", r: p[3], arch: "x86_64" };
  if (p[1] === "macosx" && p[3] === "contrib" && p[4])
    return { os: "mac", arch: p[2], r: p[4] };
  return null;
}

export const rMinor = (r: string) => r.split(".").slice(0, 2).join(".");

const normArch = (s: string) => {
  const t = s.split("-").pop() ?? "";
  return t === "aarch64" ? "arm64" : t === "amd64" ? "x86_64" : t;
};

export function matchSel(a: Artifact, s: Sel): boolean {
  if (a.os !== s.os || !a.file) return false;
  if (s.r && rMinor(a.r) !== s.r) return false;
  // Only ~31% of binary records carry an arch: a package with no compiled code
  // builds one arch-independent binary, and r-universe omits the field for it. An
  // arch-less artifact is therefore valid for every arch, not for none.
  if (s.arch && a.arch && normArch(s.arch) !== normArch(a.arch)) return false;
  if (s.distro && s.distro !== a.distro) return false;
  return true;
}

// DCF forbids bare newlines in a value; License and the dependency strings are the
// only fields here that could carry one.
const dcfValue = (s: string) => s.replace(/\s+/g, " ").trim();

export function packagesDcf(idx: PropIndex, sel: Sel): string {
  const stanzas: string[] = [];
  for (const pkg of Object.keys(idx).sort()) {
    const e = idx[pkg];
    // Entries with no recorded desc are skipped rather than emitted with no
    // Depends line, which would silently claim they have no dependencies. An
    // EMPTY desc means the same thing: every real package has at least a License,
    // so {} is "we never had the data", not "this package declares nothing".
    // /reindex backfills them from an observation that carries the DESCRIPTION.
    if (!described(e)) continue;
    const a = e.artifacts.find((x) => matchSel(x, sel));
    if (!a) continue;
    const rec: Record<string, string | undefined> = {
      Package: pkg, Version: e.version, ...e.desc, File: a.file,
    };
    stanzas.push(
      DCF_ORDER.filter((k) => rec[k]).map((k) => `${k}: ${dcfValue(rec[k]!)}`).join("\n")
    );
  }
  return stanzas.length ? stanzas.join("\n\n") + "\n" : "";
}

// ---------- VIEWS ----------
// The DCF file the legacy build system published at each repository root and
// downstream tools (BiocPkgTools, biocViews) parse: PACKAGES fields plus
// descriptive metadata, vignettes, git provenance, per-platform paths and
// first-order reverse dependencies within the propagated set.
//
// Omitted because this data plane cannot know them, documented rather than
// faked: MD5sum, Rank, dependencyCount, hasREADME/hasNEWS/hasINSTALL/
// hasLICENSE, Rfiles, htmlDocs, htmlTitles.

// Multi-line values (Description, Author) are legal DCF as continuation
// lines; four-space indent, matching write.dcf's output closely enough for
// every DCF parser.
const viewsValue = (s: string) => s.replace(/\r?\n\s*/g, "\n    ").trim();

// First-order package names out of a joined dependency string. "R (>= 4.0)"
// is a version constraint on R itself, not a dependency edge worth emitting.
function depNames(v?: string): string[] {
  return (v ?? "")
    .split(",")
    .map((s) => s.trim().split(/[\s(]/, 1)[0])
    .filter((s) => s && s !== "R");
}

export function viewsDcf(idx: PropIndex): string {
  const names = Object.keys(idx).sort();
  const rev: Record<string, { dependsOnMe: string[]; importsMe: string[]; suggestsMe: string[] }> =
    Object.fromEntries(names.map((n) => [n, { dependsOnMe: [], importsMe: [], suggestsMe: [] }]));
  for (const n of names) {
    const d = idx[n].desc;
    if (!d) continue;
    for (const p of depNames(d.Depends)) rev[p]?.dependsOnMe.push(n);
    for (const p of depNames(d.Imports)) rev[p]?.importsMe.push(n);
    for (const p of depNames(d.Suggests)) rev[p]?.suggestsMe.push(n);
  }

  const stanzas: string[] = [];
  for (const pkg of names) {
    const e = idx[pkg];
    // Same rule as PACKAGES: an entry with no recorded desc predates the
    // DESCRIPTION fields and would emit a stanza that silently claims no
    // dependencies. /reindex backfills it after a fresh observation.
    if (!described(e)) continue;
    const m = e.meta ?? {};
    const src = e.artifacts.find((a) => a.os === "src");
    const win = e.artifacts.find((a) => a.os === "win");
    // Two mac builds share a filename and differ only by arch, so they are
    // picked apart here rather than by find-first. An arch-less binary is
    // arch-independent, so it stands in for arm64.
    const macs = e.artifacts.filter((a) => a.os === "mac");
    const macArm = macs.find((a) => !a.arch || normArch(a.arch) === "arm64");
    const macX86 = macs.find((a) => a.arch && normArch(a.arch) === "x86_64");
    const vigTitles = (m.vignettes ?? []).map((v) => v.title).filter(Boolean);
    const vigFiles = (m.vignettes ?? []).map((v) => v.filename).filter(Boolean);
    const rec: Record<string, string | undefined> = {
      Package: pkg,
      Version: e.version,
      Depends: e.desc.Depends,
      Suggests: e.desc.Suggests,
      Imports: e.desc.Imports,
      LinkingTo: e.desc.LinkingTo,
      Enhances: e.desc.Enhances,
      License: e.desc.License,
      OS_type: e.desc.OS_type,
      Priority: e.desc.Priority,
      NeedsCompilation: e.desc.NeedsCompilation,
      Title: m.Title,
      Description: m.Description,
      biocViews: m.biocViews,
      Author: m.Author,
      Maintainer: m.Maintainer,
      URL: m.URL,
      BugReports: m.BugReports,
      SystemRequirements: m.SystemRequirements,
      VignetteBuilder: m.VignetteBuilder,
      Date: m.Date,
      git_url: m.git_url,
      git_last_commit: m.commit?.id,
      git_last_commit_date: m.commit?.time
        ? new Date(m.commit.time * 1000).toISOString().slice(0, 10)
        : undefined,
      "source.ver": src?.file ? `src/contrib/${src.file}` : undefined,
      "win.binary.ver": win?.file && win.r
        ? `bin/windows/contrib/${rMinor(win.r)}/${win.file}` : undefined,
      // The arm64 directory name follows the R version — CRAN renamed it at
      // R 4.6 — so it comes from macArmDir rather than a constant, which is
      // also what the seeder fetches from. The x86_64 line uses the
      // mac.binary.<platform>.ver form the legacy Bioconductor VIEWS used for
      // secondary mac builds.
      "mac.binary.ver": macArm?.file && macArm.r
        ? `bin/macosx/${macArmDir(rMinor(macArm.r))}/contrib/${rMinor(macArm.r)}/${macArm.file}`
        : undefined,
      [`mac.binary.${MAC_X86_DIR}.ver`]: macX86?.file && macX86.r
        ? `bin/macosx/${MAC_X86_DIR}/contrib/${rMinor(macX86.r)}/${macX86.file}` : undefined,
      vignettes: vigFiles.length ? vigFiles.join(", ") : undefined,
      vignetteTitles: vigTitles.length ? vigTitles.join(", ") : undefined,
      dependsOnMe: rev[pkg].dependsOnMe.join(", ") || undefined,
      importsMe: rev[pkg].importsMe.join(", ") || undefined,
      suggestsMe: rev[pkg].suggestsMe.join(", ") || undefined,
    };
    stanzas.push(
      Object.entries(rec)
        .filter(([, v]) => v)
        .map(([k, v]) => `${k}: ${viewsValue(v!)}`)
        .join("\n")
    );
  }
  return stanzas.length ? stanzas.join("\n\n") + "\n" : "";
}

// Package names cannot contain "_", so the first underscore splits name from
// version+extension. O(1) lookup instead of scanning every artifact.
export function findArtifact(idx: PropIndex, file: string, sel: Sel): Artifact | undefined {
  const pkg = file.split("_")[0];
  return idx[pkg]?.artifacts.find((a) => a.file === file && matchSel(a, sel));
}

// ---------- seeding from the official Bioconductor repositories ----------
// One-time backfill of packages Bioconductor ships that never passed this gate:
// they build in BBS and fail in r-universe's environment. Everything here is
// parsing and path construction; the fetching, hashing and writing live in
// index.ts. A seeded entry carries origin "bioconductor" and never claims a
// gate verdict.

// DCF: stanzas separated by blank lines, "Field: value", continuation lines
// indented. Only what the official VIEWS and PACKAGES actually use — no
// comments, no folded quoting.
export function parseDcf(text: string): Record<string, string>[] {
  const out: Record<string, string>[] = [];
  let rec: Record<string, string> = {};
  let field = "";
  for (const line of text.split(/\r?\n/)) {
    if (!line.trim()) {
      if (Object.keys(rec).length) out.push(rec);
      rec = {}; field = "";
      continue;
    }
    if (/^\s/.test(line) && field) {
      rec[field] += " " + line.trim();
      continue;
    }
    const i = line.indexOf(":");
    if (i < 0) continue;
    field = line.slice(0, i);
    rec[field] = line.slice(i + 1).trim();
  }
  if (Object.keys(rec).length) out.push(rec);
  return out;
}

// Version comparison shared by the gate and the seeder: dot- or dash-separated
// numeric parts, missing parts read as 0.
export function verGt(a: string, b: string): boolean {
  const pa = a.split(/[.-]/).map(Number), pb = b.split(/[.-]/).map(Number);
  for (let i = 0; i < Math.max(pa.length, pb.length); i++) {
    const d = (pa[i] ?? 0) - (pb[i] ?? 0);
    if (d) return d > 0;
  }
  return false;
}

// ---------- propagation dependency gate (#34) ----------
// Roles R must resolve to install a package. Suggests/Enhances are excluded:
// they are not needed to install, and BBS's propagation check ignores them too.
const HARD_ROLES = ["Depends", "Imports", "LinkingTo"] as const;

// Base packages ship with R itself, so depending on one is always satisfiable
// and their versions track R's, not ours. Recommended packages are deliberately
// NOT here — they come from CRAN, which lands in the "not ours" branch below.
const BASE_PKGS = new Set([
  "base", "compiler", "datasets", "graphics", "grDevices", "grid", "methods",
  "parallel", "splines", "stats", "stats4", "tcltk", "tools", "utils",
]);

export type DepReq = { pkg: string; op: string; ver: string };

// Parse the hard dependency fields into (package, constraint) triples. Only >=
// and > are enforced; R permits others but they are vanishingly rare and BBS
// ignores them as well, so anything we cannot parse reads as "no constraint"
// rather than as a blocker.
export function depConstraints(d: Desc): DepReq[] {
  const out: DepReq[] = [];
  for (const role of HARD_ROLES)
    for (const entry of (d[role] ?? "").split(",")) {
      const m = entry.trim().match(
        /^([A-Za-z][A-Za-z0-9._]*)\s*(?:\(\s*(>=?)\s*([0-9][0-9.-]*)\s*\))?/
      );
      if (!m || m[1] === "R" || BASE_PKGS.has(m[1])) continue;
      out.push({ pkg: m[1], op: m[2] ?? "", ver: m[3] ?? "" });
    }
  return out;
}

// A candidate may propagate only if every hard dependency WE publish is present
// at a version its constraint accepts. Dependencies we do not publish — CRAN,
// and the annotation/experiment data packages that have no build home until M2 —
// pass untouched: we cannot vouch for them either way, and blocking on them
// would strand well over half the universe (the canary measures ~1050 of 2391
// with a fully resolvable closure). This is Hervé's "no propagations that
// introduce impossible dependencies" narrowed to impossibilities we can see.
//
// Approval is a fixpoint, as in BBS's makePropagationStatusDb.R: a candidate
// blocked only by another candidate in the same wave is approved once that one
// is, so a coordinated bump (S4Vectors + IRanges together) still lands. Checking
// direct dependencies is enough to make the whole index consistent, because the
// gate holds inductively for everything already in it.
//
// The returned order is that fixpoint order, which is a topological sort: a
// dependency is never published after the package that needs it. propagateBatch()
// writes the index in slices, so without this the index could serve the broken
// pair transiently even when both were approved together.
// Blocked candidates come back with the unmet requirement spelled out, the way
// BBS records an "explain" for every package: without it a package that quietly
// stops propagating is undiagnosable after the fact.
export type Blocked = { package: string; version: string; needs: string };

export function approveByDeps<T extends { package: string; version: string; desc: Desc }>(
  candidates: T[], idx: PropIndex
): { approved: T[]; blocked: Blocked[] } {
  const published = new Map<string, string>(
    Object.entries(idx).map(([name, e]) => [name, e.version])
  );
  // The first requirement this candidate cannot meet, or null if it is clear.
  const unmet = (d: Desc): DepReq | null => {
    for (const r of depConstraints(d)) {
      const have = published.get(r.pkg);
      if (have === undefined) continue;
      if (r.op === ">=" && verGt(r.ver, have)) return r;
      if (r.op === ">" && !verGt(have, r.ver)) return r;
    }
    return null;
  };
  const approved: T[] = [];
  let pool = candidates;
  let reasons = new Map<string, DepReq>();
  while (pool.length) {
    const pass: T[] = [], held: T[] = [];
    reasons = new Map();
    for (const c of pool) {
      const r = unmet(c.desc);
      if (r) { reasons.set(c.package, r); held.push(c); } else pass.push(c);
    }
    if (!pass.length) break; // nothing left that this wave can unblock
    for (const c of pass) published.set(c.package, c.version);
    approved.push(...pass);
    pool = held;
  }
  return {
    approved,
    blocked: pool.map((c) => {
      const r = reasons.get(c.package)!;
      return {
        package: c.package, version: c.version,
        needs: `${r.pkg} (${r.op} ${r.ver}), published ${published.get(r.pkg)}`,
      };
    }),
  };
}

// CRAN renamed the macOS arm64 directory at R 4.6 (big-sur-arm64 -> sonoma-arm64)
// and Bioconductor followed; verified 2026-08-14, big-sur-arm64/4.6 is a 404 on
// both. Intel stayed put. Used to fetch from Bioconductor and to emit our own
// mac.binary.ver, so the two can never disagree.
export const macArmDir = (rMinor: string) =>
  verGt(rMinor, "4.5") ? "sonoma-arm64" : "big-sur-arm64";
export const MAC_X86_DIR = "big-sur-x86_64";

const SEED_DESC_FIELDS = [
  "Priority", "Depends", "Imports", "LinkingTo", "Suggests", "Enhances",
  "License", "OS_type", "NeedsCompilation",
] as const;

export function seedDesc(v: Record<string, string>): Desc {
  const d: Desc = {};
  for (const k of SEED_DESC_FIELDS) if (v[k]) d[k] = dcfValue(v[k]);
  return d;
}

const csv = (s?: string) => (s ?? "").split(",").map((x) => x.trim()).filter(Boolean);

export function seedMeta(v: Record<string, string>): Meta {
  const m: Meta = {};
  for (const k of META_FIELDS) if (v[k]) m[k] = v[k];
  if (v.git_url) m.git_url = v.git_url;
  const files = csv(v.vignettes), titles = csv(v.vignetteTitles);
  if (files.length) m.vignettes = files.map((f, i) => ({ filename: f, title: titles[i] }));
  // The official VIEWS dates the commit but does not stamp it; midnight UTC of
  // that date round-trips back to the same date through viewsDcf.
  if (v.git_last_commit)
    m.commit = {
      id: v.git_last_commit,
      time: v.git_last_commit_date
        ? Date.parse(v.git_last_commit_date + "T00:00:00Z") / 1000
        : undefined,
    };
  return m;
}

// Each universe is a GitHub repo holding one git submodule per package, so
// .gitmodules is the authoritative package -> source repo map: one fetch covers
// every package in the universe, including ones that never propagated. Keyed by
// submodule path, which is the package name.
export function parseGitmodules(text: string): Record<string, string> {
  const out: Record<string, string> = {};
  let path = "";
  for (const line of text.split(/\r?\n/)) {
    const t = line.trim();
    if (t.startsWith("[submodule")) { path = ""; continue; }
    const m = /^(path|url) = (.+)$/.exec(t);
    if (!m) continue;
    if (m[1] === "path") path = m[2];
    else if (path) out[path] = m[2];
  }
  return out;
}

export type SeedArtifact = { os: string; r: string; arch?: string; path: string; file: string };

// Which artifacts to pull for one package. Binary availability comes from each
// binary directory's own PACKAGES, matched on version: the counts differ from
// the source repo (release 2384 source vs 2305 windows vs 2332 arm64), so a
// binary is not guaranteed to exist at the version we are seeding.
export function seedArtifacts(
  pkg: string, ver: string, rMinor: string,
  has: { win?: boolean; macArm?: boolean; macX86?: boolean }
): SeedArtifact[] {
  const stem = `${pkg}_${ver}`;
  const out: SeedArtifact[] = [
    { os: "src", r: "", path: `src/contrib/${stem}.tar.gz`, file: `${stem}.tar.gz` },
  ];
  if (has.win)
    out.push({
      os: "win", r: rMinor, arch: "x86_64",
      path: `bin/windows/contrib/${rMinor}/${stem}.zip`, file: `${stem}.zip`,
    });
  if (has.macArm)
    out.push({
      os: "mac", r: rMinor, arch: "arm64",
      path: `bin/macosx/${macArmDir(rMinor)}/contrib/${rMinor}/${stem}.tgz`,
      file: `${stem}.tgz`,
    });
  if (has.macX86)
    out.push({
      os: "mac", r: rMinor, arch: "x86_64",
      path: `bin/macosx/${MAC_X86_DIR}/contrib/${rMinor}/${stem}.tgz`,
      file: `${stem}.tgz`,
    });
  return out;
}

// ---------- observation merge (SCD type 2) ----------
// Consecutive observations are ~99.9% identical: measured 0-50 differing rows out
// of ~26,850. Storing each one whole makes the history grow ~26MB/day for a few
// hundred rows of actual news, so a row is written only when it differs from the
// last one for its (package, config). obs_ts becomes the valid-from stamp and
// readers carry the last value forward.

// 64-bit FNV-1a, as two 32-bit halves to stay in Number territory. Synchronous —
// crypto.subtle would mean ~27k awaits per observation. A collision would silently
// drop a change, so 32 bits is not enough here: 27k keys give a ~8% birthday
// chance at 32 bits versus ~2e-11 at 64.
export function rowHash(s: string): string {
  let a = 0x811c9dc5, b = 0x01000193;
  for (let i = 0; i < s.length; i++) {
    const c = s.charCodeAt(i);
    a = Math.imul(a ^ c, 0x01000193) >>> 0;
    b = Math.imul(b ^ c, 0x85ebca6b) >>> 0;
  }
  return a.toString(16).padStart(8, "0") + b.toString(16).padStart(8, "0");
}

export type JobRow = {
  package: string; config: string;
  version: string | null; sha256: string | null; created: string | null; expires: string | null;
  r: string | null; check: string | null; time: number | null; job: bigint | null;
  artifact: string | null;
  // 1 marks a tombstone: this (package, config) is gone as of obs_ts. Without it a
  // carry-forward reader keeps the last value alive forever and resurrects rows
  // that upstream deleted — measured 48 phantom rows across six observations.
  deleted?: number | null;
};

export type RowState = Record<string, string>;

// \u0001 as the separator because it cannot occur in any of these fields; joining
// on a printable character would let "a|b" and "a" + "|b" hash alike.
const rowValue = (r: JobRow) =>
  [r.version, r.sha256, r.created, r.expires, r.r, r.check, r.time, r.job, r.artifact].join("\u0001");

// Returns the rows worth storing plus the state to compare the NEXT observation
// against. State is rebuilt from the incoming rows alone, so a (package, config)
// that disappears upstream drops out — if it comes back unchanged later it costs
// one redundant row, which carry-forward readers handle without noticing.
export function mergeRows(prev: RowState, rows: JobRow[]): { changed: JobRow[]; state: RowState } {
  const state: RowState = {};
  const changed: JobRow[] = [];
  for (const r of rows) {
    const key = `${r.package}\u0001${r.config}`;
    const h = rowHash(rowValue(r));
    state[key] = h;
    if (prev[key] !== h) changed.push(r);
  }
  // Anything in the previous state and absent from this observation has gone away.
  for (const key of Object.keys(prev)) {
    if (key in state) continue;
    const [pkg, config] = key.split("\u0001");
    changed.push({
      package: pkg, config, deleted: 1,
      version: null, sha256: null, created: null, expires: null,
      r: null, check: null, time: null, job: null, artifact: null,
    });
  }
  return { changed, state };
}

// Picks the next batch of observation parquet files to merge: the oldest closed
// day that still has more than one file. Today's day is left alone because it is
// still being appended to.
//
// Bounded by BYTES, not file count. A file that is itself a previous merge can
// hold a whole day, and six of those decode to ~560k row objects, which killed the
// Worker outright (error 1102) and took poll and capture down with it. Files larger
// than the budget are skipped rather than merged, so an already-large day file is
// left alone instead of wedging its day forever.
//
// Returns the output key too. When the batch's oldest member is itself a previous
// merge, the output key is that same key — the new file is a superset, so it
// overwrites cleanly, and the caller must not delete it as a source.
export function planCompaction(
  objects: { key: string; size: number }[],
  today: string,
  maxBytes: number
): { day: string; sources: string[]; out: string } | null {
  const byDay = new Map<string, { key: string; size: number }[]>();
  for (const o of objects) {
    const m = /\/dt=(\d{4}-\d{2}-\d{2})\//.exec(o.key);
    if (!m || m[1] >= today) continue;
    byDay.set(m[1], [...(byDay.get(m[1]) ?? []), o]);
  }
  for (const day of [...byDay.keys()].sort()) {
    const files = byDay.get(day)!.sort((a, b) => a.key.localeCompare(b.key));
    // Advancing `from` is what keeps a day from wedging. A merge sorts first (its
    // name carries the day's earliest timestamp) and can sit just under the budget
    // — 2.5MB of a 3MB cap — leaving no room for any sibling, so the greedy pass
    // anchored at index 0 yields one source and the day is skipped forever. Both
    // universes stalled that way on the pre-delta days. Starting past it merges the
    // tail into a second -m instead; a day may hold several, which reads the same.
    for (let from = 0; from < files.length; from++) {
      const sources: string[] = [];
      let total = 0;
      for (const o of files.slice(from)) {
        if (o.size > maxBytes || total + o.size > maxBytes) continue;
        sources.push(o.key);
        total += o.size;
      }
      if (sources.length < 2) continue;
      const dir = sources[0].slice(0, sources[0].lastIndexOf("/") + 1);
      // Basenames start with the observation timestamp: 2026-08-09T06:00:55.907Z-…
      return { day, sources, out: `${dir}${sources[0].slice(dir.length, dir.length + 24)}-m.parquet` };
    }
  }
  return null;
}

// ---------- build manifest ----------
// The job log is the only place a build's inputs are written down: the image it
// ran in, and the resolved version of every dependency it installed. Nothing else
// has them — r-universe's _rundeps is names without versions, and the check
// artifact records only the R revision and the OS. That makes this the difference
// between "the check failed" and "the check can be re-run", since a check that
// broke without the package changing broke because a dependency moved.
//
// Bioconductor's build system publishes the equivalent per builder as
// R-instpkgs.html — and 404s it as soon as a release is archived, so the versions
// behind an archived report are already unrecoverable there.
//
// Extracted once at capture rather than left in place, because the alternative is
// every consumer regexing a log that runs to 9MB.
export type BuildManifest = { image?: string; repos: string[]; deps: Record<string, string> };

export function buildManifest(log: string): BuildManifest {
  // Name and digest are captured independently: a job pulls one image, and the
  // "Digest:" line docker prints does not repeat the name next to it.
  const image = /((?:ghcr|docker)\.io\/[a-z0-9._\-/]+):[a-z0-9._-]+/i.exec(log)?.[1];
  const digest = /Digest: (sha256:[a-f0-9]{64})/.exec(log)?.[1];
  // Windows and macOS jobs run on GitHub-hosted runners rather than in a
  // container, so there is no digest to pin. The runner image name and version
  // are the closest equivalent GitHub publishes, and without this half the jobs
  // would record no environment at all.
  const runner = /\bImage: (\S+)[\s\S]{0,400}?\bVersion: (\S+)/.exec(log);
  const deps: Record<string, string> = {};
  const repos = new Set<string>();
  // Dependencies arrive as plain package downloads, so each URL carries both the
  // resolved version and the repo it resolved from. The repo matters on its own:
  // p3m's ".../latest" is a moving snapshot, so it pins nothing and the versions
  // here are the only record of what "latest" meant that day.
  //
  // All three layouts, because only Linux installs from source. Windows and macOS
  // pull binaries out of bin/{windows,macosx}/…/contrib/{r}/ as .zip and .tgz, and
  // matching src/contrib alone missed 52% of jobs — the half where a
  // platform-specific failure most needs to know what it was built against.
  for (const m of log.matchAll(
    // The optional directory after contrib/ is the R minor, which only the binary
    // layouts carry: src/contrib/pkg.tar.gz but bin/windows/contrib/4.7/pkg.zip.
    /(https?:\/\/[\w.\-/]+?)\/(?:src|bin)\/[\w.\-/]*?contrib\/(?:[\w.]+\/)?([A-Za-z][\w.]*)_([0-9][\w.\-]*)\.(?:tar\.gz|tgz|zip)/g
  )) {
    repos.add(m[1]);
    deps[m[2]] = m[3];
  }
  const pin = image && digest ? `${image}@${digest}` : runner ? `${runner[1]}@${runner[2]}` : undefined;
  return { ...(pin ? { image: pin } : {}), repos: [...repos].sort(), deps };
}

// ---------- zip central directory ----------
// A zip's index sits at the END of the file, which is what makes fetching part of
// one possible: read the last slab, find the end-of-central-directory record, and
// every entry's name, size and byte offset falls out without touching the rest. A
// GHA check artifact is up to 7.6MB of built package tarball wrapped around ~65KB
// of logs, and the logs are the only part worth keeping.
//
// ponytail: no zip64. Offsets go 0xFFFFFFFF past 4GB or 65,535 entries, and these
// artifacts are single-digit MB with under ten files. Add it if that ever changes.
export type ZipEntry = { name: string; method: number; compressed: number; size: number; offset: number };

// `tailStart` is the absolute offset `tail` begins at, so a directory that fell
// outside the slab can be detected rather than misread. Null means "fetch more".
export function parseZipCentral(tail: Uint8Array, tailStart: number): ZipEntry[] | null {
  const dv = new DataView(tail.buffer, tail.byteOffset, tail.byteLength);
  const u16 = (p: number) => dv.getUint16(p, true);
  const u32 = (p: number) => dv.getUint32(p, true);
  let eocd = -1;
  // Scanning backwards finds the real record first when a stored file happens to
  // contain the signature bytes.
  for (let p = tail.length - 22; p >= 0; p--)
    if (u32(p) === 0x06054b50) { eocd = p; break; }
  if (eocd < 0) return null;
  const cdSize = u32(eocd + 12);
  const start = u32(eocd + 16) - tailStart;
  if (start < 0 || start + cdSize > tail.length) return null;
  const entries: ZipEntry[] = [];
  const dec = new TextDecoder();
  let p = start;
  while (p + 46 <= start + cdSize && u32(p) === 0x02014b50) {
    const n = u16(p + 28);
    entries.push({
      name: dec.decode(tail.subarray(p + 46, p + 46 + n)),
      method: u16(p + 10),
      compressed: u32(p + 20),
      size: u32(p + 24),
      offset: u32(p + 42),
    });
    p += 46 + n + u16(p + 30) + u16(p + 32); // + extra field + comment
  }
  return entries;
}

// Everything that is not the built package. The tarball is ~99% of an artifact's
// bytes and, for anything that propagated, is already in the CAS; the rest is text
// worth keeping whatever upstream adds to it next — today that is 00check.log,
// 00install.out, 00BiocCheck.log, output.log, build.log and the *.Rout transcripts.
export const isLogEntry = (name: string) =>
  !name.endsWith("/") && !/\.(tar\.gz|tgz|zip)$/i.test(name);

// GHA job ids are monotonically increasing, so one high-water mark is the entire
// "already captured" state — no per-job HEAD (26k+ per snapshot) and no key listing.
// ponytail: watermark captures forward only. Jobs predating the first capture run
// are skipped permanently; add a descending backfill sweep if those turn out to matter.
export function pendingJobIds(
  pkgs: { _jobs?: { job?: number }[] }[],
  cursor: number,
  limit: number
): number[] {
  const ids = new Set<number>();
  for (const p of pkgs)
    for (const j of p._jobs ?? []) {
      const n = Number(j.job);
      if (Number.isFinite(n) && n > cursor) ids.add(n);
    }
  return [...ids].sort((a, b) => a - b).slice(0, limit);
}

// Same forward-only walk, but the artifact id has to ride along: check logs are
// addressed by artifact while the cursor is over job ids. A job with no artifact
// id is skipped rather than counted — there is nothing to fetch for it.
export function pendingArtifacts(
  pkgs: { _jobs?: { job?: number; artifact?: string }[] }[],
  cursor: number,
  limit: number
): { job: number; artifact: string }[] {
  const found = new Map<number, string>();
  for (const p of pkgs)
    for (const j of p._jobs ?? []) {
      const n = Number(j.job);
      if (Number.isFinite(n) && n > cursor && j.artifact) found.set(n, j.artifact);
    }
  return [...found]
    .sort((a, b) => a[0] - b[0])
    .slice(0, limit)
    .map(([job, artifact]) => ({ job, artifact }));
}
