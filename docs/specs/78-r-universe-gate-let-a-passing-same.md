# Spec for #78: let a passing same-version r-universe build replace a seed

Issue: <https://github.com/seandavi/bioc-registry/issues/78> (label `review:ux`).
Follow-up to #68 / #77.

## Goal

A seeded entry (`origin: "bioconductor"`) is replaced the first time r-universe
builds **that version** (or a newer one) and the build passes the gate. Today
the r-universe wave gates with `replace_seed: false`, so a seed waits for a
version bump even when r-universe already builds the seeded version clean.
SPEC-014's rule, "a seed is not a verdict, our build of it is", already governs
bioc-build (`POST /publish` gates with `replace_seed: true`). This change applies
it to r-universe waves as well.

The package page banner and the prose (comments, README, `docs/api.md`) must
describe the new behaviour.

## Non-goals

- No change to `gate()`'s rules. The `replace_seed` branch already exists
  (`src/repo.ts:696-697`). Only the r-universe wave's config value changes.
- `POST /gate` keeps defaulting `replace_seed` to `false`
  (`src/index.ts:1774`). Its request, response, status codes and content type do
  not change, so `src/openapi.ts` needs no edit.
- No change to storage keys, the index entry shape or the parquet schema. A
  replaced entry is the ordinary `origin: "r-universe"` entry that
  `propagateBatch` already writes.
- No change to `/seed`, `/topup`, `topUpSeeds` or `seedBinaryTopUp`. They already
  leave a replaced entry alone (see "Interactions" below).
- No edit to ADR 0011 in `seandavi/bioc-infrastructure`. Its line about
  `replace_seed: false` describes the current code; it is not an argument for
  it. Updating that ADR is a separate change in that repo (see Risks).

## Design

### Root cause

- `src/index.ts:592-596`: `waveGateConfig` sets `replace_seed: false`. Its comment
  says "a seed waits for a real version bump (ADR 0011)".
- `src/repo.ts:667-670`: the `GateConfig.replace_seed` comment explains why:
  "r-universe never re-publishes a version, so a seed there waits for a real
  bump." That is false. r-universe rebuilds the same version. BiocFileCache 3.2.0
  (bioc-release) was seeded on 2026-08-14. r-universe rebuilt 3.2.0 on 2026-10-01
  with `_status: success`, and every gating job is `OK` on R 4.6.1. The page's
  gate decision fails only `version-gate: 3.2.0 is not > 3.2.0 (bioconductor)`
  (`src/repo.ts:698`).
- With `replace_seed: true`, `gate()` passes `version-gate` when
  `c.version === prev.version && prevOrigin === "bioconductor"`
  (`src/repo.ts:696-697`). The wave then propagates the r-universe build, and
  `propagateBatch` overwrites the whole entry with `origin: "r-universe"`
  (`src/index.ts:721-727`). On the next wave `prevOrigin` is `r-universe`, so the
  same version fails `version-gate` again. The replacement happens once.

### Interactions (checked; none fight the replacement)

- **`/seed` repair.** `seedPlan` (`src/index.ts:944`) and `seedBatch`
  (`src/index.ts:987`) touch only entries that are absent or `invisible`.
  A replaced entry has a `desc`, so neither re-seeds over it.
- **`topUpSeeds` / `seedBinaryTopUp`.** Both filter on
  `originOf(e) === "bioconductor"` (`src/index.ts:796`, `src/repo.ts:844`), so a
  replaced entry drops out. `topUpSeeds` might plan from an index read taken
  before the replacement. Even then, `applyTopUp` skips the stale entry, because
  it writes only when `e.sha256 === a.sha256` (`src/index.ts:753`) and the
  r-universe source tarball has a different sha256 from the seed (BiocFileCache:
  `a9fa5b…` against `a6fd59…`).
- **`topUp` (r-universe).** `topUpBinaries` only acts on `origin: "r-universe"` at
  the observed version (`src/repo.ts:273`). That is the right thing for a
  replaced entry: it widens `archs` and adds binaries the same way it does for
  every other propagated entry.
- **`deps`.** A seed is in `idx`, so it satisfies dependants before and after.
- **Written records.** The seed's CAS bytes and its `prop/{u}/log/…` record stay,
  because both are write-once. The replacement adds a new log record, the same
  as any propagation.

### Files to change

**`src/repo.ts`**

1. Move `waveGateConfig` here from `src/index.ts`, exported, so the test can pin
   down the real wave config. Put it directly after the `GateConfig` type:

   ```ts
   // The one config every r-universe wave gates with; the package page reads it
   // too (#68), so the page cannot drift from the wave. replace_seed is true
   // (#78): r-universe does rebuild a version it already published, and a seed is
   // not a verdict, a passing build of it is (SPEC-014), whichever producer built it.
   export const waveGateConfig = (gating_r: string): GateConfig =>
     ({ gating_r, bioccheck: "advisory", replace_seed: true });
   ```

2. Replace the `replace_seed` comment inside `GateConfig` (`src/repo.ts:667-669`)
   with:

   ```ts
   // A same-version build may replace a bioconductor-seeded entry, once: the
   // replacement's origin is no longer "bioconductor" (SPEC-014: a seed is not a
   // verdict, our build of it is). r-universe waves and POST /publish set it;
   // POST /gate defaults it off.
   ```

**`src/index.ts`**

1. Delete the local `waveGateConfig` and its comment (`src/index.ts:592-596`).
   Add `waveGateConfig` to the existing `./repo.js` import list (`src/index.ts:12`
   or `:13`). `evaluate()` (`:614`) and `pkgPage` (`:1497`) keep their current
   calls.
2. In `evaluate()`, update the comment above `blocked` (`src/index.ts:645-649`)
   so it is true. With `replace_seed: true`, a seed whose same-version build
   fails now passes `version-gate`, so it is listed in
   `prop/{u}/blocked/{digest}.json` on every wave until it lands. That is
   intended: it is a candidate waiting on its blocker. Leave the filter as it
   is. Replace the first two comment lines with:
   `// Only versions the version gate lets in (new, or replacing a seed) that`
   `// still failed: the`, and keep the rest of the comment unchanged.
3. Seeding comment (`src/index.ts:828-834`). Replace "Seeding is strictly
   additive — it only ever fills a hole, never displaces or blocks a propagated
   entry, and the version gate is untouched, so a seeded package is replaced the
   ordinary way: the maintainer bumps the version and r-universe builds it." with
   "Seeding is strictly additive — it only ever fills a hole, never displaces or
   blocks a propagated entry — and a seed is replaced the first time an
   r-universe build of that version, or a newer one, passes the gate (#78)."
4. Seed banner in `pkgPage` (`src/index.ts:1498-1513`):
   - `replacedBy` becomes
     `"It is replaced the first time an r-universe build of this version, or a newer one, passes the gate."`
   - The `decision.propagate` branch stays as it is. It now covers the
     BiocFileCache case: "r-universe's build of 3.2.0 now passes the gate; the
     next propagation wave replaces this seed."
   - **Delete** the branch `rejectedRule(decision) === "version-gate" && ver === prop.version`
     (`:1507-1508`). It can no longer be reached: with `replace_seed: true` and
     `prevOrigin === "bioconductor"`, an equal version always passes
     `version-gate`.
   - The remaining `version-gate` branch becomes
     `` `${S} r-universe's current build (${esc(ver)}) is not newer than this seed (${esc(prop.version)}), so it is replaced when r-universe builds ${esc(prop.version)} or a newer version and that build passes the gate.` ``
   - In the failing-rule branch, replace the last sentence
     `` It is replaced when r-universe builds a version newer than ${esc(prop.version)} that passes the gate. ``
     with
     `` It is replaced as soon as an r-universe build of ${esc(prop.version)}, or of a newer version, passes the gate. ``
     The rest of that string, including "it builds in BBS and fails here", stays.
   - Keep the comment above the banner (`:1492-1494`) as it is. It is still true.
5. Dashboard "why are packages not propagated?" list, rule 3 (`src/index.ts:1291`):
   `<li>The version is a strict bump over the version already propagated, or the same version as a Bioconductor seed it replaces.</li>`.
   Same wording as README mermaid node C.

**`src/repo.test.ts`**

- Add `waveGateConfig` to the import from `./repo.ts` (line 4).
- **Replace** the #77 test
  `"gate: an r-universe build of a seeded version is held by version-gate alone, with its passing archs"`
  (`src/repo.test.ts:783-796`). It asserts the old wave policy, so remove it and
  put this test in its place:

  ```ts
  test("gate: the r-universe wave config lets a passing same-version build replace a seed, once", () => {
    const seeded = { BiocFileCache: { version: "3.2.0", sha256: "x", ts: "t", artifacts: [], origin: "bioconductor" as const } };
    const jobs = [
      { config: "source", r: "4.6.1", check: "OK" },
      { config: "linux-release-x86_64", r: "4.6.1", check: "OK" },
      { config: "windows-release-x86_64", r: "4.6.1", check: "OK" },
      { config: "macos-release-arm64", r: "4.6.1", check: "OK" },
    ];
    const c = cand({ package: "BiocFileCache", version: "3.2.0", origin: "r-universe", jobs });
    const d = gate([c], waveGateConfig("4.6"), seeded).decisions.BiocFileCache;
    assert.equal(d.propagate, true);
    assert.deepEqual(d.archs, ["linux", "win", "mac"]);
    // propagateBatch rewrites the entry with origin r-universe; the next wave at
    // the same version must not propagate it again.
    const replaced = { BiocFileCache: { ...seeded.BiocFileCache, origin: "r-universe" as const } };
    const again = gate([c], waveGateConfig("4.6"), replaced).decisions.BiocFileCache;
    assert.equal(again.propagate, false);
    assert.equal(rejectedRule(again), "version-gate");
  });
  ```

  This test fails if `waveGateConfig` goes back to `replace_seed: false`. It also
  fails if the `replace_seed` branch of `gate()` stops checking
  `prevOrigin === "bioconductor"`.

**`README.md`**

- "The gate" mermaid node C (`README.md:92`): change
  `C{"version is a strict<br/>bump over the<br/>propagated one?"}` to
  `C{"version is a strict<br/>bump over the<br/>propagated one, or<br/>replaces a seed?"}`.
- "Two ways in" (`README.md:123-127`): replace "Seeding is strictly additive — it
  only fills holes, and the version gate is untouched, so a seeded package is
  replaced the ordinary way: the maintainer bumps the version and r-universe
  builds it. Until then the seed stays even if r-universe later builds that same
  version clean; the package page says which case a package is in." with
  "Seeding is strictly additive — it only fills holes. A seed is not a verdict, so
  it is replaced the first time r-universe builds that version, or a newer one,
  and the build passes the gate; until then the package page says what stands in
  the way." The sentence after it ("The dashboard counts the two apart, …")
  stays.

**`docs/api.md`**

- `GET /pkg/{universe}/{package}` (`docs/api.md:29-32`): replace "for example held
  by the version gate because r-universe builds the same version clean, or the
  rule it fails" with "for example that the next propagation wave replaces the
  seed because r-universe's build now passes, or the rule it fails".
- `/seed` (`docs/api.md:303-304`): replace "The version gate is untouched — a
  seeded package is replaced the ordinary way, when its maintainer bumps the
  version and r-universe builds it." with "A seeded package is replaced the first
  time an r-universe build of that version, or a newer one, passes the gate:
  r-universe waves gate with `replace_seed: true`, as `POST /publish` does."
- `POST /gate` (`docs/api.md:459`): after "`replace_seed` to `false`", add
  "(r-universe waves and `POST /publish` both gate with `true`, so pass it to
  ask what a wave would do with a seeded package)". This documents an
  existing default; the route does not change.

### Gate rules / GateConfig

No rule changes, and `GateConfig` keeps its type. The value
`replace_seed: false → true` changes for the **r-universe wave** producer
(`evaluate()`) and for its read-only reader, the package page banner. Both use
`waveGateConfig`. `POST /publish` already uses `true`. `POST /gate` keeps its
caller default of `false`.

### Routes, status codes, content types

None change. `src/openapi.ts` stays as it is.

### Storage keys / index entry

No new keys or fields. Two existing keys get different contents:
`prop/{u}/index.json` (39 entries flip `origin` to `r-universe`, see below), and
`prop/{u}/blocked/{digest}.json`, which now also lists same-version seeds whose
build fails. That key is undocumented in `docs/api.md` and `docs/DATAPLANE.md`,
and nothing in `src/` reads it.

### Live blast radius (measured 2026-10-24)

Sources:
- the index: `/data/prop/{u}/index.json`
- the observation: `/data/state/{u}/latest` → `key`
  - bioc: `obs/bioc/dt=2026-10-25/2026-10-25T00:01:09.539Z-761fbe498dd5.json`
  - bioc-release: `obs/bioc-release/dt=2026-10-24/2026-10-24T12:02:50.369Z-1cd282a8b3f9.json`

The gating R is 4.6 for both universes (`config.yaml`: release 3.23, devel 3.24,
both map to 4.6). The script at the end of this spec imports the real `gate()`,
`describe()` and `binaryArtifacts()` from `src/repo.ts`, builds inputs the way
`observedGateInput` does, and runs the whole wave with `replace_seed` false and
then true.

| universe | seeds | approved (false) | approved (true) | first-wave replacements | blocked/ rows (false → true) |
|---|---|---|---|---|---|
| bioc | 117 | 0 | 18 | **18** | 57 → 136 |
| bioc-release | 148 | 0 | 21 | **21** | 80 → 153 |

- **39 entries** are replaced on the first wave after deploy. Every one of them
  is a seed at the same version as r-universe's build. `deps` blocks none.
  - bioc: methodical, pathRender, CBN2Path, tidyCoverage, BUSseq, InterCellar,
    GeomxTools, rebook, RepViz, LRBaseDbi, missRows, OmaDB, Scale4C, SPLINTER,
    cosmiq, CNVrd2, chipenrich, PANR.
  - bioc-release: scToppR, MetMashR, tidyCoverage, CTdata, scviR, bandle, ASURAT,
    segmenter, sitadela, VplotR, rebook, AUCell, TFARM, BiocFileCache, BUMHMM,
    HelloRanges, PureCN, rCGH, missMethyl, rBiopaxParser, MethylSeekR.
- **Replacements by passing families (`archs`).** 34 pass `linux,win,mac`. 3 pass
  `linux,mac` (tidyCoverage in both universes, scviR). 1 passes `linux,win`
  (MethylSeekR). 1 passes `win` only (sitadela).
- **Binaries lost.** Compared per (os, R minor), only one entry loses a binary
  platform that its seed had. MethylSeekR (bioc-release) loses its mac binaries
  because r-universe's mac check fails on R 4.6. The seeds have no linux
  binaries, so every other replacement keeps or gains platforms.
- **Why the issue says 46 and 53.** That count was of seeds with a same-version
  build and `_status: success`. Of those, 28 (bioc) and 32 (bioc-release) still
  fail `families`: no family passes on R 4.6. The gate's own count is 18 and 21.
  It matches #68's 39.
- **`blocked/` growth.** 79 (bioc) and 73 (bioc-release) more rows per wave, made
  up of 28+51 and 32+41 failing on `families`/`build-status`. Each row is a seed
  whose same-version build fails.
- The other 226 seeds (99 bioc, 127 bioc-release) are still served as they
  are. That includes 5 and 17 that have no source tarball in the observation.

## Acceptance criteria

- [ ] `git diff main --stat` touches only `src/repo.ts`, `src/index.ts`,
      `src/repo.test.ts`, `README.md`, `docs/api.md` (and this spec).
- [ ] `waveGateConfig` is exported from `src/repo.ts` with `replace_seed: true`,
      and `src/index.ts` imports it and no longer defines it.
- [ ] `grep -n 'replace_seed: false' src/index.ts src/repo.ts` prints nothing.
      `POST /gate`'s `body.config?.replace_seed ?? false` is still present.
- [ ] The `GateConfig.replace_seed` comment no longer says r-universe never
      re-publishes a version.
- [ ] The seed banner has no same-version "held" branch. The phrase "published
      here only once" appears nowhere in `src/`. `replacedBy`, the
      `version-gate` branch and the failing-rule branch use the text specified
      above. The failing-rule text says that a passing build of
      `${prop.version}` counts.
- [ ] The new `src/repo.test.ts` test exists and passes, and the #77 "held by
      version-gate alone" test is gone. Flipping `waveGateConfig` to
      `replace_seed: false` makes the new test fail.
- [ ] The README mermaid node, README "Two ways in", `docs/api.md` `/pkg`, `/seed`
      and `POST /gate` paragraphs match the text specified above.
      `grep -rn "bumps the version" README.md docs/api.md src/` prints nothing.
- [ ] The comments in `evaluate()` (above `blocked`) and above the seeding section
      are updated as specified.
- [ ] `npm test` passes, and `npx tsc -p . --noEmit 2>&1 | grep -E '^src/'` prints
      nothing.
- [ ] `src/openapi.ts`, storage keys, the index entry shape and `gate()`'s body
      are unchanged.
- [ ] The PR description states the blast radius: 18 (bioc) + 21
      (bioc-release) seeds replaced on the first wave, MethylSeekR's lost mac
      binary, and the `blocked/` growth.

## Test plan

- `npm test` runs the whole suite, including the replacement test.
- `npx tsc -p . --noEmit 2>&1 | grep -E '^src/'` must print nothing.
- Mutation check by hand: temporarily set `replace_seed: false` in
  `waveGateConfig`, run `npm test`, confirm the new test fails, then revert.
- Wiring (`evaluate`, `pkgPage`) is not unit-tested by design (AGENTS.md). After
  the maintainer deploys and the next wave runs, check with read-only GETs:
  - `/data/prop/bioc-release/index.json`: `BiocFileCache` has
    `origin: "r-universe"`, version `3.2.0`, and a sha256 that is not `a6fd59…`.
  - `/pkg/bioc-release/BiocFileCache` shows no seed banner.
  - `/pkg/bioc-release/AnnotationDbi` (still seeded and failing) ends with "It is
    replaced as soon as an r-universe build of … or of a newer version, passes
    the gate."
  - The dashboard's "seeded from Bioconductor" tile drops by 18 (bioc) and 21
    (bioc-release), give or take observation churn.

## Risks

- **Bytes change under an unchanged version.** For 39 packages, the tarball
  served at the same version changes from Bioconductor's build to r-universe's.
  Users who pinned a sha256, or who cache by version, see different bytes. This
  is what SPEC-014 already accepts for bioc-build replacements.
- **One platform regresses.** MethylSeekR (bioc-release) loses its mac binaries.
  Mac users fall back to a source install until r-universe's mac check passes.
  `topUp` then widens `archs` and adds the binary on its own. All 2000+
  propagated packages already follow this per-family rule.
- **`blocked/` is noisier.** About 75 more rows per universe per wave. Nothing
  reads it today. If a reader appears, filter out the
  `version-gate` detail "replaces the bioconductor seed".
- **ADR 0011 goes stale.** The ADR in `seandavi/bioc-infrastructure` still says
  `evaluate()` gates with `replace_seed: false`. Updating it is a follow-up in
  that repo and is out of scope here.
- **Unexpected first-wave size.** The counts come from one observation. The next
  observation may add or remove a few. The first wave runs on the next upstream
  change after deploy, or immediately if the maintainer relaunches `/backfill`.

### Measurement script

Save the four JSON files above as `{u}-index.json` and `{u}-obs.json` in one
directory, put this script somewhere else, and run
`node --experimental-strip-types measure.ts <path>/src/repo.ts <dataDir>`:

```ts
import { readFileSync } from "node:fs";
const [repoTs, dir] = process.argv.slice(2);
const { gate, describe, binaryArtifacts } = await import(repoTs);
for (const u of ["bioc", "bioc-release"]) {
  const idx = JSON.parse(readFileSync(`${dir}/${u}-index.json`, "utf8"));
  const pkgs = JSON.parse(readFileSync(`${dir}/${u}-obs.json`, "utf8"));
  const inputs = [], by = new Map();
  for (const p of pkgs) {
    if (!p.Package || !p.Version || !p._sha256) continue;
    by.set(p.Package, p);
    inputs.push({ package: p.Package, version: p.Version, origin: "r-universe",
      build_status: p._status ?? "", jobs: p._jobs ?? [], desc: describe(p) });
  }
  const run = (rs) => gate(inputs, { gating_r: "4.6", bioccheck: "advisory", replace_seed: rs }, idx);
  const off = run(false), on = run(true);
  const newly = on.approved.filter((n) => !off.approved.includes(n));
  const blk = (r) => Object.values(r.decisions)
    .filter((d) => !d.propagate && d.reasons.some((x) => x.rule === "version-gate" && x.ok)).length;
  const lost = newly.filter((n) => {
    const d = on.decisions[n], p = by.get(n);
    const slot = (a) => `${a.os}/${a.r.split(".").slice(0, 2).join(".")}`;
    const nw = new Set(binaryArtifacts(n, p.Version, p._binaries, d.archs).map(slot));
    return idx[n].artifacts.some((a) => a.os !== "src" && !nw.has(slot(a)));
  });
  console.log(u, { newly: newly.length, blocked: [blk(off), blk(on)], lost, newlyNames: newly });
}
```
