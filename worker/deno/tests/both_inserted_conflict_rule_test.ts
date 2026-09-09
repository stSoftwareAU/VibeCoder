/**
 * Tests for the append-only ledger rule (Issue #1768, part of #1730).
 *
 * Both sides appended, nothing in the merge base was removed, so both entries
 * are kept — the default branch's first. Everything else defers to the agent:
 * a deleted or edited base line, a file with no merge base, and a `.json`
 * ledger whose union does not parse.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 *
 * The fixtures embed conflict markers at column 0, which is exactly what the CI
 * "Check for merge conflict markers" step looks for; that step honours the
 * sentinel below to exempt this file. Nothing here is an unresolved conflict.
 *
 * vibe-allow-conflict-markers
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  isBothInsertedCandidate,
  resolveBothInserted,
} from "../lib/both_inserted_conflict_rule.ts";
import {
  parseConflictSegments,
  type RuleOutcome,
} from "../lib/dependency_conflict_rules.ts";

/** Parse a conflicted file, failing the test when it will not parse. */
function segments(text: string) {
  const parsed = parseConflictSegments(text);
  assert(parsed.ok, `fixture did not parse: ${!parsed.ok && parsed.error}`);
  return parsed.value;
}

/** Run the rule over a fixture. */
function resolve(
  path: string,
  conflicted: string,
  base: string | null,
): RuleOutcome {
  return resolveBothInserted(segments(conflicted), { path, base });
}

const CHANGELOG_BASE = `# Changelog

## Unreleased

## 1.0.0
`;

/** Both sides appended a different entry under the same heading. */
const CHANGELOG_CONFLICT = `# Changelog

## Unreleased

<<<<<<< HEAD
- the PR's entry

=======
- the base branch's entry

>>>>>>> origin/main
## 1.0.0
`;

// ---------------------------------------------------------------------------
// Both inserted — keep both, the default branch's first
// ---------------------------------------------------------------------------

Deno.test("resolveBothInserted - keeps both entries, the default branch's first", () => {
  const outcome = resolve("CHANGELOG.md", CHANGELOG_CONFLICT, CHANGELOG_BASE);

  assertEquals(outcome.kind, "resolved");
  assertEquals(
    outcome.kind === "resolved" ? outcome.text : "",
    `# Changelog

## Unreleased

- the base branch's entry

- the PR's entry

## 1.0.0
`,
  );
});

Deno.test("resolveBothInserted - resolves every hunk of a multi-hunk ledger", () => {
  const base = "# Ledger\n\n## A\n\n## B\n\n";
  const conflicted = `# Ledger

## A

<<<<<<< HEAD
- ours one

=======
- theirs one

>>>>>>> origin/main
## B

<<<<<<< HEAD
- ours two
=======
- theirs two
>>>>>>> origin/main
`;

  const outcome = resolve("docs/RELEASE-NOTES.md", conflicted, base);

  assertEquals(outcome.kind, "resolved");
  assertEquals(
    outcome.kind === "resolved" ? outcome.text : "",
    `# Ledger

## A

- theirs one

- ours one

## B

- theirs two
- ours two
`,
  );
});

// ---------------------------------------------------------------------------
// Anything that is not two pure insertions defers
// ---------------------------------------------------------------------------

Deno.test("resolveBothInserted - a hunk that deletes a base line defers", () => {
  // The base's `- kept from 1.0.0` line survives on neither side of the hunk.
  const base = "# Changelog\n\n## 1.0.0\n\n- kept from 1.0.0\n";
  const conflicted = `# Changelog

## 1.0.0

<<<<<<< HEAD
- the PR's entry
=======
- the base branch's entry
>>>>>>> origin/main
`;

  const outcome = resolve("CHANGELOG.md", conflicted, base);

  assertEquals(outcome.kind, "unresolved");
  assertStringIncludes(
    outcome.kind === "unresolved" ? outcome.reason : "",
    "does not survive outside the conflict hunks",
  );
});

Deno.test("resolveBothInserted - a hunk that edits a base line defers", () => {
  const base = "# Changelog\n\n## Unreleased\n\n- an entry\n";
  const conflicted = `# Changelog

## Unreleased

<<<<<<< HEAD
- an entry, reworded by the PR
=======
- an entry, reworded by the base branch
>>>>>>> origin/main
`;

  const outcome = resolve("CHANGELOG.md", conflicted, base);

  assertEquals(outcome.kind, "unresolved");
});

Deno.test("resolveBothInserted - a file with no merge base defers rather than assuming an empty one", () => {
  const outcome = resolve("CHANGELOG.md", CHANGELOG_CONFLICT, null);

  assertEquals(outcome.kind, "unresolved");
  assertStringIncludes(
    outcome.kind === "unresolved" ? outcome.reason : "",
    "no merge-base version",
  );
});

Deno.test("resolveBothInserted - a diff3 hunk whose base section is not empty defers", () => {
  const base = "# Changelog\n\n## Unreleased\n\n- an entry\n";
  const conflicted = `# Changelog

## Unreleased

<<<<<<< HEAD
- an entry
- the PR's entry
||||||| merged common ancestors
- an entry
=======
- an entry
- the base branch's entry
>>>>>>> origin/main
`;

  const outcome = resolve("CHANGELOG.md", conflicted, base);

  assertEquals(outcome.kind, "unresolved");
  assertStringIncludes(
    outcome.kind === "unresolved" ? outcome.reason : "",
    "merge base is not empty",
  );
});

Deno.test("resolveBothInserted - a file with no conflict hunk defers", () => {
  const outcome = resolve("CHANGELOG.md", CHANGELOG_BASE, CHANGELOG_BASE);

  assertEquals(outcome.kind, "unresolved");
  assertStringIncludes(
    outcome.kind === "unresolved" ? outcome.reason : "",
    "no conflict hunk",
  );
});

// ---------------------------------------------------------------------------
// JSON ledgers
// ---------------------------------------------------------------------------

Deno.test("resolveBothInserted - a JSON ledger whose union does not parse defers", () => {
  // Two entries appended to the same array without a separating comma.
  const base = '{\n  "entries": [\n  ]\n}\n';
  const conflicted = `{
  "entries": [
<<<<<<< HEAD
    { "id": "ours" }
=======
    { "id": "theirs" }
>>>>>>> origin/main
  ]
}
`;

  const outcome = resolve("docs/audits/ledger.json", conflicted, base);

  assertEquals(outcome.kind, "unresolved");
  assertStringIncludes(
    outcome.kind === "unresolved" ? outcome.reason : "",
    "does not parse as JSON",
  );
});

Deno.test("resolveBothInserted - a JSON ledger whose union parses is kept", () => {
  // A newest-first ledger: both sides prepended an entry above the seed one,
  // so keeping both leaves the array well-formed.
  const base = `{
  "entries": [
    { "id": "seed" }
  ]
}
`;
  const conflicted = `{
  "entries": [
<<<<<<< HEAD
    { "id": "ours" },
=======
    { "id": "theirs" },
>>>>>>> origin/main
    { "id": "seed" }
  ]
}
`;

  const outcome = resolve("docs/audits/ledger.json", conflicted, base);

  assertEquals(outcome.kind, "resolved");
  assertEquals(
    JSON.parse(outcome.kind === "resolved" ? outcome.text : "null"),
    { entries: [{ id: "theirs" }, { id: "ours" }, { id: "seed" }] },
    "both entries survive, the default branch's first, and the result parses",
  );
});

// ---------------------------------------------------------------------------
// Which paths the rule is willing to look at
// ---------------------------------------------------------------------------

Deno.test("isBothInsertedCandidate - manifests and lock files are owned elsewhere", () => {
  for (
    const path of [
      "deno.json",
      "deno.jsonc",
      "package.json",
      "Cargo.toml",
      "go.mod",
      "deno.lock",
      "package-lock.json",
      "Cargo.lock",
      "go.sum",
      "worker/deno/deno.json",
    ]
  ) {
    assertEquals(isBothInsertedCandidate(path), false, path);
  }
});

Deno.test("isBothInsertedCandidate - ordinary text files are candidates", () => {
  for (
    const path of [
      "CHANGELOG.md",
      "docs/RELEASE-NOTES.md",
      "docs/audits/lib-sweep-coverage.json",
      "worker/deno/lib/git_pull.ts",
    ]
  ) {
    assertEquals(isBothInsertedCandidate(path), true, path);
  }
});

Deno.test("resolveBothInserted - another insertion that merged cleanly does not stop the rule", () => {
  // `- a clean addition` is in neither hunk: only one side added it, so git
  // merged it without asking and it sits in the common text.
  const base = "# Changelog\n\n## Unreleased\n\n## 1.0.0\n";
  const conflicted = `# Changelog

## Unreleased

<<<<<<< HEAD
- the PR's entry
=======
- the base branch's entry
>>>>>>> origin/main
- a clean addition

## 1.0.0
`;

  const outcome = resolveBothInserted(segments(conflicted), {
    path: "CHANGELOG.md",
    base,
  });

  assertEquals(outcome.kind, "resolved");
  assertEquals(
    outcome.kind === "resolved" ? outcome.text : "",
    `# Changelog

## Unreleased

- the base branch's entry
- the PR's entry
- a clean addition

## 1.0.0
`,
  );
});
