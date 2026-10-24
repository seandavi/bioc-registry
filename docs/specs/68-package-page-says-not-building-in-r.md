# Spec for #68: package page says "fails here" of a seed r-universe now builds

Issue: <https://github.com/seandavi/bioc-registry/issues/68> (label `review:ux`).

## Goal

Make the package page tell the truth about a seeded (`origin: "bioconductor"`)
entry. Today every seeded page says the package "builds in BBS and fails here",
including packages that r-universe now builds and checks clean at the same
version. The banner should say what the gate actually makes of the package's
current r-universe build. In particular it should explain the case Lori guessed
at in the issue: the seed stays because the version did not change.

Second, smaller goal from the issue comment: the `/logs` 404 body should stop
blaming "when capture was switched on" for jobs that are far newer than that.

## Non-goals

- **No gate change.** `evaluate()` keeps `replace_seed: false`. ADR 0011
  (bioc-infrastructure `adr/0011-one-propagation-gate-for-every-producer.md`,
  "evaluate() gates each r-universe wave with `replace_seed: false`") and the
  `GateConfig.replace_seed` comment (`src/repo.ts:667-670`) settle this. A seed
  in r-universe waits for a real version bump. This spec changes **0** served
  packages.
- No re-seeding and no change to `/seed`, `/topup`, the index entry shape,
  storage keys or the parquet schema.
- No new dashboard tile or count.
- No change to log capture itself. The missing log in the issue comment was the
  #69 token outage. Job `bioc/110338727789` (BiocFileCache, bioc-checks) now
  returns 200 from `/logs/bioc/110338727789`: `drainRequeue` re-captured it
  (checked 2026-10-24).

## Design

### Root cause

1. `src/index.ts:1477-1481`: `seededNote` is one fixed string for every entry
   where `originOf(prop) === "bioconductor"`: "This version was seeded from
   Bioconductor's own release build, not propagated through this registry's gate:
   it builds in BBS and fails here. …". It never looks at the observation `p`
   that the same function already loaded (`src/index.ts:1444`).
2. That claim was true when `/seed` ran (2026-08-14 for BiocFileCache). Packages
   keep rebuilding in r-universe after that. BiocFileCache 3.2.0 rebuilt on
   2026-10-01 (`_created`). In the latest bioc-release observation its build is
   `_status: success` and every gating job passes on R 4.6.1 (`source`,
   `linux-release-x86_64`, `windows-release-x86_64`, `macos-release-arm64` are all
   `OK`). So `gate()` passes `build-status` and `families` (`linux,win,mac`) and
   fails only `version-gate` ("3.2.0 is not > 3.2.0 (bioconductor)",
   `src/repo.ts:694-698`) because `replace_seed` is false
   (`src/index.ts:597`). The index still serves the seed: `version 3.2.0`,
   `origin: bioconductor`, `ts 2026-08-14T21:11:33Z`, source sha256 `a6fd59…`.
   r-universe's tarball for the same version is `a9fa5b…`.
3. `/logs` 404 body (`src/index.ts:1911-1914`): "log not captured (capture only
   walks forward from when it was switched on)." Job 110338727789 is from
   2026-10-01, months after capture was switched on. It was missing because of
   the #69 outage. The requeue backlog is still draining: `state/bioc/requeuepos`
   is 11718 of 49772 and `state/bioc-release/requeuepos` is 11236 of 42399, at
   150 jobs per cron run.

### Live measurement (2026-10-24)

Sources: `/data/prop/{u}/index.json` and the observation at `/data/state/{u}/latest`
→ `key` (`obs/bioc-release/dt=2026-10-24/2026-10-24T12:02:50.369Z-1cd282a8b3f9.json`,
`obs/bioc/dt=2026-10-24/2026-10-24T15:31:06.990Z-4d579a25a671.json`). Both
universes gate on R 4.6 (`config.yaml`: release 3.23, devel 3.24, both → 4.6).
The script below mimics `passingFamilies` and the version comparison. Every seed
fell into one of these buckets:

| universe | seeded | same version, passes build+families | newer version, fails | same version, fails | older version, fails |
|---|---|---|---|---|---|
| bioc-release | 148 | **21** (e.g. ASURAT, AUCell, bandle, BiocFileCache, BUMHMM, CTdata, HelloRanges, MethylSeekR) | 37 | 73 | 17 |
| bioc | 117 | **18** (e.g. BUSseq, CBN2Path, chipenrich, CNVrd2, cosmiq, GeomxTools) | 15 | 79 | 5 |

So **39 package pages** say something false today. They change to the "held by
the version gate" banner. The other 226 seeded pages get a banner that names the
failing rule. No seed is in the "newer version passes" bucket, which is expected:
those would already have propagated. The registry serves exactly what it serves
today for all 265.

### Changes

**`src/index.ts`**

1. Extract evaluate's per-package gate input (now inline at
   `src/index.ts:600-608`) into one function, so the page asks the question
   the wave asks:

   ```ts
   // The question evaluate() asks of each observed package; the package page asks
   // it too, so its seed banner (#68) reads the same decision the wave made.
   function observedGateInput(p: FullPkg): GateInput | null {
     // No source tarball means nothing to propagate, whatever the checks say.
     if (!p.Package || !p.Version || !p._sha256) return null;
     return {
       package: p.Package, version: p.Version, origin: "r-universe",
       build_status: p._status ?? "", jobs: p._jobs ?? [], desc: describe(p),
     };
   }
   ```

   `evaluate()` then loops `const input = observedGateInput(p); if (!input) continue;
   byName.set(p.Package, p); inputs.push(input);`, which behaves the same as before.

2. Extract the r-universe wave config literal at `src/index.ts:597` into
   `const waveGateConfig = (gating_r: string): GateConfig => ({ gating_r, bioccheck: "advisory", replace_seed: false });`
   and use it in `evaluate()` and in `pkgPage`. One literal means the page cannot
   drift from the wave.

3. In `pkgPage` (`src/index.ts:1439`), keep the whole index:
   `const idx = await readIndex(env, universe); const prop = idx[name];`. Only when
   `seeded` is true, compute:

   ```ts
   const gatingR = seeded ? await gatingRMinor(universe).catch(() => null) : null;
   const input = gatingR ? observedGateInput(p) : null;
   const decision = input ? gate([input], waveGateConfig(gatingR!), idx).decisions[name] : null;
   ```

   (Narrow the types however `tsc` needs; leave the logic as written.) The
   config.yaml fetch happens only on seeded pages, and an outage drops back to the
   neutral banner below, the same way `summarize()` degrades
   (`src/index.ts:1183`).

4. Replace the `seededNote` string with one chosen from `decision`. Each banner
   keeps the existing `<p class="warn">` wrapper. Every interpolated value goes
   through `esc()`. Let `S` = "This version was seeded from Bioconductor's own
   release build, not propagated through this registry's gate."

   | condition | banner text |
   |---|---|
   | `decision` is null (gating R unresolved, or the observation has no `Version`/`_sha256`) | `S` + " It is replaced the ordinary way, when the maintainer bumps the version and r-universe builds it." |
   | `decision.propagate` | `S` + " r-universe's build of ${p.Version} now passes the gate; the next propagation wave replaces this seed." |
   | `rejectedRule(decision) === "version-gate"` and `p.Version === prop.version` | `S` + " r-universe now builds this same version (${p.Version}) and its checks pass on ${decision.archs.join(", ")}, but a version is published here only once, so the seeded copy stays until the maintainer bumps the version and r-universe builds the new one." |
   | `rejectedRule(decision) === "version-gate"` otherwise | `S` + " r-universe's current build (${p.Version}) is not newer than this seed (${prop.version}), so it is replaced only when r-universe builds a higher version that passes the gate." |
   | any other rejected rule `r` with reason `x = decision.reasons.find((q) => !q.ok)` | "This version was seeded from Bioconductor's own release build, not propagated through this registry's gate: it builds in BBS and fails here. r-universe's current build (${p.Version}) fails the gate's ${x.rule} rule" + (x.detail ? ` (${x.detail})` : "") + `. It is replaced when r-universe builds a version newer than ${prop.version} that passes the gate.` |

   `gate`, `rejectedRule`, `GateConfig` and `GateInput` are already imported from
   `./repo.js` (`src/index.ts:12`); no import changes. Update the comment above `seededNote` so it says why the banner reads
   the gate (a seed outlives the failure that made it, see #68), not what the code
   does.

5. Replace the `/logs` 404 body (`src/index.ts:1911-1914`) with:

   ```ts
   `log not captured. Capture walks forward through job ids on the cron, so a recent job\n` +
     `can take a few runs to arrive, and jobs missed during a capture outage are drained\n` +
     `from a backlog; a job GitHub deleted (~90 days) before capture reached it is gone.\n` +
     `While GHA still has it: https://github.com/r-universe/${u}/runs/${job}\n`
   ```

   The status (404), content type (`text/plain; charset=utf-8`) and the
   `no-store`-by-default caching stay as they are.

**`src/repo.ts`**: no change. `gate()`, `rejectedRule` and `GateConfig` are used
as they are.

**`src/repo.test.ts`**: one test, next to the existing
`"gate: version-gate is strict; replace_seed lets bioc-build replace a bioconductor seed once"`
(`src/repo.test.ts:772`):

```ts
test("gate: an r-universe build of a seeded version is held by version-gate alone, with its passing archs", () => {
  const seeded = { BiocFileCache: { version: "3.2.0", sha256: "x", ts: "t", artifacts: [], origin: "bioconductor" as const } };
  const jobs = [
    { config: "source", r: "4.6.1", check: "OK" },
    { config: "linux-release-x86_64", r: "4.6.1", check: "OK" },
    { config: "windows-release-x86_64", r: "4.6.1", check: "OK" },
    { config: "macos-release-arm64", r: "4.6.1", check: "OK" },
  ];
  const d = gate([cand({ package: "BiocFileCache", version: "3.2.0", origin: "r-universe", jobs })], GATE_CFG, seeded)
    .decisions.BiocFileCache;
  assert.equal(d.propagate, false);
  assert.equal(rejectedRule(d), "version-gate");
  assert.deepEqual(d.archs, ["linux", "win", "mac"]);
});
```

This pins down the property the "held" banner depends on: when the seed is the
only obstacle, `version-gate` is the first failing rule, and `archs` still lists
the families that passed.

### Gate rules / GateConfig

No change to any rule or to `GateConfig`. The producers (`evaluate`,
`POST /publish`, `POST /gate`) decide exactly as before. The page becomes a
fourth, read-only caller of `gate()`, using the config `evaluate()` uses.

### Routes, status codes, content types

None change. `/pkg/{universe}/{package}` and `/logs/{universe}/{job}` keep their
paths, statuses and content types. Their OpenAPI descriptions
(`src/openapi.ts:251-268`, `344-354`) stay true and need no edit.

### Storage keys / index entry

None.

### User-facing text that must change to stay true

- The `/pkg` seed banner (above).
- The `/logs` 404 body (above).
- `docs/api.md`, `GET /pkg/{universe}/{package}` paragraph (line ~29). Replace
  "for a seeded entry — a banner saying it came from Bioconductor's release build
  rather than this gate" with "for a seeded entry — a banner saying it came from
  Bioconductor's release build rather than this gate, and what the gate makes of
  the package's current r-universe build: for example held by the version gate
  because r-universe builds the same version clean, or the rule it fails".
- `README.md`, "Two ways in", after "…so a seeded package is replaced the ordinary
  way: the maintainer bumps the version and r-universe builds it." add: "Until
  then the seed stays even if r-universe later builds that same version clean;
  the package page says which case a package is in."
- Code comments that repeat the old claim stay as they are. They describe why
  seeding exists, which is still true: `src/index.ts:814-820`, and `/seed` in
  `docs/api.md` lines ~291-302.

## Acceptance criteria

- [ ] `git diff main --stat` touches only `src/index.ts`, `src/repo.test.ts`,
      `docs/api.md`, `README.md` (and this spec).
- [ ] `observedGateInput` and `waveGateConfig` exist in `src/index.ts` and are the
      only place the r-universe gate input and wave config are built. `evaluate()`
      uses both, and `grep -n 'replace_seed: false' src/index.ts` finds only the
      `waveGateConfig` definition (`POST /gate`'s `body.config?.replace_seed ?? false`
      at `src/index.ts:1741` is a caller default and stays).
- [ ] `pkgPage` calls `gatingRMinor` only when the entry is seeded, and catches its
      failure into the neutral banner.
- [ ] The five banner texts match the table above. The literal phrase "it builds
      in BBS and fails here" appears only in the failing-rule banner.
- [ ] The `/logs` 404 body matches the text above. Status 404 and content type
      are unchanged.
- [ ] The new `src/repo.test.ts` test exists and passes, and it fails if
      `version-gate` stops being the first rejected rule for a clean same-version
      r-universe build of a seed.
- [ ] `docs/api.md` `/pkg` paragraph and `README.md` "Two ways in" are updated as
      specified.
- [ ] `npm test` passes, and `npx tsc -p . --noEmit 2>&1 | grep -E '^src/'` prints
      nothing.
- [ ] No change to `src/repo.ts` gate logic, `GateConfig`, `src/openapi.ts`,
      storage keys or the index shape.

## Test plan

- `npm test`: the whole suite, including the new gate test.
- `npx tsc -p . --noEmit 2>&1 | grep -E '^src/'`: must print nothing.
- Wiring in `pkgPage` is not unit-tested by design (AGENTS.md). After the
  maintainer deploys, check by hand (read-only GETs):
  - `/pkg/bioc-release/BiocFileCache` shows the "same version (3.2.0) … pass on
    linux, win, mac … seeded copy stays" banner.
  - `/pkg/bioc-release/AnnotationDbi` shows the failing banner with
    "fails the gate's families rule (no family passed on R 4.6)".
  - `/logs/bioc-release/1` returns 404 with the new body.
- Optional local smoke: run `npm run dev`, then `/poll`, then `/seed` (with no
  `MAINT_KEY` set locally) to load seeds into local R2, then open the pages above.
  This is not required. Seeding locally pulls hundreds of MB from bioconductor.org.

## Risks

- **Extra subrequest on seeded pages.** One `bioconductor.org/config.yaml` fetch
  per seeded page view (265 packages), the same one the dashboard already makes on
  every view. If it fails, the page shows the neutral banner; the page itself
  never errors.
- **Single-input `deps` rule.** On the page, `gate()` sees one candidate rather
  than the whole wave, so the `deps` fixpoint can reject what the real wave would
  approve. This only matters in the `propagate`/`deps` branches, and none of the
  265 seeds are there today. The `deps` text names the dependency, so it is still
  a true statement about this candidate alone.
- **Banner and wave can disagree for a moment.** The page reads the latest
  observation. The index reflects the last finished wave. Between the two, the
  "next propagation wave replaces this seed" banner is the accurate one.
- **The banner states policy that ADR 0011 could change.** If `replace_seed`
  ever becomes true for r-universe, the "held" banner text must change in the same
  PR. `waveGateConfig` is where that decision would be made.

### Measurement script

Run with the four JSON files above saved locally (`python3 -I measure.py`):

```python
import json, re, collections
def fam(c):
    if c == "source": return "linux"
    arm = "arm64" in c
    if c.startswith("linux-") and not arm: return "linux"
    if c.startswith("windows-") and not arm: return "win"
    if c.startswith("macos-") and arm: return "mac"
def passing(jobs, r):
    g = {}
    for j in jobs:
        if not (j.get("r") or "").startswith(r + "."): continue
        f = fam(j["config"])
        if f: g[f] = g.get(f, True) and (j.get("check") or "") not in ("ERROR", "FAIL", "FAILURE")
    return [f for f in ("linux", "win", "mac") if g.get(f)]
key = lambda v: [int(x) for x in re.split(r"[.-]", v) if x]
for u, r, idxf, obsf in [("bioc-release", "4.6", "rel-index.json", "rel-obs.json"),
                         ("bioc", "4.6", "dev-index.json", "dev-obs.json")]:
    idx = json.load(open(idxf)); obs = {p["Package"]: p for p in json.load(open(obsf))}
    c = collections.Counter()
    for n, e in idx.items():
        if e.get("origin") != "bioconductor": continue
        p = obs.get(n)
        if not p: c["not-observed"] += 1; continue
        ok = p.get("_status") == "success" and passing(p.get("_jobs") or [], r) and p.get("_sha256")
        v = p.get("Version", "")
        rel = "same" if v == e["version"] else ("newer" if key(v) > key(e["version"]) else "older")
        c[f"{rel}-{'passes' if ok else 'fails'}"] += 1
    print(u, dict(c))
```
