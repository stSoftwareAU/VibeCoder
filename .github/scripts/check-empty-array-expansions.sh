#!/bin/bash
# Flag unsafe empty-array expansions for bash 3.2 / macOS (Issue #1891).
#
# Under `set -u` (nounset), bash 3.2 treats ${arr[@]} on an EMPTY array as an
# unbound variable and aborts. The safe form is ${arr[@]+"${arr[@]}"}, or a
# length guard before the access.
#
# Usage:
#   check-empty-array-expansions.sh                 # every *.sh under the tree
#   check-empty-array-expansions.sh <base-commit>   # only *.sh changed since it
#
# Exit codes:
#   0  the scan ran; any findings are printed as advisory WARNINGs
#   2  the scan could NOT run — bad usage, or <base-commit> is not in the
#      local object store
#
# Why exit 2 exists (Issue #1891): this check used to be an inline `run:`
# block in `.github/workflows/validate-scripts.yml` whose
# `git diff … "<base-sha>" || true` swallowed `fatal: bad object` under the
# job's shallow checkout. The changed-file list came back empty, the scan
# loop never executed, and the step printed "complete" having inspected
# nothing — a silent failure reported as a pass. An unusable base commit now
# fails loud, and the scan always states how many scripts it inspected so a
# vacuous run is visible in the log.
#
# Findings stay advisory: an array proven non-empty by control flow is a
# legitimate false positive, and the check has no way to tell. It is the
# scan NOT RUNNING that is fatal, not what the scan finds.
#
# Australian English is used throughout (behaviour, colour, organisation).
set -euo pipefail

readonly PROGRAM_NAME="${0##*/}"

usage() {
  echo "usage: ${PROGRAM_NAME} [<base-commit>]" >&2
}

if [[ $# -gt 1 ]]; then
  usage
  exit 2
fi

base="${1-}"
if [[ $# -eq 1 && -z "$base" ]]; then
  echo "ERROR: empty base commit argument." >&2
  usage
  exit 2
fi

scripts=()

if [[ $# -eq 1 ]]; then
  # Diff mode. Paths from `git diff` are repository-root relative, so read
  # them from the root whatever directory the caller invoked us in.
  if ! toplevel="$(git rev-parse --show-toplevel 2>/dev/null)"; then
    echo "ERROR: not inside a git repository — cannot diff against ${base}." >&2
    exit 2
  fi
  cd "$toplevel"

  if ! git rev-parse --verify --quiet "${base}^{commit}" >/dev/null; then
    echo "ERROR: base commit ${base} is not in the local object store." >&2
    echo "  The checkout is too shallow to diff against it. Fetch the base" >&2
    echo "  commit first (actions/checkout with fetch-depth: 0, or an" >&2
    echo "  explicit 'git fetch origin ${base}')." >&2
    exit 2
  fi

  changed_list="$(mktemp)"
  trap 'rm -f "$changed_list"' EXIT
  # No `|| true` here, deliberately: a diff that cannot run must stop the
  # check rather than hand it an empty file set.
  if ! git diff --name-only --diff-filter=ACM "$base" -- '*.sh' \
    >"$changed_list"; then
    echo "ERROR: 'git diff' against ${base} failed — see the error above." >&2
    exit 2
  fi

  while IFS= read -r script; do
    [[ -n "$script" ]] || continue
    # A path can be listed and yet be absent from the work tree (a later
    # rename or deletion); skip it rather than fail the scan.
    [[ -f "$script" ]] || continue
    scripts+=("$script")
  done <"$changed_list"
else
  # Whole-tree mode. NUL delimiters so the set survives filenames with
  # spaces or newlines.
  while IFS= read -r -d '' script; do
    scripts+=("${script#./}")
  done < <(find . -name '*.sh' -type f -print0 | sort -z)
fi

errors=0

for script in "${scripts[@]+"${scripts[@]}"}"; do
  # Each `name=()` declaration in the file names an array that starts empty.
  while IFS=: read -r _ decl_line; do
    arr_name="$(echo "$decl_line" |
      grep -oE '[a-zA-Z_][a-zA-Z0-9_]*=\(\)' | sed 's/=()//' | head -1 || true)"
    [[ -z "$arr_name" ]] && continue

    while IFS=: read -r lineno line; do
      echo "$line" | grep -qE '^\s*#' && continue
      echo "$line" | grep -qF "\${${arr_name}[@]+" && continue
      echo "$line" | grep -qE "${arr_name}=\(" && continue
      echo "$line" | grep -qE "${arr_name}\+=" && continue
      if echo "$line" | grep -qE "\\\$\{#${arr_name}\[@\]\}"; then
        bare="$(echo "$line" | grep -oE "\\\$\{${arr_name}\[@\]\}" | head -1 ||
          true)"
        [[ -z "$bare" ]] && continue
      fi
      echo "WARNING: $script:$lineno: $line"
      echo "  Array '${arr_name}' is declared empty — use" \
        "\${${arr_name}[@]+\"\${${arr_name}[@]}\"} or guard with a length check"
      errors=$((errors + 1))
    done < <(grep -nE "\\\$\{${arr_name}\[@\]\}" "$script" 2>/dev/null || true)
  done < <(grep -nE '[a-zA-Z_][a-zA-Z0-9_]*=\(\)' "$script" 2>/dev/null || true)
done

echo ""
echo "Inspected ${#scripts[@]} shell script(s)."
if [[ $errors -gt 0 ]]; then
  echo "Found $errors potentially unsafe empty array expansion(s)."
  echo "Review each warning — if the array is guaranteed non-empty by control"
  echo "flow, this is a false positive. Otherwise, use the safe pattern."
fi
echo "Empty array expansion check complete"
