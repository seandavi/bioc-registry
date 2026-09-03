#!/usr/bin/env bash
set -euo pipefail

# scripts/publish.sh — the bioc-build publisher (issue #13, SPEC-014 "publish.yml").
#
# Sweeps completed runs on seandavi/bioc-build@main and downloads every
# staged-* artifact they hold (a matrix run of dispatch.yml holds one per
# package/stream, all sharing that run's run_id, since it calls build.yml via
# `uses:` rather than dispatching it separately). For each staged-<pkg>-<stream>
# artifact not already recorded in state/bioc-build/attempts.json AT THIS EXACT
# run_id: verifies the tarball (sha256 + gh attestation) and the manifest it
# built against, applies the version gate, uploads to the CAS, and POSTs the
# result to bioc-registry's /publish route. A rejection is recorded as an
# attempt (never silently dropped) and the sweep moves on to the next package
# — one rejection must never abort the rest.
#
# After the sweep, every entry in state/bioc-build/published.json is re-POSTed
# (self-heal): a later r-universe read-modify-write of prop/<u>/index.json can
# clobber a bioc-build entry, and /publish is a no-op when the index already
# matches, so this is cheap and closes that window within 30 minutes.
#
# Env (secrets — see README.md "Ops" for where these come from):
#   MAINT_KEY                x-maint-key for POST /publish
#   R2_ACCESS_KEY_ID, R2_SECRET_ACCESS_KEY, R2_ACCOUNT_ID   R2 (S3-compatible) creds
#   GH_TOKEN                  needed even for gh reads against the public bioc-build
#                              repo (unauthenticated gh hits a low rate limit)
#
# Usage: scripts/publish.sh [--dry-run]
#   --dry-run does everything except the S3 upload and the POST, so it is safe
#   to run locally against the real bioc-build runs.

REGISTRY="${REGISTRY:-https://bioc-registry.seandavi.workers.dev}"
BUILD_REPO="seandavi/bioc-build"
MANIFEST_REPO="seandavi/bioc-manifest"
BUCKET="bioc-prop"

log() { echo "[publish] $*" >&2; }

aws_s3() {
  aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" s3 "$@"
}

# POST to the guarded /publish route. $1 = JSON body.
post_publish() {
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    log "dry-run: would POST /publish: $(jq -c '{universe,package,run_id,has_entry:(.entry!=null),status:.attempt.status}' <<<"$1")"
    return 0
  fi
  curl -sf -X POST "$REGISTRY/publish" \
    -H "x-maint-key: $MAINT_KEY" -H "content-type: application/json" \
    -d "$1" | jq -c .
}

# GET a JSON object from the archive, or {} on a 404 (nothing published yet).
fetch_or_empty() {
  curl -sf "$REGISTRY/data/$1" 2>/dev/null || echo '{}'
}

universe_of_stream() { [[ "$1" == "devel" ]] && echo "bioc" || echo "bioc-release"; }

# manifest_get <pkg> <manifest_commit> <key> — one value out of the flat
# packages/<pkg>.yaml at that commit (a 30-line parser only needs grep).
manifest_get() {
  curl -sf "https://raw.githubusercontent.com/${MANIFEST_REPO}/${2}/packages/${1}.yaml" 2>/dev/null \
    | grep -E "^${3}:" | head -1 | sed -E "s/^${3}:[[:space:]]*//" | tr -d '"'
}

# Build the /publish entry JSON from a verified staged.json. One jq filter so
# publish.test.sh can run the exact same transform against a fixture.
build_entry() {
  local staged_file="$1" sha256="$2" ts="$3"
  # TZ=UTC: jq's fromdateiso8601 (below) mis-converts a "Z" timestamp by the
  # local zone's DST offset on some jq 1.6 builds unless the process is
  # already in UTC — verified wrong by up to 1h in MDT. GH runners default to
  # UTC, but --dry-run is meant to run locally too, so pin it explicitly.
  TZ=UTC jq -n --slurpfile s "$staged_file" --arg sha256 "$sha256" --arg ts "$ts" '
    ($s[0]) as $staged |
    {
      version: $staged.version,
      sha256: $sha256,
      ts: $ts,
      bioccheck: $staged.check.bioccheck,
      archs: ["linux"],
      origin: "bioc-build",
      artifacts: [{
        os: "src",
        r: ($staged.build.r_version | split(".") | .[0:2] | join(".")),
        sha256: $sha256,
        file: $staged.tarball.file
      }],
      # null description/meta fields (staged.json marks an absent field null,
      # not omitted) must not reach the index — Desc/Meta are string-only.
      desc: ($staged.description | with_entries(select(.value != null))),
      # Meta.commit.time is a Unix timestamp (repo.ts), matching every other
      # producer (r-universe _commit.time); staged.json source.commit_time is
      # ISO 8601 (git log -1 --format=%cI), so it is converted here. Omitted
      # entirely when build.yml has not started recording commit_time yet.
      meta: (($staged.meta // {} | with_entries(select(.value != null)))
             + { commit: ({ id: $staged.source.commit } +
                          (if $staged.source.commit_time then
                             { time: ($staged.source.commit_time | fromdateiso8601) }
                           else {} end)),
                 git_url: $staged.source.git_url })
    }'
}

# version_gate_ok <index.json file> <package> <new version>
# Reject unless the new version is a strict sort -V bump over the index's
# current entry, or ties a current entry that is a Bioconductor seed (an
# origin: bioconductor entry never passed any gate, so matching its version
# once is a real improvement, not a downgrade).
version_gate_ok() {
  local idxfile="$1" pkg="$2" new="$3" cur cur_origin top
  cur=$(jq -r --arg p "$pkg" '.[$p].version // ""' "$idxfile")
  [[ -z "$cur" ]] && return 0
  cur_origin=$(jq -r --arg p "$pkg" '.[$p].origin // "r-universe"' "$idxfile")
  if [[ "$new" == "$cur" && "$cur_origin" == "bioconductor" ]]; then return 0; fi
  top=$(printf '%s\n%s\n' "$cur" "$new" | sort -V | tail -1)
  [[ "$top" == "$new" && "$new" != "$cur" ]]
}

# record_attempt <universe> <package> <run_id> <commit> <status> <run_url>
record_attempt() {
  local ts body
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  body=$(jq -n --arg universe "$1" --arg package "$2" --arg run_id "$3" \
    --arg commit "$4" --arg status "$5" --arg run_url "$6" --arg ts "$ts" \
    '{universe:$universe, package:$package, run_id:$run_id,
      attempt:{commit:$commit, status:$status, run_url:$run_url, ts:$ts}}')
  post_publish "$body" >/dev/null
}

# publish_ok <universe> <package> <run_id> <commit> <run_url> <staged_json> <sha256> <idxfile>
# Uploads (unless dry-run), builds the entry, POSTs it, and updates the sweep's
# own index cache so a later package in this same sweep sees the new version.
publish_ok() {
  local universe="$1" pkg="$2" run_id="$3" commit="$4" run_url="$5" staged="$6" sha256="$7" idxfile="$8"
  local adir tarball_file ts entry body
  adir=$(dirname "$staged")
  tarball_file=$(jq -r '.tarball.file' "$staged")
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    log "dry-run: would upload $pkg to prop/$universe/cas/$sha256 and logs/bioc-build/$run_id/"
  else
    if ! aws_s3 api head-object --bucket "$BUCKET" --key "prop/$universe/cas/$sha256" >/dev/null 2>&1; then
      aws_s3 cp "$adir/$tarball_file" "s3://$BUCKET/prop/$universe/cas/$sha256"
    fi
    [[ -d "$adir/logs" ]] && aws_s3 cp --recursive "$adir/logs" "s3://$BUCKET/logs/bioc-build/$run_id/"
  fi
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  entry=$(build_entry "$staged" "$sha256" "$ts")
  body=$(jq -n --arg universe "$universe" --arg package "$pkg" --arg run_id "$run_id" \
    --argjson entry "$entry" --arg commit "$commit" --arg run_url "$run_url" --arg ts "$ts" \
    '{universe:$universe, package:$package, run_id:$run_id, entry:$entry,
      attempt:{commit:$commit, status:"ok", run_url:$run_url, ts:$ts}}')
  log "$pkg ($universe, run $run_id): publishing $(jq -r .version "$staged")"
  post_publish "$body" >/dev/null
  jq --arg p "$pkg" --argjson e "$entry" '.[$p] = $e' "$idxfile" > "$idxfile.tmp" && mv "$idxfile.tmp" "$idxfile"
}

# process_artifact <run_id> <run_url> <artifact_dir> <index-bioc file> <index-bioc-release file> <attempts_file>
# One staged-<package>-<stream> artifact: validate → verify → gate → publish or
# reject. Never propagates a failure past this one package.
#
# A single matrix run of dispatch.yml holds MANY staged-* artifacts sharing one
# run_id, so "already processed" cannot be decided at the run level (that would
# skip every package after the first) — it is checked here, per package/stream,
# against the exact run_id.
process_artifact() {
  local run_id="$1" run_url="$2" adir="$3" idx_bioc="$4" idx_release="$5" attempts_file="$6"
  local staged="$adir/staged.json"
  [[ -f "$staged" ]] || { log "run $run_id: $adir has no staged.json, skipping"; return 0; }

  local pkg stream status universe commit manifest_commit
  pkg=$(jq -r '.package' "$staged")
  stream=$(jq -r '.stream' "$staged")
  status=$(jq -r '.status' "$staged")
  universe=$(universe_of_stream "$stream")
  commit=$(jq -r '.source.commit' "$staged")
  manifest_commit=$(jq -r '.manifest_commit' "$staged")
  local idxfile="$idx_bioc"
  [[ "$universe" == "bioc-release" ]] && idxfile="$idx_release"

  if jq -e --arg p "$pkg" --arg s "$stream" --arg rid "$run_id" \
    '(.[$p][$s].run_id // "") == $rid' "$attempts_file" >/dev/null 2>&1; then
    log "$pkg/$stream (run $run_id): already recorded for this run, skipping"
    return 0
  fi

  if [[ "$status" == failed:* ]]; then
    log "$pkg/$stream (run $run_id): $status — recording attempt only"
    record_attempt "$universe" "$pkg" "$run_id" "$commit" "$status" "$run_url"
    return 0
  fi

  local reject_reason=""
  local tarball_sha tarball_file tarball_path actual_sha
  tarball_file=$(jq -r '.tarball.file' "$staged")
  tarball_sha=$(jq -r '.tarball.sha256' "$staged")
  tarball_path="$adir/$tarball_file"

  if [[ ! -f "$tarball_path" ]]; then reject_reason="no-tarball"
  else
    actual_sha=$(sha256sum "$tarball_path" | awk '{print $1}')
    if [[ "$actual_sha" != "$tarball_sha" ]]; then reject_reason="sha256-mismatch"
    elif ! gh attestation verify "$tarball_path" --repo "$BUILD_REPO" \
      --signer-workflow "${BUILD_REPO}/.github/workflows/build.yml" >/dev/null 2>&1; then
      reject_reason="attestation"
    fi
  fi

  if [[ -z "$reject_reason" ]]; then
    local m_state m_git_url m_streams m_component m_profile staged_git_url
    m_state=$(manifest_get "$pkg" "$manifest_commit" "state")
    m_git_url=$(manifest_get "$pkg" "$manifest_commit" "git_url")
    m_streams=$(manifest_get "$pkg" "$manifest_commit" "streams")
    m_component=$(manifest_get "$pkg" "$manifest_commit" "component")
    m_profile=$(manifest_get "$pkg" "$manifest_commit" "profile")
    staged_git_url=$(jq -r '.source.git_url' "$staged")
    if [[ "$m_state" != "active" ]]; then reject_reason="manifest-state"
    elif [[ "$m_git_url" != "$staged_git_url" ]]; then reject_reason="manifest-git-url"
    elif [[ "$m_streams" != *"$stream"* ]]; then reject_reason="manifest-stream"
    elif [[ "$m_component" != "$m_profile" ]]; then reject_reason="manifest-component"
    else
      local version; version=$(jq -r '.version' "$staged")
      version_gate_ok "$idxfile" "$pkg" "$version" || reject_reason="version-gate"
    fi
  fi

  if [[ -n "$reject_reason" ]]; then
    log "$pkg/$stream (run $run_id): rejected:$reject_reason"
    record_attempt "$universe" "$pkg" "$run_id" "$commit" "rejected:$reject_reason" "$run_url"
    return 0
  fi

  publish_ok "$universe" "$pkg" "$run_id" "$commit" "$run_url" "$staged" "$tarball_sha" "$idxfile"
}

main() {
  DRY_RUN=0
  [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
  [[ "$DRY_RUN" == 1 ]] || : "${MAINT_KEY:?MAINT_KEY not set}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_ACCOUNT_ID:?}"

  local WORK; WORK="$(mktemp -d)"
  trap 'rm -rf "$WORK"' EXIT

  log "fetching attempts.json"
  local attempts_file="$WORK/attempts.json"
  fetch_or_empty "state/bioc-build/attempts.json" > "$attempts_file"

  # No --workflow filter: dispatch.yml calls build.yml via `uses:` inside a
  # matrix job, so a matrix-produced staged-* artifact hangs off DISPATCH.yml's
  # run, not a separate build.yml run — filtering by workflow name here would
  # silently see none of them. selftest.yml never uploads staged-*, so it drops
  # out on its own once we try (and fail) to download a staged-* artifact from
  # it below; no workflow-name filtering needed to exclude it either.
  log "listing completed runs on $BUILD_REPO@main"
  local runs_file="$WORK/runs.json"
  gh run list -R "$BUILD_REPO" --branch main --status completed \
    --limit 100 --json databaseId,url,conclusion,workflowName > "$runs_file"

  # One index.json per universe, cached for the whole sweep and updated in
  # place as packages publish (see publish_ok) so the version gate sees a
  # package published earlier in this same sweep.
  local idx_bioc="$WORK/index-bioc.json" idx_release="$WORK/index-bioc-release.json"
  fetch_or_empty "prop/bioc/index.json" > "$idx_bioc"
  fetch_or_empty "prop/bioc-release/index.json" > "$idx_release"

  # ponytail: no pre-download skip at the run level — a fully-processed run
  # still gets `gh run download` retried every sweep until it ages out of the
  # last-100 list. Correct (process_artifact's per-artifact check is what
  # matters) but not free; upgrade path if this gets expensive is a
  # `gh api .../artifacts` name-only precheck before downloading bytes.
  local n=0
  while read -r run; do
    local rid run_url workflow
    rid=$(jq -r '.databaseId' <<<"$run")
    run_url=$(jq -r '.url' <<<"$run")
    workflow=$(jq -r '.workflowName' <<<"$run")
    local rundir="$WORK/run-$rid"
    mkdir -p "$rundir"
    if ! gh run download "$rid" -R "$BUILD_REPO" -p 'staged-*' -D "$rundir" >/dev/null 2>&1; then
      log "run $rid ($workflow): no staged-* artifact — nothing to publish from it"
      continue
    fi
    n=$((n + 1))
    while read -r adir; do
      process_artifact "$rid" "$run_url" "$adir" "$idx_bioc" "$idx_release" "$attempts_file"
    done < <(find "$rundir" -mindepth 1 -maxdepth 1 -type d)
  done < <(jq -c '.[]' "$runs_file")
  log "sweep done ($n run(s) with staged-* artifacts considered)"

  log "self-heal: re-POSTing state/bioc-build/published.json"
  local published_file="$WORK/published.json"
  fetch_or_empty "state/bioc-build/published.json" > "$published_file"
  fetch_or_empty "state/bioc-build/attempts.json" > "$attempts_file"
  while IFS=$'\t' read -r universe pkg; do
    local entry stream att run_id commit run_url ts body
    entry=$(jq -c --arg u "$universe" --arg p "$pkg" '.[$u][$p]' "$published_file")
    stream=$(universe_of_stream_inverse "$universe")
    att=$(jq -c --arg p "$pkg" --arg s "$stream" '(.[$p][$s]) // {}' "$attempts_file")
    run_id=$(jq -r '.run_id // ""' <<<"$att")
    commit=$(jq -r '.commit // ""' <<<"$att")
    run_url=$(jq -r '.run_url // ""' <<<"$att")
    ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
    body=$(jq -n --arg universe "$universe" --arg package "$pkg" --arg run_id "$run_id" \
      --argjson entry "$entry" --arg commit "$commit" --arg run_url "$run_url" --arg ts "$ts" \
      '{universe:$universe, package:$package, run_id:$run_id, entry:$entry,
        attempt:{commit:$commit, status:"ok", run_url:$run_url, ts:$ts}}')
    post_publish "$body" >/dev/null || log "self-heal: $universe/$pkg POST failed"
  done < <(jq -r 'to_entries[] | .key as $u | .value | keys[] | [$u, .] | @tsv' "$published_file")
}

universe_of_stream_inverse() { [[ "$1" == "bioc" ]] && echo "devel" || echo "release"; }

# Only run the sweep when executed directly — publish.test.sh sources this file
# to reuse build_entry() against a fixture without running main().
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  main "$@"
fi
