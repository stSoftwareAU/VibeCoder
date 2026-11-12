#!/bin/bash
# Decide the release tag for a merge commit on `main` (Issue #627).
#
# Every part of the version is decided by what the merge changed since the
# last release — there is no hand-edited input. The script reads the git
# repository it is pointed at and classifies the change from the newest
# release tag to the commit:
#
#   major  a line of docs/audits/release-contract.txt at the last release is
#          gone at the commit: a configuration key was removed or renamed, or
#          the callback schema version moved. An operator's .config.json or
#          post-run hook written for the last release no longer means the same
#          thing. A last release that carries no contract record at all cannot
#          show it is compatible, so it is a major too (that is the release
#          that introduced the record: 1.10.x -> 2.0.0).
#   minor  the contract only grew (a new configuration key), or the container
#          definition changed (any path under container/): every existing
#          configuration still loads, but the image a host runs is different.
#   patch  anything else.
#
# The highest category wins, once: 1.4.7 -> 2.0.0, 1.4.7 -> 1.5.0,
# 1.4.7 -> 1.4.8. A repository with no release tag starts at 1.0.0.
#
# The comparison runs from the merge base of the newest release tag and the
# commit, so a run that sees a release newer than its own commit (an
# out-of-order re-run) classifies nothing it does not contain.
#
# The contract record is generated from the code by `deno task
# release-contract` and kept in step by tests/release_contract_test.ts, so the
# record the tagger reads is the surface the code enforces. A commit with no
# record fails loud: the bump cannot be decided, and guessing a patch is the
# exact mistake this script exists to prevent.
#
# Prints three `key=value` lines on stdout, which the caller appends to
# $GITHUB_OUTPUT:
#   should_tag=true|false
#   tag=<the release tag for this commit; empty only when there is none>
#   bump=major|minor|patch|initial|none
#
# `tag` names the commit's release either way: the tag to create when
# should_tag=true, and the tag it already carries when should_tag=false
# (Issue #688). The publish step downstream keys off `tag`, so a re-run
# after a failed manifest publish still has a release to publish for. A
# commit that already carries a release tag is never tagged twice (bump=none).
#
# A release tag is a bare MAJOR.MINOR.PATCH triple, optionally `v`-prefixed.
# Pre-releases (1.0.0-rc1), build metadata and moving names (`latest`) are
# not part of the series and are ignored. Minted tags are always bare.
#
# The checkout must hold every tag and the history back to the newest one
# (actions/checkout with fetch-depth: 0).
#
# Usage: next-release-tag.sh <repository-dir> <commit>
set -euo pipefail

repo="${1:?path to the git repository is required}"
commit_ref="${2:?the commit to tag is required}"

contract_path="docs/audits/release-contract.txt"
release_re='^v?[0-9]+\.[0-9]+\.[0-9]+$'

g() { git -C "$repo" "$@"; }

# Fail loud: a commit that does not resolve is not an untagged commit.
if ! commit="$(g rev-parse --verify --quiet "${commit_ref}^{commit}")"; then
    echo "next-release-tag: not a commit in $repo: $commit_ref" >&2
    exit 1
fi

# Sort "<bare> <as-spelled>" pairs by NUMERIC segment order, so 1.0.10 beats
# 1.0.9 (a lexical sort would not), and print the newest pair.
newest_pair() {
    grep -E "$release_re" |
        awk '{ bare = $0; sub(/^v/, "", bare); print bare, $0 }' |
        sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
}

# Idempotent: a commit that already carries a release tag is left alone. The
# tag is still reported, so the manifest publish downstream can address the
# release it belongs to (Issue #688). Several release tags on one commit is
# not a shape this mints, but if it happens the newest one wins.
existing="$(g tag --points-at "$commit" | newest_pair || true)"
if [[ -n "$existing" ]]; then
    echo "next-release-tag: commit already tagged: ${existing#* }" >&2
    printf 'should_tag=false\ntag=%s\nbump=none\n' "${existing%% *}"
    exit 0
fi

newest="$(g tag --list | newest_pair || true)"
if [[ -z "$newest" ]]; then
    echo "next-release-tag: no release tag yet; next: 1.0.0" >&2
    printf 'should_tag=true\ntag=1.0.0\nbump=initial\n'
    exit 0
fi
newest_version="${newest%% *}"
newest_tag="${newest#* }"

if ! base="$(g merge-base "$newest_tag" "$commit")"; then
    echo "next-release-tag: $newest_tag and $commit share no history" >&2
    exit 1
fi

# The contract entries at a revision, comments and blank lines dropped, in
# byte order so `comm` can compare them. Fails when the record is absent.
contract_at() {
    local text
    text="$(g show "$1:$contract_path" 2>/dev/null)" || return 1
    printf '%s\n' "$text" | grep -v -e '^#' -e '^[[:space:]]*$' | LC_ALL=C sort -u
}

# A short, comma-separated list for the log. awk reads all of its input, so
# nothing upstream is cut off with SIGPIPE (which pipefail would make fatal).
listing() { awk 'NR <= 10' | paste -sd ',' - | sed 's/,/, /g'; }

if ! current="$(contract_at "$commit")"; then
    echo "next-release-tag: $commit has no $contract_path;" \
        "run \`deno task release-contract\` in worker/deno/" >&2
    exit 1
fi

bump="patch"
reason="no contract change and no container change"
if ! previous="$(contract_at "$base")"; then
    bump="major"
    reason="the last release ($newest_tag) has no $contract_path to show compatibility"
else
    removed="$(LC_ALL=C comm -23 <(printf '%s\n' "$previous") <(printf '%s\n' "$current") | sed '/^$/d')"
    added="$(LC_ALL=C comm -13 <(printf '%s\n' "$previous") <(printf '%s\n' "$current") | sed '/^$/d')"
    container="$(g diff --no-renames --name-only "$base" "$commit" -- container/)"
    if [[ -n "$removed" ]]; then
        bump="major"
        reason="contract entries removed: $(listing <<< "$removed")"
    elif [[ -n "$added" ]]; then
        bump="minor"
        reason="contract entries added: $(listing <<< "$added")"
    elif [[ -n "$container" ]]; then
        bump="minor"
        reason="container definition changed: $(listing <<< "$container")"
    fi
fi

IFS=. read -r major minor patch <<< "$newest_version"
# 10# forces base 10: a padded segment such as 08 is otherwise read as an
# invalid octal literal and would abort the arithmetic.
major=$((10#$major)) minor=$((10#$minor)) patch=$((10#$patch))
case "$bump" in
    major) next="$((major + 1)).0.0" ;;
    minor) next="$major.$((minor + 1)).0" ;;
    patch) next="$major.$minor.$((patch + 1))" ;;
esac

echo "next-release-tag: newest release tag: $newest_tag; $bump ($reason); next: $next" >&2
printf 'should_tag=true\ntag=%s\nbump=%s\n' "$next" "$bump"
