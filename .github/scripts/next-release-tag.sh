#!/bin/bash
# Decide the release tag for a merge commit on `main` (Issue #627).
#
# Reads two files, each holding one git tag per line:
#   1. every tag in the repository (`git tag --list`)
#   2. the tags already pointing at the commit under consideration
#      (`git tag --points-at <sha>`)
#
# and, optionally, a third file naming a release FLOOR (Issue #808).
#
# Prints two `key=value` lines on stdout, which the caller appends to
# $GITHUB_OUTPUT:
#   should_tag=true|false
#   tag=<the release tag for this commit; empty only when there is none>
#
# `tag` names the commit's release either way: the tag to create when
# should_tag=true, and the tag it already carries when should_tag=false
# (Issue #688). The publish step downstream keys off `tag`, so a re-run
# after a failed manifest publish still has a release to publish for.
#
# Only the patch number is automated. The newest release tag decides the
# major and minor, so a human moving the series edits the floor file (Issue
# #808) and the next merge mints it; merges after that continue from there
# (1.1.0 -> 1.1.1). A repository with no release tag and no floor starts at
# 1.0.0. A commit that already carries a release tag is never tagged twice,
# so a re-run is a no-op — the floor never re-tags a released commit.
#
# The floor file holds one bare version, `#` comments and blank lines
# ignored. The minted tag is the HIGHER of the floor and the automatic
# patch increment, so a floor at or below the series changes nothing and
# the file can be left in place after the release it moved the series to.
#
# A release tag is a bare MAJOR.MINOR.PATCH triple, optionally `v`-prefixed.
# Pre-releases (1.0.0-rc1), build metadata and moving names (`latest`) are
# not part of the series and are ignored.
#
# Usage: next-release-tag.sh <all-tags-file> <tags-at-commit-file> [floor-file]
set -euo pipefail

all_tags_file="${1:?path to the file listing every tag is required}"
head_tags_file="${2:?path to the file listing the tags on the commit is required}"
floor_file="${3:-}"

# Fail loud: a missing input is not an empty tag list. A floor file that was
# named but is not there is the same fault — the caller asked for a floor.
for file in "$all_tags_file" "$head_tags_file" ${floor_file:+"$floor_file"}; do
    if [[ ! -f "$file" ]]; then
        echo "next-release-tag: no such file: $file" >&2
        exit 1
    fi
done

release_re='^v?[0-9]+\.[0-9]+\.[0-9]+$'

# Newest of two release versions by NUMERIC segment order, so 1.0.10 beats
# 1.0.9 (a lexical sort would not). Both arguments must already be bare.
highest_version() {
    printf '%s\n%s\n' "$1" "$2" |
        sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1
}

# Idempotent: a commit that already carries a release tag is left alone.
# The tag is still reported, so the manifest publish downstream can address
# the release it belongs to (Issue #688). Several release tags on one commit
# is not a shape this mints, but if it happens the newest one wins.
if existing="$(grep -E "$release_re" "$head_tags_file")"; then
    echo "next-release-tag: commit already tagged: $(echo "$existing" | tr '\n' ' ')" >&2
    current="$(echo "$existing" | sed 's/^v//' |
        sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
    printf 'should_tag=false\ntag=%s\n' "$current"
    exit 0
fi

# The floor: one version line, so a typo cannot silently mint a version
# nobody chose. Two versions in the file is a fault, not a pick-one.
floor=""
if [[ -n "$floor_file" ]]; then
    while IFS= read -r line || [[ -n "$line" ]]; do
        line="${line%%#*}"
        line="$(echo "$line" | tr -d '[:space:]')"
        [[ -z "$line" ]] && continue
        if [[ -n "$floor" ]]; then
            echo "next-release-tag: $floor_file names more than one version" >&2
            exit 1
        fi
        floor="$line"
    done < "$floor_file"

    if [[ -n "$floor" ]]; then
        if [[ ! "$floor" =~ $release_re ]]; then
            echo "next-release-tag: $floor_file: not a release version: $floor" >&2
            exit 1
        fi
        floor="${floor#v}"
    fi
fi

# Newest tag by NUMERIC segment order, so 1.0.10 beats 1.0.9 (a lexical
# sort would not). The `v` prefix is stripped so both spellings compare.
newest=""
if candidates="$(grep -E "$release_re" "$all_tags_file")"; then
    newest="$(echo "$candidates" | sed 's/^v//' |
        sort -t. -k1,1n -k2,2n -k3,3n | tail -n 1)"
fi

if [[ -z "$newest" ]]; then
    next="1.0.0"
else
    IFS=. read -r major minor patch <<< "$newest"
    # 10# forces base 10: a padded segment such as 08 is otherwise read as
    # an invalid octal literal and would abort the arithmetic.
    next="$((10#$major)).$((10#$minor)).$((10#$patch + 1))"
fi

# The floor only ever raises the mint. Once the release it names exists, the
# automatic increment is already above it and this is a no-op (Issue #808).
if [[ -n "$floor" ]]; then
    raised="$(highest_version "$next" "$floor")"
    if [[ "$raised" != "$next" ]]; then
        echo "next-release-tag: release floor $floor raises $next" >&2
        next="$raised"
    fi
fi

echo "next-release-tag: newest release tag: ${newest:-<none>}; next: $next" >&2
printf 'should_tag=true\ntag=%s\n' "$next"
