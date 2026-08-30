#!/bin/bash
# Decide the release tag for a merge commit on `main` (Issue #627).
#
# Reads two files, each holding one git tag per line:
#   1. every tag in the repository (`git tag --list`)
#   2. the tags already pointing at the commit under consideration
#      (`git tag --points-at <sha>`)
#
# Prints two `key=value` lines on stdout, which the caller appends to
# $GITHUB_OUTPUT:
#   should_tag=true|false
#   tag=<the tag to create; empty when should_tag is false>
#
# Only the patch number is automated. The newest release tag decides the
# major and minor, so a human minting 1.1.0 by hand moves the series and
# the next merge continues from there (1.1.1). A repository with no release
# tag yet starts at 1.0.0. A commit that already carries a release tag is
# never tagged twice, so a re-run is a no-op.
#
# A release tag is a bare MAJOR.MINOR.PATCH triple, optionally `v`-prefixed.
# Pre-releases (1.0.0-rc1), build metadata and moving names (`latest`) are
# not part of the series and are ignored.
#
# Usage: next-release-tag.sh <all-tags-file> <tags-at-commit-file>
set -euo pipefail

all_tags_file="${1:?path to the file listing every tag is required}"
head_tags_file="${2:?path to the file listing the tags on the commit is required}"

# Fail loud: a missing input is not an empty tag list.
for file in "$all_tags_file" "$head_tags_file"; do
    if [[ ! -f "$file" ]]; then
        echo "next-release-tag: no such file: $file" >&2
        exit 1
    fi
done

release_re='^v?[0-9]+\.[0-9]+\.[0-9]+$'

# Idempotent: a commit that already carries a release tag is left alone.
if existing="$(grep -E "$release_re" "$head_tags_file")"; then
    echo "next-release-tag: commit already tagged: $(echo "$existing" | tr '\n' ' ')" >&2
    printf 'should_tag=false\ntag=\n'
    exit 0
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

echo "next-release-tag: newest release tag: ${newest:-<none>}; next: $next" >&2
printf 'should_tag=true\ntag=%s\n' "$next"
