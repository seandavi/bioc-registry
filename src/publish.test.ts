// node --test --experimental-strip-types src/publish.test.ts
import { test } from "node:test";
import assert from "node:assert/strict";
import { validatePublish, upsertEntry, mergeAttempt } from "./repo.ts";
import type { PropIndex, PublishEntry } from "./repo.ts";

const UNIVERSES = ["bioc", "bioc-release"];

const ENTRY: PublishEntry = {
  version: "0.51.1",
  sha256: "a".repeat(64),
  ts: "2026-09-03T00:00:00Z",
  bioccheck: "ok",
  archs: ["linux"],
  artifacts: [{ os: "src", r: "4.6", sha256: "a".repeat(64), file: "msdata_0.51.1.tar.gz" }],
  desc: { License: "Artistic-2.0" },
  meta: { Title: "msdata", commit: { id: "deadbeef" }, git_url: "https://git.bioconductor.org/packages/msdata" },
  origin: "bioc-build",
};

const BODY = {
  universe: "bioc-release", package: "msdata", run_id: "12345",
  entry: ENTRY,
  attempt: { commit: "deadbeef", status: "ok", run_url: "https://github.com/…/runs/12345", ts: ENTRY.ts },
};

test("validatePublish accepts a well-formed body with an entry", () => {
  const v = validatePublish(BODY, UNIVERSES);
  assert.equal(v.ok, true);
});

test("validatePublish accepts an attempt-only body (failed/rejected build)", () => {
  const v = validatePublish({ universe: "bioc", package: "msdata", run_id: "9", attempt: { commit: "c", status: "failed:check" } }, UNIVERSES);
  assert.equal(v.ok, true);
});

test("validatePublish rejects an unknown universe", () => {
  const v = validatePublish({ ...BODY, universe: "cran" }, UNIVERSES);
  assert.equal(v.ok, false);
});

test("validatePublish rejects a malformed package name", () => {
  const v = validatePublish({ ...BODY, package: "../etc" }, UNIVERSES);
  assert.equal(v.ok, false);
});

test("validatePublish rejects a non-64-hex sha256", () => {
  const v = validatePublish({ ...BODY, entry: { ...ENTRY, sha256: "not-hex" } }, UNIVERSES);
  assert.equal(v.ok, false);
});

test("validatePublish rejects an entry whose first artifact is not src", () => {
  const v = validatePublish({ ...BODY, entry: { ...ENTRY, artifacts: [{ os: "linux", r: "4.6", sha256: "a".repeat(64), file: "x" }] } }, UNIVERSES);
  assert.equal(v.ok, false);
});

test("validatePublish rejects an empty desc", () => {
  const v = validatePublish({ ...BODY, entry: { ...ENTRY, desc: {} } }, UNIVERSES);
  assert.equal(v.ok, false);
});

test("validatePublish rejects entry.origin other than bioc-build", () => {
  const v = validatePublish({ ...BODY, entry: { ...ENTRY, origin: "r-universe" } }, UNIVERSES);
  assert.equal(v.ok, false);
});

test("validatePublish rejects a missing attempt", () => {
  const { attempt, ...rest } = BODY;
  const v = validatePublish(rest, UNIVERSES);
  assert.equal(v.ok, false);
});

test("upsertEntry adds a new package and reports changed", () => {
  const { idx, changed } = upsertEntry({}, "msdata", ENTRY as unknown as PropIndex[string]);
  assert.equal(changed, true);
  assert.equal(idx.msdata.version, "0.51.1");
});

test("upsertEntry is a no-op when the entry is identical (self-heal re-POST)", () => {
  const idx0: PropIndex = { msdata: ENTRY as unknown as PropIndex[string] };
  const { idx, changed } = upsertEntry(idx0, "msdata", ENTRY as unknown as PropIndex[string]);
  assert.equal(changed, false);
  assert.equal(idx, idx0);
});

test("upsertEntry is NOT a no-op when only ts differs — why /publish must reuse entry.ts (not attempt.ts/now) across a self-heal re-POST, or every sweep would write a fresh log record forever", () => {
  const idx0: PropIndex = { msdata: ENTRY as unknown as PropIndex[string] };
  const freshTs = { ...ENTRY, ts: "2026-09-03T00:00:01Z" } as unknown as PropIndex[string];
  const { changed } = upsertEntry(idx0, "msdata", freshTs);
  assert.equal(changed, true);
});

test("upsertEntry reports changed when the version differs", () => {
  const idx0: PropIndex = { msdata: ENTRY as unknown as PropIndex[string] };
  const next = { ...ENTRY, version: "0.51.2" } as unknown as PropIndex[string];
  const { idx, changed } = upsertEntry(idx0, "msdata", next);
  assert.equal(changed, true);
  assert.equal(idx.msdata.version, "0.51.2");
});

test("mergeAttempt starts a fresh package at attempts=1", () => {
  const r = mergeAttempt(undefined, { commit: "c1", status: "ok", run_id: "1", run_url: "u", ts: "t" });
  assert.equal(r.attempts, 1);
});

test("mergeAttempt increments on a repeated attempt at the same commit", () => {
  const prev = mergeAttempt(undefined, { commit: "c1", status: "failed:check", run_id: "1", run_url: "u", ts: "t1" });
  const next = mergeAttempt(prev, { commit: "c1", status: "failed:check", run_id: "2", run_url: "u", ts: "t2" });
  assert.equal(next.attempts, 2);
});

test("mergeAttempt does NOT increment on a self-heal re-POST (same commit, same run_id)", () => {
  const prev = mergeAttempt(undefined, { commit: "c1", status: "ok", run_id: "1", run_url: "u", ts: "t1" });
  const resweep = mergeAttempt(prev, { commit: "c1", status: "ok", run_id: "1", run_url: "u", ts: "t2" });
  assert.equal(resweep.attempts, 1);
  const resweepAgain = mergeAttempt(resweep, { commit: "c1", status: "ok", run_id: "1", run_url: "u", ts: "t3" });
  assert.equal(resweepAgain.attempts, 1);
});

test("mergeAttempt resets to 1 when the commit moves", () => {
  const prev = mergeAttempt(undefined, { commit: "c1", status: "failed:check", run_id: "1", run_url: "u", ts: "t1" });
  const next = mergeAttempt(prev, { commit: "c2", status: "ok", run_id: "2", run_url: "u", ts: "t2" });
  assert.equal(next.attempts, 1);
  assert.equal(next.commit, "c2");
});
