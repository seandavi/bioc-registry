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
    "commit": { "id": "deadbeefcafef00d" },
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

# version_gate_ok: a strict sort -V bump is required unless replacing an
# origin:bioconductor seed at the same version.
IDX=$(mktemp)
echo '{"msdata": {"version": "0.51.0", "origin": "r-universe"}}' > "$IDX"
version_gate_ok "$IDX" msdata 0.51.1 || { echo "not ok - version_gate_ok should accept a strict bump" >&2; exit 1; }
version_gate_ok "$IDX" msdata 0.51.0 && { echo "not ok - version_gate_ok should reject a tie against r-universe" >&2; exit 1; }
echo '{"msdata": {"version": "0.51.1", "origin": "bioconductor"}}' > "$IDX"
version_gate_ok "$IDX" msdata 0.51.1 || { echo "not ok - version_gate_ok should accept a tie against a bioconductor seed" >&2; exit 1; }
rm -f "$IDX"
echo "ok - version_gate_ok"
