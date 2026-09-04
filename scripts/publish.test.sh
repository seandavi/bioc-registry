#!/usr/bin/env bash
set -euo pipefail

# scripts/publish.test.sh — checks build_entry() (the jq transform publish.sh
# uses to turn a verified staged.json into a /publish entry) against the
# SPEC-014 example, so a change to the jq filter fails loudly instead of
# silently mis-shaping the index. Run: bash scripts/publish.test.sh

DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
# shellcheck source=publish.sh
source "$DIR/publish.sh"   # guarded main(), so sourcing only defines functions

SHA="aaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaaa"
TS="2026-09-03T00:00:00Z"

EXPECTED=$(cat <<JSON
{
  "version": "0.51.1",
  "sha256": "$SHA",
  "ts": "$TS",
  "bioccheck": "ok",
  "archs": ["linux"],
  "origin": "bioc-build",
  "artifacts": [
    { "os": "src", "r": "4.6", "sha256": "$SHA", "file": "msdata_0.51.1.tar.gz" }
  ],
  "desc": {
    "Depends": "R (>= 4.1.0)",
    "License": "Artistic-2.0",
    "NeedsCompilation": "no"
  },
  "meta": {
    "Title": "Various Mass Spectrometry raw data example files",
    "Description": "Provides mass spectrometry data for use in examples and vignettes.",
    "Maintainer": "MSnbase Developers <maintainer@example.org>",
    "biocViews": "ExperimentData, MassSpectrometryData",
    "commit": { "id": "deadbeefcafef00d", "time": 1786234354 },
    "git_url": "https://git.bioconductor.org/packages/msdata"
  }
}
JSON
)

ACTUAL=$(build_entry "$DIR/fixtures/staged.json" "$SHA" "$TS")

if diff -u <(jq -S . <<<"$EXPECTED") <(jq -S . <<<"$ACTUAL") >/tmp/publish-test.diff 2>&1; then
  echo "ok - build_entry(fixtures/staged.json) matches the expected entry"
else
  echo "not ok - build_entry(fixtures/staged.json) mismatch:" >&2
  cat /tmp/publish-test.diff >&2
  exit 1
fi

# source.commit_time is a recent addition to staged.json (SPEC-014 follow-up);
# build_entry must still work — just without meta.commit.time — against a
# staged.json from before it existed.
NO_TIME=$(mktemp)
jq 'del(.source.commit_time)' "$DIR/fixtures/staged.json" > "$NO_TIME"
if jq -e '.meta.commit | has("time") | not' <<<"$(build_entry "$NO_TIME" "$SHA" "$TS")" >/dev/null; then
  echo "ok - build_entry omits meta.commit.time when source.commit_time is absent"
else
  echo "not ok - build_entry should omit meta.commit.time when source.commit_time is absent" >&2
  exit 1
fi
rm -f "$NO_TIME"

# source.commit_time is `git log -1 --format=%cI`: ISO 8601 WITH a numeric
# zone offset, not "Z". This is the exact shape that crashed a live sweep
# (jq's fromdateiso8601 only parses "Z") — build_entry must convert it
# correctly rather than erroring.
OFFSET_TS="2026-04-28T08:25:25-04:00"
EXPECTED_EPOCH=$(date -d "$OFFSET_TS" +%s)
OFFSET=$(mktemp)
jq --arg t "$OFFSET_TS" '.source.commit_time = $t' "$DIR/fixtures/staged.json" > "$OFFSET"
ACTUAL_EPOCH=$(jq -r '.meta.commit.time' <<<"$(build_entry "$OFFSET" "$SHA" "$TS")")
if [[ "$ACTUAL_EPOCH" == "$EXPECTED_EPOCH" ]]; then
  echo "ok - build_entry converts a commit_time with a numeric zone offset"
else
  echo "not ok - build_entry offset conversion: got $ACTUAL_EPOCH, expected $EXPECTED_EPOCH" >&2
  exit 1
fi
rm -f "$OFFSET"

# An unparseable commit_time must not fail the whole publish — just the field.
BAD_TIME=$(mktemp)
jq '.source.commit_time = "not-a-date"' "$DIR/fixtures/staged.json" > "$BAD_TIME"
if jq -e '.meta.commit | has("time") | not' <<<"$(build_entry "$BAD_TIME" "$SHA" "$TS")" >/dev/null; then
  echo "ok - build_entry omits meta.commit.time when source.commit_time is unparseable"
else
  echo "not ok - build_entry should omit meta.commit.time when source.commit_time is unparseable" >&2
  exit 1
fi
rm -f "$BAD_TIME"


# process_artifact's idempotence check (issue #12 review): a matrix run's
# staged-* artifacts share one run_id, so "already processed" is per
# package/stream against attempts[pkg][stream].run_id — never per run_id
# alone, which would skip every package after the first in that run.
ATT=$(mktemp)
echo '{"msdata": {"release": {"run_id": "999"}}, "other": {"release": {"run_id": "111"}}}' > "$ATT"
ADIR=$(mktemp -d)
cp "$DIR/fixtures/staged.json" "$ADIR/staged.json"   # package msdata, stream release
OUT=$(DRY_RUN=1 process_artifact "999" "https://example/run/999" "$ADIR" "$ATT" 2>&1)
if grep -q "already recorded" <<<"$OUT"; then
  echo "ok - process_artifact skips a package/stream already recorded for THIS run_id"
else
  echo "not ok - process_artifact should have skipped msdata/release at run_id 999" >&2
  echo "$OUT" >&2
  exit 1
fi
OUT=$(DRY_RUN=1 process_artifact "222" "https://example/run/222" "$ADIR" "$ATT" 2>&1 || true)
if grep -q "already recorded" <<<"$OUT"; then
  echo "not ok - process_artifact should NOT skip msdata/release at a different run_id (222)" >&2
  echo "$OUT" >&2
  exit 1
else
  echo "ok - process_artifact does not skip a different run_id for the same package/stream"
fi
rm -rf "$ATT" "$ADIR"

# package_of/stream_of: "staged-<package>-<stream>" splits on the LAST "-",
# which is unambiguous only because package names may never contain one
# (dots are fine, e.g. Bioconductor annotation packages).
[[ "$(package_of staged-msdata-release)" == "msdata" ]] || { echo "not ok - package_of staged-msdata-release" >&2; exit 1; }
[[ "$(stream_of staged-msdata-release)" == "release" ]] || { echo "not ok - stream_of staged-msdata-release" >&2; exit 1; }
[[ "$(package_of staged-org.Hs.eg.db-devel)" == "org.Hs.eg.db" ]] || { echo "not ok - package_of with dots in the name" >&2; exit 1; }
echo "ok - package_of/stream_of"

# The precheck (main's todo[] loop) must skip a run by NAME alone, before any
# download — this is what keeps a multi-GB data package from being
# re-fetched every 30 min. already_recorded is exactly what that loop calls.
ATT=$(mktemp)
echo '{"msdata": {"release": {"run_id": "999"}}}' > "$ATT"
already_recorded "$(package_of staged-msdata-release)" "$(stream_of staged-msdata-release)" "999" "$ATT" \
  || { echo "not ok - already_recorded should match by parsed name at the same run_id" >&2; exit 1; }
already_recorded "$(package_of staged-msdata-release)" "$(stream_of staged-msdata-release)" "222" "$ATT" \
  && { echo "not ok - already_recorded should not match a different run_id" >&2; exit 1; }
rm -f "$ATT"
echo "ok - already_recorded via parsed artifact name (precheck path)"

# process_artifact_safe: SPEC-014 — one bad artifact must never abort the
# sweep. Invalid JSON reproduces the real failure mode (a command deep in
# process_artifact's call tree erroring under `set -e`, here jq itself on the
# very first `.package` read) and must not stop a second, valid artifact from
# still being processed right after it, in the same script/process.
BADDIR=$(mktemp -d)
echo 'not valid json' > "$BADDIR/staged.json"
GOODDIR=$(mktemp -d)
cp "$DIR/fixtures/staged.json" "$GOODDIR/staged.json"   # no tarball copied -> rejects, but that IS normal processing
ATT2=$(mktemp); echo '{}' > "$ATT2"

BAD_STATUS=0
DRY_RUN=1 process_artifact_safe "1" "https://example/run/1" "$BADDIR" "$ATT2" "staged-broken-release" \
  >/dev/null 2>&1 || BAD_STATUS=$?
GOOD_STATUS=0
GOOD_OUT=$(DRY_RUN=1 process_artifact_safe "2" "https://example/run/2" "$GOODDIR" "$ATT2" "staged-msdata-release" 2>&1) \
  || GOOD_STATUS=$?

if [[ "$BAD_STATUS" -ne 0 ]]; then
  echo "ok - process_artifact_safe reports failure for a malformed staged.json instead of killing the script"
else
  echo "not ok - process_artifact_safe should have failed for a malformed staged.json" >&2
  exit 1
fi
if [[ "$GOOD_STATUS" -eq 0 ]] && grep -q "rejected:no-tarball" <<<"$GOOD_OUT"; then
  echo "ok - process_artifact_safe still processes a second, valid artifact after the first one errored"
else
  echo "not ok - the second artifact should still have been processed normally" >&2
  echo "$GOOD_OUT" >&2
  exit 1
fi
rm -rf "$BADDIR" "$GOODDIR" "$ATT2"
