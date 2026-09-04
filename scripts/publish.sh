#!/usr/bin/env bash
set -euo pipefail

# scripts/publish.sh — the bioc-build publisher (issue #13, SPEC-014 "publish.yml").
#
# Sweeps completed runs on seandavi/bioc-build@main (a matrix run of
# dispatch.yml holds one staged-<pkg>-<stream> artifact per package/stream, all
# sharing that run's run_id, since it calls build.yml via `uses:` rather than
# dispatching it separately) and, by artifact NAME first — no bytes — figures
# out which ones are not yet in state/bioc-build/attempts.json at this exact
# run_id. Only those get downloaded, one `gh run download -n` per artifact:
# these can be multi-GB data packages, so a name-only precheck before pulling
# bytes matters. Each downloaded artifact is then verified for real (tarball
# sha256 + gh attestation, the manifest it built against, the version gate),
# uploaded to the CAS, and POSTed to bioc-registry's /publish route. A
# rejection is recorded as an attempt (never silently dropped) and the sweep
# moves on to the next package — one rejection must never abort the rest.
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
# `aws s3api`, not `aws s3 api`: the latter is not a command, so the CAS
# exists-check below always failed and every tarball re-uploaded each sweep.
aws_s3api() {
  aws --endpoint-url "https://${R2_ACCOUNT_ID}.r2.cloudflarestorage.com" s3api "$@"
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

# staged_artifact_names <run_id> — names only, no bytes: lets the sweep skip a
# run (or the packages in it already done) without downloading anything.
staged_artifact_names() {
  gh api "repos/$BUILD_REPO/actions/runs/$1/artifacts" --jq '.artifacts[].name' 2>/dev/null \
    | grep '^staged-' || true
}

# package_of/stream_of <artifact name> — "staged-<package>-<stream>" splits
# unambiguously because a package name is never allowed to contain "-".
package_of() { local n="${1#staged-}"; echo "${n%-*}"; }
stream_of() { echo "${1##*-}"; }

# already_recorded <package> <stream> <run_id> <attempts_file>
# already_recorded <package> <stream> <run_id> <attempts.json>
# attempts.json keeps ONE record per package/stream — the latest run — so
# "recorded" has to mean "this run or an older one". GitHub run ids are
# monotonic; with plain equality the second-newest run in the 100-run window
# stopped being "recorded" the moment a newer one landed, got re-downloaded,
# and was refused by its own version, every sweep (2026-09-04, msdata).
already_recorded() {
  jq -e --arg p "$1" --arg s "$2" --arg rid "$3" \
    '((.[$p][$s].run_id // "0") | tonumber) >= ($rid | tonumber)' "$4" >/dev/null 2>&1
}

build_entry() {
  local staged_file="$1" sha256="$2" ts="$3"
  # source.commit_time is `git log -1 --format=%cI` — ISO 8601 WITH a numeric
  # zone offset (e.g. "...-04:00"), not "Z". jq's fromdateiso8601 only parses
  # "Z" and hard-errors on an offset (hit for real: a bioc-build sweep died on
  # "2026-04-28T08:25:25-04:00 does not match format %Y-%m-%dT%H:%M:%SZ").
  # GNU date parses either, so the conversion happens here, in bash, before jq
  # ever sees it — and a missing or unparseable value just omits
  # meta.commit.time rather than failing the whole publish.
  local commit_time_raw commit_time_epoch=""
  commit_time_raw=$(jq -r '.source.commit_time // empty' "$staged_file")
  [[ -n "$commit_time_raw" ]] && commit_time_epoch=$(date -d "$commit_time_raw" +%s 2>/dev/null || true)
  jq -n --slurpfile s "$staged_file" --arg sha256 "$sha256" --arg ts "$ts" \
    --arg commit_time_epoch "$commit_time_epoch" '
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
      meta: (($staged.meta // {} | with_entries(select(.value != null)))
             + { commit: ({ id: $staged.source.commit } +
                          (if $commit_time_epoch != "" then { time: ($commit_time_epoch | tonumber) } else {} end)),
                 git_url: $staged.source.git_url })
    }'
}

record_attempt() {
  local ts body
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  body=$(jq -n --arg universe "$1" --arg package "$2" --arg run_id "$3" \
    --arg commit "$4" --arg status "$5" --arg run_url "$6" --arg ts "$ts" \
    '{universe:$universe, package:$package, run_id:$run_id,
      attempt:{commit:$commit, status:$status, run_url:$run_url, ts:$ts}}')
  post_publish "$body" >/dev/null
}

# publish_ok <universe> <package> <run_id> <commit> <run_url> <staged_json> <sha256>
# Upload (unless dry-run), then POST staged.json alongside the entry: the route applies the gate
# (version, manifest, deps — bioc-registry ADR 0011) and records the verdict
# itself; we only log what it decided.
publish_ok() {
  local universe="$1" pkg="$2" run_id="$3" commit="$4" run_url="$5" staged="$6" sha256="$7"
  local adir tarball_file ts entry body
  adir=$(dirname "$staged")
  tarball_file=$(jq -r '.tarball.file' "$staged")
  if [[ "${DRY_RUN:-0}" == 1 ]]; then
    log "dry-run: would upload $pkg to prop/$universe/cas/$sha256 and logs/bioc-build/$run_id/"
  else
    if ! aws_s3api head-object --bucket "$BUCKET" --key "prop/$universe/cas/$sha256" >/dev/null 2>&1; then
      aws_s3 cp "$adir/$tarball_file" "s3://$BUCKET/prop/$universe/cas/$sha256"
    fi
    [[ -d "$adir/logs" ]] && aws_s3 cp --recursive "$adir/logs" "s3://$BUCKET/logs/bioc-build/$run_id/"
  fi
  ts="$(date -u +%Y-%m-%dT%H:%M:%SZ)"
  entry=$(build_entry "$staged" "$sha256" "$ts")
  body=$(jq -n --arg universe "$universe" --arg package "$pkg" --arg run_id "$run_id" \
    --argjson entry "$entry" --slurpfile staged "$staged" --arg commit "$commit" --arg run_url "$run_url" --arg ts "$ts" \
    '{universe:$universe, package:$package, run_id:$run_id, entry:$entry, staged:$staged[0],
      attempt:{commit:$commit, status:"ok", run_url:$run_url, ts:$ts}}')
  log "$pkg ($universe, run $run_id): submitting $(jq -r .version "$staged")"
  local resp; resp=$(post_publish "$body")
  if [[ "${DRY_RUN:-0}" != 1 && "$(jq -r '.propagate' <<<"$resp")" != true ]]; then
    log "$pkg/$universe (run $run_id): gate said no: $(jq -c '[.decision.reasons[] | select(.ok|not)]' <<<"$resp")"
  fi
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
  local run_id="$1" run_url="$2" adir="$3" attempts_file="$4"
  local staged="$adir/staged.json"
  [[ -f "$staged" ]] || { log "run $run_id: $adir has no staged.json, skipping"; return 0; }

  local pkg stream status universe commit
  pkg=$(jq -r '.package' "$staged")
  stream=$(jq -r '.stream' "$staged")
  status=$(jq -r '.status' "$staged")
  universe=$(universe_of_stream "$stream")
  commit=$(jq -r '.source.commit' "$staged")

  # Authoritative check (staged.json is truth; the artifact name used for the
  # pre-download precheck in main() is only a hint) — repeated here in case
  # staged.json's own package/stream disagree with the artifact's name.
  if already_recorded "$pkg" "$stream" "$run_id" "$attempts_file"; then
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

  # Integrity ends here. Authorization (manifest) and propagation (version,
  # deps) are the route's gate — see publish_ok.
  if [[ -n "$reject_reason" ]]; then
    log "$pkg/$stream (run $run_id): rejected:$reject_reason"
    record_attempt "$universe" "$pkg" "$run_id" "$commit" "rejected:$reject_reason" "$run_url"
    return 0
  fi

  publish_ok "$universe" "$pkg" "$run_id" "$commit" "$run_url" "$staged" "$tarball_sha"
}

# process_artifact_safe <run_id> <run_url> <artifact_dir> <attempts_file> <artifact_name>
# SPEC-014: one bad artifact must never abort the sweep. This runs
# process_artifact in a genuinely separate `bash` PROCESS, not a `(...)`
# subshell of this one — verified the hard way: bash's errexit is deliberately
# ignored while evaluating the tested command of an if/while or a non-last
# member of an AND-OR list, and that suppression reaches into any subshell
# forked for it too, so a crashing command in there (a malformed staged.json,
# a jq filter erroring, ...) does not stop execution — it just leaves
# $pkg/$stream etc empty and silently limps on to a bogus "success", and
# nothing short of a real process boundary (which starts with none of that
# suppression, regardless of how process_artifact_safe itself was called)
# reliably catches it. Only DRY_RUN needs forwarding explicitly: everything
# else process_artifact needs is either a real environment variable already
# (the secrets) or re-derived by re-sourcing this file fresh in the child.
#
# On failure, records a best-effort attempt using the package/stream parsed
# from the ARTIFACT NAME (staged.json itself may be exactly what is broken,
# so it cannot be trusted here) and reports failure to the caller so it can
# move on to the next artifact instead of the whole script exiting.
process_artifact_safe() {
  local run_id="$1" run_url="$2" adir="$3" attempts_file="$4" name="$5"
  local status=0
  DRY_RUN="${DRY_RUN:-0}" bash -euo pipefail -c '
    source "$1"; shift
    process_artifact "$@"
  ' _ "${BASH_SOURCE[0]}" "$run_id" "$run_url" "$adir" "$attempts_file" || status=$?
  [[ "$status" -eq 0 ]] && return 0
  log "run $run_id: $name errored during processing, recording rejected:internal-error and continuing"
  record_attempt "$(universe_of_stream "$(stream_of "$name")")" "$(package_of "$name")" \
    "$run_id" "" "rejected:internal-error" "$run_url" || true
  return 1
}

main() {
  DRY_RUN=0
  [[ "${1:-}" == "--dry-run" ]] && DRY_RUN=1
  [[ "$DRY_RUN" == 1 ]] || : "${MAINT_KEY:?MAINT_KEY not set}" "${R2_ACCESS_KEY_ID:?}" "${R2_SECRET_ACCESS_KEY:?}" "${R2_ACCOUNT_ID:?}"

  # WORK is a plain global (not `local`), set with its cleanup trap at the
  # bottom of this file BEFORE main is called — not here. A `local` here was
  # observed unbound when the EXIT trap fired after an error deep in a nested
  # call (jq/gh/aws failures no longer reach that far — see
  # process_artifact_safe — but a global sidesteps the whole class of bug).

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

  local n=0 err=0
  while read -r run; do
    local rid run_url workflow names todo
    rid=$(jq -r '.databaseId' <<<"$run")
    run_url=$(jq -r '.url' <<<"$run")
    workflow=$(jq -r '.workflowName' <<<"$run")

    names=$(staged_artifact_names "$rid")
    [[ -z "$names" ]] && { log "run $rid ($workflow): no staged-* artifact"; continue; }
    # Name-only precheck: skip the run entirely (no download at all) when
    # every staged-* artifact it holds is already recorded at this run_id —
    # a data package's tarball can be gigabytes, and re-downloading one every
    # 30-minute sweep for weeks until the run ages out of the last-100 list
    # is not a tolerable cost. process_artifact's own check stays the
    # authoritative one; this is only to avoid the bytes.
    todo=()
    while read -r name; do
      already_recorded "$(package_of "$name")" "$(stream_of "$name")" "$rid" "$attempts_file" || todo+=("$name")
    done <<<"$names"
    [[ ${#todo[@]} -eq 0 ]] && { log "run $rid: all staged-* artifacts already recorded, skipping"; continue; }

    # One `gh run download -n` call per artifact, each into its own directory
    # — not one call with several -n flags, which extracts flat (no
    # per-artifact subdirectory) rather than into subdirectories when it
    # resolves to exactly one artifact. Naming the directory ourselves avoids
    # depending on that resolution-count-dependent behavior at all.
    n=$((n + 1))
    for name in "${todo[@]}"; do
      local adir="$WORK/run-$rid/$name"
      mkdir -p "$adir"
      if gh run download "$rid" -R "$BUILD_REPO" -n "$name" -D "$adir" >/dev/null 2>&1; then
        process_artifact_safe "$rid" "$run_url" "$adir" "$attempts_file" "$name" \
          || err=$((err + 1))
      else
        log "run $rid: download failed for artifact $name"
        err=$((err + 1))
      fi
    done
  done < <(jq -c '.[]' "$runs_file")
  log "sweep done ($n run(s) with staged-* artifacts considered, $err error(s))"

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
    post_publish "$body" >/dev/null || { log "self-heal: $universe/$pkg POST failed"; err=$((err + 1)); }
  done < <(jq -r 'to_entries[] | .key as $u | .value | keys[] | [$u, .] | @tsv' "$published_file")

  # SPEC-014: one bad artifact must never abort the sweep — process_artifact_safe
  # (and the download/self-heal failure paths above) makes sure of that. What the
  # exit code reports instead is whether ANYTHING in this run needs a look.
  [[ "$err" -eq 0 ]]
}

universe_of_stream_inverse() { [[ "$1" == "bioc" ]] && echo "devel" || echo "release"; }

# Only run the sweep when executed directly — publish.test.sh sources this file
# to reuse build_entry() etc against a fixture without running main(). WORK is
# a plain global, set (with its cleanup trap) here rather than as a `local`
# inside main() — see the comment at the top of main() for why.
if [[ "${BASH_SOURCE[0]}" == "${0}" ]]; then
  WORK="$(mktemp -d)"
  trap 'rm -rf "${WORK:-}"' EXIT
  main "$@"
fi
