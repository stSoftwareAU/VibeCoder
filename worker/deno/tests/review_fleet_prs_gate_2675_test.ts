/**
 * The deterministic gate of the review-fleet-prs Claude Code skill (Issue #2675).
 * It decides which fleet PRs are worth a model review; the review itself is
 * the skill's job.
 */
import { assertEquals, assertRejects } from "@std/assert";
import {
  authorKind,
  existingTestChanges,
  isTestPath,
  noTestAdded,
  ownDiffUnchanged,
  REVIEW_MARKER,
  reviewedAtHead,
  type RollupContextNode,
  runWithTimeout,
  type SearchPr,
  sentBackAt,
  skipReason,
} from "../../../.claude/skills/review-fleet-prs/scripts/gate.ts";

const file = (
  filename: string,
  status: string,
  additions: number,
  deletions: number,
  previous_filename?: string,
) => ({
  filename,
  status,
  additions,
  deletions,
  previous_filename,
});

Deno.test("isTestPath recognises the fleet's test layouts and not source files", () => {
  for (
    const path of [
      "worker/deno/tests/foo_test.ts",
      "src/foo.test.ts",
      "pkg/foo_test.go",
      "test_foo.py",
      "ockham/tests/workflow_overlap.rs",
      "src/test/java/FooTest.java",
      "test/QualityWorkflow.ts",
    ]
  ) assertEquals(isTestPath(path), true, path);
  for (
    const path of [
      "worker/deno/lib/foo.ts",
      "src/latest.rs",
      "README.md",
      "src/contest.ts",
    ]
  ) {
    assertEquals(isTestPath(path), false, path);
  }
});

Deno.test("existingTestChanges: removed and edited existing tests are listed, new and appended ones are not", () => {
  const changes = existingTestChanges([
    file("tests/gone_test.ts", "removed", 0, 40),
    file("tests/edited_test.ts", "modified", 3, 2),
    file("tests/appended_test.ts", "modified", 20, 0),
    file("tests/new_test.ts", "added", 50, 0),
    file("tests/moved_test.ts", "renamed", 0, 0, "tests/old_test.ts"),
    file("lib/foo.ts", "modified", 5, 5),
  ]);
  assertEquals(changes, {
    removed: ["tests/gone_test.ts"],
    edited: ["tests/edited_test.ts", "tests/moved_test.ts"],
  });
});

Deno.test("noTestAdded: fleet code without a test is flagged; with a test, docs-only, or from Dependabot, it is not", () => {
  const code = file("lib/foo.ts", "modified", 10, 2);
  assertEquals(noTestAdded([code], "fleet"), true);
  assertEquals(
    noTestAdded([code, file("tests/foo_test.ts", "modified", 8, 0)], "fleet"),
    false,
  );
  assertEquals(noTestAdded([code], "dependabot"), false);
  assertEquals(
    noTestAdded([file("docs/x.md", "modified", 10, 2)], "fleet"),
    false,
  );
});

Deno.test("authorKind: Dependabot and the fleet accounts only", () => {
  const fleet = new Set(["stservice", "VibeCoderST"]);
  assertEquals(authorKind("app/dependabot", fleet), "dependabot");
  assertEquals(authorKind("VibeCoderST", fleet), "fleet");
  assertEquals(authorKind("nleck", fleet), null);
});

const searchPr = (
  overrides: Partial<SearchPr> = {},
  rollup: string | null = "SUCCESS",
  contexts?: RollupContextNode[],
): SearchPr => ({
  number: 1,
  title: "t",
  url: "https://github.com/o/r/pull/1",
  isDraft: false,
  mergeable: "MERGEABLE",
  headRefOid: "head",
  baseRefName: "main",
  repository: { nameWithOwner: "o/r", defaultBranchRef: { name: "main" } },
  author: { login: "stservice" },
  commits: {
    nodes: [{
      commit: {
        statusCheckRollup: rollup === null ? null : {
          state: rollup,
          ...(contexts ? { contexts: { nodes: contexts } } : {}),
        },
        checkSuites: { nodes: [] },
      },
    }],
  },
  reviews: { nodes: [] },
  ...overrides,
});

Deno.test("skipReason: only a green, mergeable, unreviewed, non-draft PR is ready", async () => {
  assertEquals(await skipReason(searchPr(), "nleck"), null);
  assertEquals(
    await skipReason(searchPr({}, "PENDING"), "nleck"),
    "waiting-ci",
  );
  assertEquals(await skipReason(searchPr({}, null), "nleck"), "waiting-ci");
  assertEquals(
    await skipReason(searchPr({}, "FAILURE"), "nleck"),
    "ci-failed",
  );
  assertEquals(await skipReason(searchPr({}, "ERROR"), "nleck"), "ci-failed");
  assertEquals(
    await skipReason(searchPr({ isDraft: true }), "nleck"),
    "draft",
  );
  assertEquals(
    await skipReason(searchPr({ baseRefName: "milestone/42-x" }), "nleck"),
    "not-default-branch",
  );
  assertEquals(
    await skipReason(searchPr({ mergeable: "CONFLICTING" }), "nleck"),
    "conflicting",
  );
  assertEquals(
    await skipReason(searchPr({ mergeable: "UNKNOWN" }), "nleck"),
    null,
  );
  const approved = {
    nodes: [{
      author: { login: "nleck" },
      state: "APPROVED",
      body: "",
      commit: { oid: "head" },
    }],
  };
  assertEquals(
    await skipReason(searchPr({ reviews: approved }), "nleck"),
    "already-reviewed",
  );
});

Deno.test("skipReason: a red rollup whose every red check is cancelled is ci-cancelled (Issue #2916)", async () => {
  const cancelled: RollupContextNode[] = [
    { __typename: "CheckRun", conclusion: "CANCELLED" },
    { __typename: "CheckRun", conclusion: "CANCELLED" },
    // A green check beside them does not matter.
    { __typename: "CheckRun", conclusion: "SUCCESS" },
  ];
  assertEquals(
    await skipReason(searchPr({}, "FAILURE", cancelled), "nleck"),
    "ci-cancelled",
  );
  assertEquals(
    await skipReason(searchPr({}, "ERROR", cancelled), "nleck"),
    "ci-cancelled",
  );
});

Deno.test("skipReason: a real failure anywhere keeps the PR ci-failed (Issue #2916)", async () => {
  const cancelledPlusFailure: RollupContextNode[] = [
    { __typename: "CheckRun", conclusion: "CANCELLED" },
    { __typename: "CheckRun", conclusion: "FAILURE" },
  ];
  assertEquals(
    await skipReason(searchPr({}, "FAILURE", cancelledPlusFailure), "nleck"),
    "ci-failed",
  );
  // A red commit-status context is a real failure too, whatever the
  // cancelled CheckRuns beside it say.
  const cancelledPlusStatus: RollupContextNode[] = [
    { __typename: "CheckRun", conclusion: "CANCELLED" },
    { __typename: "StatusContext", state: "ERROR" },
  ];
  assertEquals(
    await skipReason(searchPr({}, "FAILURE", cancelledPlusStatus), "nleck"),
    "ci-failed",
  );
});

Deno.test("skipReason: a red rollup with no contexts is ci-failed (Issue #2916)", async () => {
  // `contexts` is optional on the query result, and a FAILURE rollup from
  // an older query shape carried none.
  assertEquals(
    await skipReason(searchPr({}, "FAILURE"), "nleck"),
    "ci-failed",
  );
});

Deno.test("reviewedAtHead: approvals, change requests and the skill's own comment reviews count at the head commit only", () => {
  const review = (
    state: string,
    commit_id: string,
    body = "",
    login = "nleck",
  ) => ({
    author: { login },
    commit: { oid: commit_id },
    state,
    body,
  });
  assertEquals(
    reviewedAtHead([review("APPROVED", "head")], "nleck", "head"),
    true,
  );
  assertEquals(
    reviewedAtHead([review("CHANGES_REQUESTED", "head")], "nleck", "head"),
    true,
  );
  assertEquals(
    reviewedAtHead(
      [review("COMMENTED", "head", `Held. ${REVIEW_MARKER}`)],
      "nleck",
      "head",
    ),
    true,
  );
  assertEquals(
    reviewedAtHead(
      [review("COMMENTED", "head", "a note of my own")],
      "nleck",
      "head",
    ),
    false,
  );
  assertEquals(
    reviewedAtHead([review("DISMISSED", "head")], "nleck", "head"),
    true,
  );
  assertEquals(
    reviewedAtHead([review("APPROVED", "older")], "nleck", "head"),
    false,
  );
  assertEquals(
    reviewedAtHead(
      [review("APPROVED", "head", "", "someone-else")],
      "nleck",
      "head",
    ),
    false,
  );
});

// --- Issue #3063: awaiting-fix skip reason ---------------------------------

const review = (
  state: string,
  commit_id: string | null,
  body = "",
  login = "nleck",
) => ({
  author: { login },
  commit: commit_id === null ? null : { oid: commit_id },
  state,
  body,
});

Deno.test("sentBackAt: the latest counted review decides the verdict", () => {
  // CHANGES_REQUESTED then APPROVED → null.
  assertEquals(
    sentBackAt(
      [review("CHANGES_REQUESTED", "X"), review("APPROVED", "head")],
      "nleck",
      "head",
    ),
    null,
  );
  // APPROVED then CHANGES_REQUESTED at X → "X".
  assertEquals(
    sentBackAt(
      [review("APPROVED", "older"), review("CHANGES_REQUESTED", "X")],
      "nleck",
      "head",
    ),
    "X",
  );
  // Change request at head → null (nothing to skip: head already counted).
  assertEquals(
    sentBackAt([review("CHANGES_REQUESTED", "head")], "nleck", "head"),
    null,
  );
  // DISMISSED latest, no log lookup given → null: the default cannot tell a
  // stale-dismissed approval from a claimed change request.
  assertEquals(
    sentBackAt(
      [review("CHANGES_REQUESTED", "X"), review("DISMISSED", "X")],
      "nleck",
      "head",
    ),
    null,
  );
  // DISMISSED latest, the log says this PR was sent back at X (the worker
  // claimed and dismissed the change request before pushing the fix) → "X"
  // (Issue #3079).
  assertEquals(
    sentBackAt(
      [review("CHANGES_REQUESTED", "X"), review("DISMISSED", "X")],
      "nleck",
      "head",
      (oid) => oid === "X",
    ),
    "X",
  );
  // DISMISSED latest, the log says this was a dismissed approval (or has no
  // record) → still null, even with a lookup given.
  assertEquals(
    sentBackAt(
      [review("APPROVED", "X"), review("DISMISSED", "X")],
      "nleck",
      "head",
      () => false,
    ),
    null,
  );
  // Someone else's change request → null.
  assertEquals(
    sentBackAt(
      [review("CHANGES_REQUESTED", "X", "", "someone-else")],
      "nleck",
      "head",
    ),
    null,
  );
  // An owner's unmarked COMMENTED after the change request does not hide it.
  assertEquals(
    sentBackAt(
      [
        review("CHANGES_REQUESTED", "X"),
        review("COMMENTED", "Y", "a note", "owner"),
      ],
      "nleck",
      "head",
    ),
    "X",
  );
});

const compareResponse = (
  status: string,
  commits: { sha: string; parents: number }[],
) =>
  JSON.stringify({
    status,
    total_commits: commits.length,
    commits: commits.map((c) => ({
      sha: c.sha,
      parents: Array.from({ length: c.parents }, (_, i) => ({ sha: `p${i}` })),
    })),
  });

const compareFiles = (
  files: {
    filename: string;
    status?: string;
    patch?: string;
    previous_filename?: string;
    sha?: string | null;
  }[],
) =>
  JSON.stringify({
    files: files.map((f) => ({
      filename: f.filename,
      status: f.status ?? "modified",
      previous_filename: f.previous_filename,
      ...(f.patch !== undefined ? { patch: f.patch } : {}),
      ...(f.sha !== undefined ? { sha: f.sha } : {}),
    })),
  });

function fakeGh(
  responses: Record<string, string>,
): { gh: (args: string[]) => Promise<string>; calls: string[] } {
  const calls: string[] = [];
  const gh = (args: string[]) => {
    const endpoint = args[1]!;
    calls.push(endpoint);
    if (endpoint in responses) return Promise.resolve(responses[endpoint]!);
    throw new Error(`unexpected endpoint: ${endpoint}`);
  };
  return { gh, calls };
}

const versionPatch = (from: string, to: string) =>
  `@@ -1 +1 @@\n-${from}\n+${to}`;

Deno.test("own-diff version-only increments await the existing fix, including a separate bump commit (Issue #3713)", async () => {
  for (
    const commits of [
      [{ sha: "merge", parents: 2 }],
      [{ sha: "merge", parents: 2 }, { sha: "bump", parents: 1 }],
    ]
  ) {
    const { gh } = fakeGh({
      "repos/o/r/compare/X...head": compareResponse("ahead", commits),
      "repos/o/r/compare/main...X": compareFiles([
        { filename: "VERSION", patch: versionPatch("1.32.4", "1.32.5") },
        { filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+unfixed" },
      ]),
      "repos/o/r/compare/main...head": compareFiles([
        { filename: "VERSION", patch: versionPatch("1.32.5", "1.32.6") },
        { filename: "a.ts", patch: "@@ -3 +3 @@\n-old\n+unfixed" },
      ]),
    });
    assertEquals(
      await skipReason(
        searchPr({
          headRefOid: "head",
          baseRefName: "main",
          reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
        }),
        "nleck",
        (since) =>
          ownDiffUnchanged(gh, "o/r", "main", since, "head", [{
            file: "a.ts",
          }]),
      ),
      "awaiting-fix",
    );
  }
});

// Shape observed with git diff --no-index over JSON and TOML manifests:
// unchanged context is prefixed with a space and counts towards both ranges.
const manifestPatch = (from: string, to: string, kind = "json") =>
  kind === "json"
    ? `@@ -1,5 +1,5 @@
 {
-  "version": "${from}",
+  "version": "${to}",
   "license": "MIT",
   "imports": {}
 }`
    : `@@ -1,3 +1,3 @@
 [package]
-version = "${from}"
+version = "${to}"
 license = "MIT"`;

Deno.test("manifest-only version re-bumps await the existing fix (Issue #4391)", async () => {
  for (const kind of ["json", "toml"]) {
    for (
      const versions of [["1.2.3", "1.2.4", "1.2.5"], [
        "1.2.9007199254740992",
        "1.2.9007199254740993",
        "1.2.9007199254740994",
      ]]
    ) {
      const filename = kind === "json" ? "deno.json" : "Cargo.toml";
      const { gh } = fakeGh({
        "repos/o/r/compare/X...head": compareResponse("ahead", [
          { sha: "merge", parents: 2 },
          { sha: "bump", parents: 1 },
        ]),
        "repos/o/r/compare/main...X": compareFiles([
          { filename, patch: manifestPatch(versions[0]!, versions[1]!, kind) },
          { filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+unfixed" },
        ]),
        "repos/o/r/compare/main...head": compareFiles([
          { filename, patch: manifestPatch(versions[1]!, versions[2]!, kind) },
          { filename: "a.ts", patch: "@@ -3 +3 @@\n-old\n+unfixed" },
        ]),
      });
      assertEquals(
        await skipReason(
          searchPr({ reviews: { nodes: [review("CHANGES_REQUESTED", "X")] } }),
          "nleck",
          (since) =>
            ownDiffUnchanged(gh, "o/r", "main", since, "head", [{
              file: "a.ts",
            }]),
        ),
        "awaiting-fix",
        `${kind}: ${versions.join(" -> ")}`,
      );
    }
  }
});

Deno.test("manifest version exception still reviews other edits and malformed patches (Issue #4391)", async () => {
  const prior = manifestPatch("1.2.3", "1.2.4");
  const next = manifestPatch("1.2.4", "1.2.5");
  const dependency = (patch: string) =>
    patch.replaceAll('"version"', '"dependency"');
  const cases: {
    name: string;
    oldPatch?: string;
    newPatch: string;
    findings?: { file: string }[];
    otherPatch?: string;
    findingsMissing?: boolean;
  }[] = [
    { name: "another file changed", newPatch: next, otherPatch: "+fixed" },
    {
      name: "another key",
      oldPatch: dependency(prior),
      newPatch: dependency(next),
    },
    {
      name: "dependency pin",
      oldPatch: dependency(prior).replaceAll('"1.', '"@1.'),
      newPatch: dependency(next).replaceAll('"1.', '"@1.'),
    },
    {
      name: "adjacent edit",
      newPatch: next.replace(
        '   "license": "MIT",',
        '-  "license": "MIT",\n+  "license": "Apache-2.0",',
      ),
    },
    {
      name: "finding on manifest",
      newPatch: next,
      findings: [{ file: "deno.json" }],
    },
    {
      name: "qualified finding on manifest",
      newPatch: next,
      findings: [{ file: "./deno.json" }],
    },
    { name: "findings unavailable", newPatch: next, findingsMissing: true },
    {
      name: "changed indentation",
      newPatch: next.replace('+  "version"', '+    "version"'),
    },
    {
      name: "changed separator",
      newPatch: next.replace('+  "version":', '+  "version" :'),
    },
    {
      name: "changed trailing comma",
      newPatch: next.replace('+  "version": "1.2.5",', '+  "version": "1.2.5"'),
    },
    { name: "truncated context", newPatch: next.slice(0, -2) },
    { name: "wrong old count", newPatch: next.replace("-1,5", "-1,6") },
    { name: "wrong new count", newPatch: next.replace("+1,5", "+1,6") },
    { name: "second hunk", newPatch: next + "\n@@ -20 +20 @@\n-old\n+new" },
    {
      name: "newline marker",
      newPatch: next + "\n\\ No newline at end of file",
    },
    { name: "version downgrade", newPatch: manifestPatch("1.2.5", "1.2.4") },
    {
      name: "prior downgrade",
      oldPatch: manifestPatch("1.2.4", "1.2.3"),
      newPatch: next,
    },
    { name: "equal version", newPatch: manifestPatch("1.2.5", "1.2.5") },
    {
      name: "suffix-only change",
      newPatch: manifestPatch("1.2.5-beta.1", "1.2.5-beta.2"),
    },
    {
      name: "component count change",
      newPatch: manifestPatch("1.2.4", "1.2.5.0"),
    },
    { name: "prefixed version", newPatch: manifestPatch("v1.2.4", "v1.2.5") },
    {
      name: "commented JSON key",
      newPatch: next.replaceAll('  "version"', '  // "version"'),
    },
    {
      name: "escaped JSON key",
      newPatch: next.replaceAll('"version"', '"ver\\u0073ion"'),
    },
    {
      name: "TOML other key",
      oldPatch: manifestPatch("1.2.3", "1.2.4", "toml").replaceAll(
        "version =",
        "dependency =",
      ),
      newPatch: manifestPatch("1.2.4", "1.2.5", "toml").replaceAll(
        "version =",
        "dependency =",
      ),
    },
    {
      name: "TOML trailing comma",
      newPatch: manifestPatch("1.2.4", "1.2.5", "toml").replaceAll(
        '"\n',
        '",\n',
      ),
    },
  ];
  for (const c of cases) {
    const { gh } = fakeGh({
      "repos/o/r/compare/X...head": compareResponse("ahead", [{
        sha: "bump",
        parents: 1,
      }]),
      "repos/o/r/compare/main...X": compareFiles([
        { filename: "deno.json", patch: c.oldPatch ?? prior },
        { filename: "a.ts", patch: "+unfixed" },
      ]),
      "repos/o/r/compare/main...head": compareFiles([
        { filename: "deno.json", patch: c.newPatch },
        { filename: "a.ts", patch: c.otherPatch ?? "+unfixed" },
      ]),
    });
    assertEquals(
      await skipReason(
        searchPr({ reviews: { nodes: [review("CHANGES_REQUESTED", "X")] } }),
        "nleck",
        (since) =>
          ownDiffUnchanged(
            gh,
            "o/r",
            "main",
            since,
            "head",
            c.findingsMissing ? undefined : c.findings ?? [{ file: "a.ts" }],
          ),
      ),
      null,
      c.name,
    );
  }
});

// Issue #4516: a deno.json can re-bump its version in one hunk while a
// dependency pin in another hunk stays put. Each hunk has three context lines
// either side of its single changed line, so both header ranges count seven.
const versionHunk = (from: string, to: string, header = "@@ -1,7 +1,7 @@") =>
  [
    header,
    " {",
    `   "name": "@o/r",`,
    `   "license": "MIT",`,
    `-  "version": "${from}",`,
    `+  "version": "${to}",`,
    `   "imports": {},`,
    `   "tasks": {},`,
    `   "lock": false`,
  ].join("\n");
const pinHunk = (
  pin: string,
  header = "@@ -38,7 +38,7 @@",
  scope = "@std",
) =>
  [
    header,
    `     "${scope}/assert": "jsr:${scope}/assert@1.0.0",`,
    `     "${scope}/fs": "jsr:${scope}/fs@1.0.0",`,
    `     "${scope}/json": "jsr:${scope}/json@1.0.0",`,
    `-    "@stsoftware/tags": "jsr:@stsoftware/tags@1.0.36",`,
    `+    "@stsoftware/tags": "jsr:@stsoftware/tags@${pin}",`,
    `     "${scope}/path": "jsr:${scope}/path@1.0.0",`,
    `     "${scope}/toml": "jsr:${scope}/toml@1.0.0",`,
    `     "${scope}/yaml": "jsr:${scope}/yaml@1.0.0"`,
  ].join("\n");

Deno.test("multi-hunk manifest version re-bump awaits the existing fix when the other hunks are unchanged (Issue #4516)", async () => {
  const pin = pinHunk("1.0.40");
  const sinceBump = [versionHunk("1.2.3", "1.2.4"), pin].join("\n");
  const headBump = [versionHunk("1.2.4", "1.2.5"), pin].join("\n");
  const secondVersionHeader = "@@ -38,7 +38,7 @@";
  const cases: {
    name: string;
    since: string;
    head: string;
    findings?: { file: string }[];
    findingsMissing?: boolean;
    expected: string | null;
  }[] = [
    {
      name: "version re-bumps and the pin hunk is unchanged",
      since: sinceBump,
      head: headBump,
      expected: "awaiting-fix",
    },
    {
      name: "pin hunk changed at head",
      since: sinceBump,
      head: [versionHunk("1.2.4", "1.2.5"), pinHunk("1.0.41")].join("\n"),
      expected: null,
    },
    {
      name: "two version hunks both changed",
      since: [
        versionHunk("1.2.3", "1.2.4"),
        versionHunk("2.0.0", "2.0.1", secondVersionHeader),
      ].join("\n"),
      head: [
        versionHunk("1.2.4", "1.2.5"),
        versionHunk("2.0.1", "2.0.2", secondVersionHeader),
      ].join("\n"),
      expected: null,
    },
    {
      name: "hunk counts differ",
      since: versionHunk("1.2.3", "1.2.4"),
      head: headBump,
      expected: null,
    },
    {
      name: "finding on the manifest",
      since: sinceBump,
      head: headBump,
      findings: [{ file: "deno.json" }],
      expected: null,
    },
    {
      name: "pin hunk context moved by a base merge",
      since: sinceBump,
      head: [
        versionHunk("1.2.4", "1.2.5"),
        pinHunk("1.0.40", "@@ -41,7 +41,7 @@", "@deno"),
      ].join("\n"),
      expected: "awaiting-fix",
    },
    {
      name: "findings unavailable",
      since: sinceBump,
      head: headBump,
      findingsMissing: true,
      expected: null,
    },
  ];
  for (const c of cases) {
    const { gh } = fakeGh({
      "repos/o/r/compare/X...head": compareResponse("ahead", [
        { sha: "merge", parents: 2 },
        { sha: "bump", parents: 1 },
      ]),
      "repos/o/r/compare/main...X": compareFiles([
        { filename: "deno.json", patch: c.since },
        { filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+unfixed" },
      ]),
      "repos/o/r/compare/main...head": compareFiles([
        { filename: "deno.json", patch: c.head },
        { filename: "a.ts", patch: "@@ -3 +3 @@\n-old\n+unfixed" },
      ]),
    });
    assertEquals(
      await skipReason(
        searchPr({ reviews: { nodes: [review("CHANGES_REQUESTED", "X")] } }),
        "nleck",
        (since) =>
          ownDiffUnchanged(
            gh,
            "o/r",
            "main",
            since,
            "head",
            c.findingsMissing ? undefined : c.findings ?? [{ file: "a.ts" }],
          ),
      ),
      c.expected,
      c.name,
    );
  }
});

Deno.test("manifest version exception refuses hostile long inputs, accepting the same shape when well formed (Issue #4391)", async () => {
  const blanks = " ".repeat(1_000_000);
  const suffix = "a".repeat(100000);
  const hunk = (header: string, from: string, to: string) =>
    `${header}\n context\n-${from}\n+${to}\n context`;
  // One run of the character each pattern repeats, then a character it
  // rejects: catastrophic backtracking would never return on these.
  const cases: {
    name: string;
    filename: string;
    line: (version: string, tail: string) => string;
  }[] = [
    {
      name: "JSON blanks around the optional comma",
      filename: "deno.json",
      line: (v, tail) => `  "version": "${v}"${blanks}${tail}`,
    },
    {
      name: "TOML blanks after the closing quote",
      filename: "Cargo.toml",
      line: (v, tail) => `version = "${v}"${blanks}${tail}`,
    },
    {
      name: "bare version suffix",
      filename: "VERSION",
      line: (v, tail) => `${v}-${suffix}${tail}`,
    },
  ];
  const check = async (
    filename: string,
    headPatch: string,
    expected: boolean,
    name: string,
  ) => {
    const { gh } = fakeGh({
      "repos/o/r/compare/X...head": compareResponse("ahead", [
        { sha: "bump", parents: 1 },
      ]),
      "repos/o/r/compare/main...X": compareFiles([
        { filename, patch: manifestPatch("1.2.3", "1.2.4", "toml") },
      ]),
      "repos/o/r/compare/main...head": compareFiles([
        { filename, patch: headPatch },
      ]),
    });
    assertEquals(
      await ownDiffUnchanged(gh, "o/r", "main", "X", "head", []),
      expected,
      name,
    );
  };
  for (const c of cases) {
    const header = "@@ -1,3 +1,3 @@";
    // Control: the shape with no rejected character after the run is accepted.
    await check(
      c.filename,
      hunk(header, c.line("1.2.5", ""), c.line("1.2.6", "")),
      true,
      `${c.name}: well formed`,
    );
    await check(
      c.filename,
      hunk(header, c.line("1.2.5", "!"), c.line("1.2.6", "!")),
      false,
      `${c.name}: hostile`,
    );
  }
  await check(
    "deno.json",
    hunk(
      `@@ -1,${"9".repeat(100000)}! +1,3 @@`,
      '  "version": "1.2.5",',
      '  "version": "1.2.6",',
    ),
    false,
    "hunk header line count",
  );
});

Deno.test("own-diff version exception is conservative about patches, ordering, other files and earlier findings (Issue #3713)", async () => {
  const prior = versionPatch("1.32.4", "1.32.5");
  const next = versionPatch("1.32.5", "1.32.6");
  for (
    const [oldPatch, newPatch, findings, otherPatch, expected] of [
      [prior, next, [], "+different", false],
      [prior, `${next}\n-old text\n+new text`, [], "+same", false],
      [prior, `${next}\n@@ -4 +4 @@\n-2.0\n+2.1`, [], "+same", false],
      [prior, next, [{ file: "VERSION" }], "+same", false],
      [prior, next, [{ file: "./VERSION" }], "+same", false],
      [prior, next, undefined, "+same", false],
      [prior, versionPatch("1.32.7", "1.32.6"), [], "+same", false],
      [versionPatch("1.32.5", "1.32.4"), next, [], "+same", false],
      [prior, versionPatch("1.32.6", "1.32.6"), [], "+same", false],
      [prior, versionPatch("v1.32.5", "v1.32.6"), [], "+same", false],
      [versionPatch("v1.32.4", "1.32.5"), next, [], "+same", false],
      [prior, versionPatch("1.32.5", "v1.32.6"), [], "+same", false],
      [versionPatch(" 1.32.4", "1.32.5"), next, [], "+same", false],
      [prior, versionPatch("1.32.5", "1.32.6 "), [], "+same", false],
      [
        prior,
        versionPatch("1.32.5", "1.32.6") + "\n\\ No newline at end of file",
        [],
        "+same",
        false,
      ],
      [prior, "@@ -1,9 +1,9 @@\n-1.32.5\n+1.32.6", [], "+same", false],
      [prior, versionPatch("1.32.5", "1.32.6.0"), [], "+same", false],
      [
        versionPatch("1.9", "1.10"),
        versionPatch("1.10", "1.11"),
        [],
        "+same",
        true,
      ],
      [
        versionPatch("1.2.3.9", "1.2.3.10"),
        versionPatch("1.2.3.10", "1.2.4.0"),
        [],
        "+same",
        true,
      ],
      [
        versionPatch("1.2.3-beta.1", "1.2.4-beta.2"),
        versionPatch("1.2.4-beta.2", "1.2.5+build.1"),
        [],
        "+same",
        true,
      ],
      [
        prior,
        versionPatch("1.32.6-beta.1", "1.32.6-beta.2"),
        [],
        "+same",
        false,
      ],
      [
        prior,
        versionPatch("1.32.6+build.1", "1.32.6+build.2"),
        [],
        "+same",
        false,
      ],
    ] as [string, string, { file: string }[] | undefined, string, boolean][]
  ) {
    const { gh } = fakeGh({
      "repos/o/r/compare/X...head": compareResponse("ahead", [{
        sha: "merge",
        parents: 2,
      }, { sha: "bump", parents: 1 }]),
      "repos/o/r/compare/main...X": compareFiles([{
        filename: "VERSION",
        patch: oldPatch,
      }, { filename: "a.ts", patch: "+same" }]),
      "repos/o/r/compare/main...head": compareFiles([{
        filename: "VERSION",
        patch: newPatch,
      }, { filename: "a.ts", patch: otherPatch }]),
    });
    assertEquals(
      await ownDiffUnchanged(gh, "o/r", "main", "X", "head", findings),
      expected,
      JSON.stringify({ oldPatch, newPatch, findings, otherPatch }),
    );
  }
});

Deno.test("own-diff version exception never hides a file addition or rename (Issue #3713)", async () => {
  for (const status of ["added", "renamed"]) {
    const { gh } = fakeGh({
      "repos/o/r/compare/X...head": compareResponse("ahead", [{
        sha: "bump",
        parents: 1,
      }]),
      "repos/o/r/compare/main...X": compareFiles([{
        filename: "VERSION",
        status,
        previous_filename: "old-version",
        patch: versionPatch("1.32.4", "1.32.5"),
      }]),
      "repos/o/r/compare/main...head": compareFiles([{
        filename: "VERSION",
        status,
        previous_filename: "old-version",
        patch: versionPatch("1.32.5", "1.32.6"),
      }]),
    });
    assertEquals(
      await ownDiffUnchanged(gh, "o/r", "main", "X", "head", []),
      false,
      status,
    );
  }
});

Deno.test("skipReason: a merge-only head after a send-back is awaiting-fix (Issue #3063)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  // GitHub's real compare/X...head also lists the single-parent base
  // commits a merge brought in, not just the 2-parent merge commit itself
  // (Issue #3079 — GRQ-AutoTrader #2213, #2210, #2218).
  const { gh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [
      { sha: "base1", parents: 1 },
      { sha: "m1", parents: 2 },
    ]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -11,3 +11,4 @@\n+x",
    }]),
  });
  assertEquals(
    await skipReason(
      pr,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
    ),
    "awaiting-fix",
  );
});

Deno.test("skipReason: a claimed (DISMISSED, logged changes_requested) review followed by a merge-only head is awaiting-fix; a DISMISSED approval is not (Issue #3079)", async () => {
  const { gh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -11,3 +11,4 @@\n+x",
    }]),
  });
  const claimed = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("DISMISSED", "X")] },
  });
  assertEquals(
    await skipReason(
      claimed,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
      (oid) => oid === "X",
    ),
    "awaiting-fix",
  );

  const dismissedApproval = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("DISMISSED", "X")] },
  });
  assertEquals(
    await skipReason(
      dismissedApproval,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
      () => false,
    ),
    null,
  );
});

Deno.test("skipReason: a merge with conflict-resolution edits is a fresh review (Issue #3063)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  const { gh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+y",
    }]),
  });
  assertEquals(
    await skipReason(
      pr,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
    ),
    null,
  );
});

Deno.test("skipReason: a fix commit changes the merge-base diff and gets a fresh review (Issue #3079)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  // A single-parent fix commit is no longer rejected by its own parent
  // count — the merge-base diff is what proves it changed the PR.
  const { gh, calls } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "fix1",
      parents: 1,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x\n+y",
    }]),
  });
  assertEquals(
    await skipReason(
      pr,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
    ),
    null,
  );
  assertEquals(calls, [
    "repos/o/r/compare/X...head",
    "repos/o/r/compare/main...X",
    "repos/o/r/compare/main...head",
  ]);
});

Deno.test("skipReason: an approved PR whose head moved by a base merge never calls the checker (Issue #3063)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("APPROVED", "X")] },
  });
  let called = false;
  assertEquals(
    await skipReason(pr, "nleck", () => {
      called = true;
      return Promise.resolve(true);
    }),
    null,
  );
  assertEquals(called, false);
});

Deno.test("ownDiffUnchanged returns false rather than throwing (Issue #3063)", async () => {
  // gh throws, e.g. a 404 for a force-pushed commit.
  const throwing = (_args: string[]): Promise<string> => {
    throw new Error("gh: 404 Not Found");
  };
  assertEquals(
    await ownDiffUnchanged(throwing, "o/r", "main", "X", "head"),
    false,
  );

  // Identical merge-base file lists on both sides: if the guard under test
  // did not return false, every later check would pass and the function
  // would return true, so each case below only stays green because its own
  // guard fires first (Issue #3079).
  const sameFiles = compareFiles([{
    filename: "a.ts",
    patch: "@@ -1,3 +1,4 @@\n+x",
  }]);

  // status is "diverged" rather than "ahead".
  const { gh: divergedGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("diverged", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": sameFiles,
    "repos/o/r/compare/main...head": sameFiles,
  });
  assertEquals(
    await ownDiffUnchanged(divergedGh, "o/r", "main", "X", "head"),
    false,
  );

  // A modified file with no patch (a changed binary) cannot be confirmed
  // unchanged. Both sides carry the same blob sha, which GitHub always
  // sends, so this stays false only because sameAddedBlob requires
  // status "added" — a modified binary is not an added blob.
  const { gh: noPatchGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.bin",
      status: "modified",
      sha: "762368ae",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.bin",
      status: "modified",
      sha: "762368ae",
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(noPatchGh, "o/r", "main", "X", "head"),
    false,
  );

  // GitHub's compare API lists at most 300 files. Identical first-300
  // lists cannot prove a later file is unchanged.
  const threeHundred = Array.from({ length: 300 }, (_, i) => ({
    filename: `f${String(i).padStart(3, "0")}.ts`,
    patch: "@@ -1,3 +1,4 @@\n+x",
  }));
  const { gh: cappedGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles(threeHundred),
    "repos/o/r/compare/main...head": compareFiles(threeHundred),
  });
  assertEquals(
    await ownDiffUnchanged(cappedGh, "o/r", "main", "X", "head"),
    false,
  );

  // Same filename and patch, but the rename source differs.
  const { gh: renamedGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
      previous_filename: "old.ts",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
      previous_filename: "other.ts",
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(renamedGh, "o/r", "main", "X", "head"),
    false,
  );

  // Same filename and normalised patch, but the change kind differs.
  const { gh: statusGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      status: "added",
      patch: "@@ -0,0 +1 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      status: "modified",
      patch: "@@ -0,0 +1 @@\n+x",
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(statusGh, "o/r", "main", "X", "head"),
    false,
  );

  // total_commits exceeds the listed commits (truncated at 250).
  const { gh: truncatedGh } = fakeGh({
    "repos/o/r/compare/X...head": JSON.stringify({
      status: "ahead",
      total_commits: 300,
      commits: [{ sha: "m1", parents: [{ sha: "p0" }, { sha: "p1" }] }],
    }),
    "repos/o/r/compare/main...X": sameFiles,
    "repos/o/r/compare/main...head": sameFiles,
  });
  assertEquals(
    await ownDiffUnchanged(truncatedGh, "o/r", "main", "X", "head"),
    false,
  );

  // The merge-base diff adds a file (e.g. a test the earlier review asked
  // for) that the pre-send-back diff never had: the file-count guard is what
  // catches this, since the shared file's patch alone is identical.
  const { gh: newFileGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "fix1",
      parents: 1,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: "@@ -1,3 +1,4 @@\n+x",
    }, {
      filename: "z_test.ts",
      status: "added",
      patch: "@@ -0,0 +1,3 @@\n+test",
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(newFileGh, "o/r", "main", "X", "head"),
    false,
  );

  // An added file with no patch and a null sha cannot be confirmed as the
  // same blob. `null === null` would pass if sameAddedBlob did not require
  // a non-empty string sha (Issue #3079).
  const { gh: nullShaGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "docs/evidence/shot.png",
      status: "added",
      sha: null,
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "docs/evidence/shot.png",
      status: "added",
      sha: null,
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(nullShaGh, "o/r", "main", "X", "head"),
    false,
  );

  // "ahead" with an empty commit list is not a confirmed merge-only move.
  // Identical file lists would return true if the zero-commit guard were
  // removed (Issue #3079).
  const { gh: emptyCommitsGh } = fakeGh({
    "repos/o/r/compare/X...head": JSON.stringify({
      status: "ahead",
      total_commits: 0,
      commits: [],
    }),
    "repos/o/r/compare/main...X": sameFiles,
    "repos/o/r/compare/main...head": sameFiles,
  });
  assertEquals(
    await ownDiffUnchanged(emptyCommitsGh, "o/r", "main", "X", "head"),
    false,
  );

  // A rename of an added file (foo_tst.ts → foo_test.ts) changes the diff.
  // Both sides have one added file, the same patch and no previous_filename,
  // so this stays false only because the filename clause fires (Issue #3079).
  const renamedPatch = "@@ -0,0 +1 @@\n+t";
  const { gh: filenameGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "fix1",
      parents: 1,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "foo_tst.ts",
      status: "added",
      patch: renamedPatch,
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "foo_test.ts",
      status: "added",
      patch: renamedPatch,
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(filenameGh, "o/r", "main", "X", "head"),
    false,
  );

  // A patch-less file that is added on only one side is not the same blob.
  // Each case stays false only because its own `status === "added"` clause
  // in sameAddedBlob fires (Issue #3079).
  const sameSha = "762368ae";
  const { gh: addedThenModifiedGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "fix1",
      parents: 1,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.png",
      status: "added",
      sha: sameSha,
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.png",
      status: "modified",
      sha: sameSha,
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(addedThenModifiedGh, "o/r", "main", "X", "head"),
    false,
  );

  const { gh: modifiedThenAddedGh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "fix1",
      parents: 1,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.png",
      status: "modified",
      sha: sameSha,
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.png",
      status: "added",
      sha: sameSha,
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(modifiedThenAddedGh, "o/r", "main", "X", "head"),
    false,
  );
});

Deno.test("skipReason: an added binary with the same blob sha is awaiting-fix (Issue #3063)", async () => {
  const png = {
    filename: "docs/evidence/shot.png",
    status: "added",
    sha: "762368ae",
  };
  const { gh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([png]),
    "repos/o/r/compare/main...head": compareFiles([png]),
  });
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  assertEquals(
    await skipReason(
      pr,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
    ),
    "awaiting-fix",
  );
});

Deno.test("skipReason: an added binary whose blob sha changed is a fresh review (Issue #3063)", async () => {
  const { gh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "m1",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "docs/evidence/shot.png",
      status: "added",
      sha: "762368ae",
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "docs/evidence/shot.png",
      status: "added",
      sha: "deadbeef",
    }]),
  });
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  assertEquals(
    await skipReason(
      pr,
      "nleck",
      (since) => ownDiffUnchanged(gh, "o/r", "main", since, "head"),
    ),
    null,
  );
});

// One CHANGELOG.md hunk: `before` and `after` are unchanged context lines (each
// gets its leading space), `changed` the -/+ lines between them.
const changelogHunk = (
  header: string,
  before: string[],
  changed: string[],
  after: string[] = ["", "## 1.0.0"],
) =>
  [
    header,
    ...before.map((line) => ` ${line}`),
    ...changed,
    ...after.map((line) => ` ${line}`),
  ].join("\n");

// Issue #4476: the PR adds one entry. A base merge moves its header and adds
// an upstream entry above it, so the context differs between the since and
// head compares while the PR's own change does not.
const OWN_ENTRY = "+- fix the widget";
const SINCE_BEFORE = ["## Unreleased", "", "- older entry"];
const MOVED_BEFORE = [...SINCE_BEFORE, "- upstream entry"];
const sinceEntry = changelogHunk("@@ -10,5 +10,6 @@", SINCE_BEFORE, [
  OWN_ENTRY,
]);
const headEntry = changelogHunk("@@ -12,6 +12,7 @@", MOVED_BEFORE, [OWN_ENTRY]);

// CHANGELOG.md is the probed file. a.ts is unrelated, with identical patches on
// both sides, so only the CHANGELOG.md patches decide the result.
const ownDiffGh = (sincePatch: string, headPatch: string) =>
  fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "merge",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([
      { filename: "CHANGELOG.md", patch: sincePatch },
      { filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+unfixed" },
    ]),
    "repos/o/r/compare/main...head": compareFiles([
      { filename: "CHANGELOG.md", patch: headPatch },
      { filename: "a.ts", patch: "@@ -1 +1 @@\n-old\n+unfixed" },
    ]),
  }).gh;

const sameOwnDiff = (sincePatch: string, headPatch: string) =>
  ownDiffUnchanged(
    ownDiffGh(sincePatch, headPatch),
    "o/r",
    "main",
    "X",
    "head",
    [{ file: "a.ts" }],
  );

Deno.test("skipReason: context a base merge moved under the PR's own entry is awaiting-fix (Issue #4476)", async () => {
  const gh = ownDiffGh(sinceEntry, headEntry);
  assertEquals(
    await skipReason(
      searchPr({
        headRefOid: "head",
        baseRefName: "main",
        reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
      }),
      "nleck",
      (since) =>
        ownDiffUnchanged(gh, "o/r", "main", since, "head", [{ file: "a.ts" }]),
    ),
    "awaiting-fix",
  );
});

Deno.test("ownDiffUnchanged: trailing context alone may change (Issue #4476)", async () => {
  assertEquals(
    await sameOwnDiff(
      sinceEntry,
      changelogHunk("@@ -10,5 +10,6 @@", SINCE_BEFORE, [OWN_ENTRY], [
        "",
        "## 1.1.0",
      ]),
    ),
    true,
  );
});

Deno.test("ownDiffUnchanged: an added line that changed is a fresh review (Issue #4476)", async () => {
  assertEquals(
    await sameOwnDiff(
      sinceEntry,
      changelogHunk("@@ -12,6 +12,7 @@", MOVED_BEFORE, ["+- fix the widgets"]),
    ),
    false,
  );
  // Control: the same head with the added line unchanged.
  assertEquals(await sameOwnDiff(sinceEntry, headEntry), true);
});

Deno.test("ownDiffUnchanged: an extra hunk at head is a fresh review (Issue #4476)", async () => {
  const extraHunk = changelogHunk("@@ -40,2 +40,2 @@", [], [
    "-old tag",
    "+new tag",
  ], []);
  assertEquals(
    await sameOwnDiff(sinceEntry, [headEntry, extraHunk].join("\n")),
    false,
  );
  // Control: the extra hunk is on both sides.
  assertEquals(
    await sameOwnDiff(
      [sinceEntry, extraHunk].join("\n"),
      [headEntry, extraHunk].join("\n"),
    ),
    true,
  );
});

Deno.test("ownDiffUnchanged: a changed removed line is a fresh review (Issue #4476)", async () => {
  const since = changelogHunk("@@ -10,6 +10,6 @@", SINCE_BEFORE, [
    "-- stale entry",
    OWN_ENTRY,
  ]);
  assertEquals(
    await sameOwnDiff(
      since,
      changelogHunk("@@ -12,7 +12,7 @@", MOVED_BEFORE, [
        "-- stale entries",
        OWN_ENTRY,
      ]),
    ),
    false,
  );
  // Control: the removed line is the same on both sides.
  assertEquals(
    await sameOwnDiff(
      since,
      changelogHunk("@@ -12,7 +12,7 @@", MOVED_BEFORE, [
        "-- stale entry",
        OWN_ENTRY,
      ]),
    ),
    true,
  );
});

Deno.test("ownDiffUnchanged: a no-newline marker added after a change is a fresh review (Issue #4476)", async () => {
  const marker = "\\ No newline at end of file";
  assertEquals(
    await sameOwnDiff(
      sinceEntry,
      changelogHunk("@@ -12,4 +12,5 @@", MOVED_BEFORE, [OWN_ENTRY, marker], []),
    ),
    false,
  );
  // Control: the marker is on both sides.
  assertEquals(
    await sameOwnDiff(
      changelogHunk("@@ -10,3 +10,4 @@", SINCE_BEFORE, [OWN_ENTRY, marker], []),
      changelogHunk("@@ -12,4 +12,5 @@", MOVED_BEFORE, [OWN_ENTRY, marker], []),
    ),
    true,
  );
});

Deno.test("ownDiffUnchanged: reordered added lines are a fresh review (Issue #4476)", async () => {
  const since = changelogHunk("@@ -10,5 +10,7 @@", SINCE_BEFORE, [
    OWN_ENTRY,
    "+- second entry",
  ]);
  assertEquals(
    await sameOwnDiff(
      since,
      changelogHunk("@@ -12,6 +12,8 @@", MOVED_BEFORE, [
        "+- second entry",
        OWN_ENTRY,
      ]),
    ),
    false,
  );
  // Control: the same order on both sides.
  assertEquals(
    await sameOwnDiff(
      since,
      changelogHunk("@@ -12,6 +12,8 @@", MOVED_BEFORE, [
        OWN_ENTRY,
        "+- second entry",
      ]),
    ),
    true,
  );
});

// PR #4525 review: a fix that only moves the PR's own added line relative to its
// context (the entry sat under the released heading, the fix puts it above) has
// the same hunk count and the same changed lines on both sides.
const releasedHeading = ["## 1.2.0", "", "- older entry"];
const entryBelowHeading = changelogHunk("@@ -10,4 +10,5 @@", releasedHeading, [
  OWN_ENTRY,
]);
const entryAboveHeading = changelogHunk("@@ -10,4 +10,5 @@", [], [OWN_ENTRY], [
  ...releasedHeading,
]);

const relocatedWith = (findings?: { file: string }[]) =>
  ownDiffUnchanged(
    ownDiffGh(entryBelowHeading, entryAboveHeading),
    "o/r",
    "main",
    "X",
    "head",
    findings,
  );

Deno.test("ownDiffUnchanged: moving the PR's own line in a file an earlier finding names is a fresh review (PR #4525 review)", async () => {
  assertEquals(await relocatedWith([{ file: "CHANGELOG.md" }]), false);
  // The qualified path of the finding counts the same way.
  assertEquals(await relocatedWith([{ file: "docs/CHANGELOG.md" }]), false);
  // Findings that are unknown cannot rule the move out as the fix.
  assertEquals(await relocatedWith(undefined), false);
  // Control: no finding names the file, so only the changed lines are compared.
  assertEquals(await relocatedWith([{ file: "a.ts" }]), true);
});

Deno.test("skipReason: a base merge moving context in a file no finding names stays awaiting-fix, a relocated line in a named file does not (PR #4525 review)", async () => {
  const pr = searchPr({
    headRefOid: "head",
    baseRefName: "main",
    reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
  });
  const skipWith = (since: string, head: string, file: string) =>
    skipReason(
      pr,
      "nleck",
      (sent) =>
        ownDiffUnchanged(ownDiffGh(since, head), "o/r", "main", sent, "head", [
          { file },
        ]),
    );
  assertEquals(
    await skipWith(sinceEntry, headEntry, "a.ts"),
    "awaiting-fix",
  );
  assertEquals(
    await skipWith(entryBelowHeading, entryAboveHeading, "CHANGELOG.md"),
    null,
  );
});

Deno.test("ownDiffUnchanged: 50000-line patches are still judged correctly (Issue #4476)", async () => {
  const bigPatch = (context: string, last: string) => {
    const lines = Array.from(
      { length: 50_000 },
      (_, i) => (i % 2 === 0 ? ` ${context}` : "+added"),
    );
    lines[lines.length - 1] = last;
    return ["@@ -1,25000 +1,50000 @@", ...lines].join("\n");
  };
  assertEquals(
    await sameOwnDiff(
      bigPatch("before", "+added"),
      bigPatch("moved", "+added"),
    ),
    true,
  );
  assertEquals(
    await sameOwnDiff(
      bigPatch("before", "+added"),
      bigPatch("moved", "+changed"),
    ),
    false,
  );
});

// Issue #4542: the sent-back commit changed a.ts and docs.md; a base merge then
// absorbed docs.md, so the head's own diff lists only the files in headFiles.
const dropPatch = "@@ -1 +1 @@\n-old\n+unfixed";
const droppedGh = (
  headFiles: Parameters<typeof compareFiles>[0] = [
    { filename: "a.ts", patch: dropPatch },
  ],
) =>
  fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "merge",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([
      { filename: "docs.md", patch: "@@ -1 +1 @@\n-x\n+y" },
      { filename: "a.ts", patch: dropPatch },
    ]),
    "repos/o/r/compare/main...head": compareFiles(headFiles),
  }).gh;

Deno.test("ownDiffUnchanged: a file a base merge absorbed may drop out when no finding names it (Issue #4542)", async () => {
  const gh = droppedGh();
  assertEquals(
    await ownDiffUnchanged(gh, "o/r", "main", "X", "head", [{ file: "a.ts" }]),
    true,
  );
  assertEquals(
    await skipReason(
      searchPr({
        headRefOid: "head",
        baseRefName: "main",
        reviews: { nodes: [review("CHANGES_REQUESTED", "X")] },
      }),
      "nleck",
      (since) =>
        ownDiffUnchanged(gh, "o/r", "main", since, "head", [{ file: "a.ts" }]),
    ),
    "awaiting-fix",
  );
});

Deno.test("ownDiffUnchanged: a dropped file that a finding names is a fresh review, qualified paths included (Issue #4542)", async () => {
  const gh = droppedGh();
  for (const file of ["docs.md", "pkg/docs.md"]) {
    assertEquals(
      await ownDiffUnchanged(gh, "o/r", "main", "X", "head", [{ file }]),
      false,
      file,
    );
  }
  // Control: only a.ts is named, so the dropped docs.md is allowed to go.
  assertEquals(
    await ownDiffUnchanged(gh, "o/r", "main", "X", "head", [{ file: "a.ts" }]),
    true,
  );
  // The suffix must start at a path boundary, so xdocs.md names nothing here.
  assertEquals(
    await ownDiffUnchanged(gh, "o/r", "main", "X", "head", [{
      file: "xdocs.md",
    }]),
    true,
  );
});

Deno.test("ownDiffUnchanged: a dropped file with unknown or empty findings is a fresh review (Issue #4542)", async () => {
  const gh = droppedGh();
  assertEquals(
    await ownDiffUnchanged(gh, "o/r", "main", "X", "head", undefined),
    false,
  );
  assertEquals(
    await ownDiffUnchanged(gh, "o/r", "main", "X", "head", []),
    false,
  );
});

Deno.test("ownDiffUnchanged: a dropped file named by an earlier finding gap is a fresh review (Issue #4542)", async () => {
  const gap = {
    file: "(earlier review)",
    line: 0,
    problem: "The earlier finding is not verified as fixed",
    earlier: { file: "pkg/docs.md", line: 1, problem: "Restore this file" },
  };
  assertEquals(
    await ownDiffUnchanged(droppedGh(), "o/r", "main", "X", "head", [gap]),
    false,
  );
});

Deno.test("ownDiffUnchanged: a file only the head lists is a fresh review (Issue #4542)", async () => {
  const { gh } = fakeGh({
    "repos/o/r/compare/X...head": compareResponse("ahead", [{
      sha: "merge",
      parents: 2,
    }]),
    "repos/o/r/compare/main...X": compareFiles([{
      filename: "a.ts",
      patch: dropPatch,
    }]),
    "repos/o/r/compare/main...head": compareFiles([{
      filename: "a.ts",
      patch: dropPatch,
    }, {
      filename: "new.ts",
      status: "added",
      patch: "@@ -0,0 +1 @@\n+new",
    }]),
  });
  assertEquals(
    await ownDiffUnchanged(gh, "o/r", "main", "X", "head", [{ file: "a.ts" }]),
    false,
  );
});

Deno.test("ownDiffUnchanged: a dropped file beside a real change to a remaining file is a fresh review (Issue #4542)", async () => {
  const gh = droppedGh([{
    filename: "a.ts",
    patch: "@@ -1 +1,2 @@\n-old\n+unfixed\n+added",
  }]);
  assertEquals(
    await ownDiffUnchanged(gh, "o/r", "main", "X", "head", [{
      file: "other.ts",
    }]),
    false,
  );
});

// A 300-file head listing may be truncated. Its files beyond the sent-back
// listing are head-only, which is what refuses it, not a length cap.
Deno.test("ownDiffUnchanged: a 300-file head listing is refused as head-only files (Issue #4542)", async () => {
  const headFiles = [
    { filename: "a.ts", patch: dropPatch },
    ...Array.from({ length: 299 }, (_, i) => ({
      filename: `f${String(i).padStart(3, "0")}.ts`,
      patch: "@@ -1 +1 @@\n-x\n+y",
    })),
  ];
  assertEquals(
    await ownDiffUnchanged(droppedGh(headFiles), "o/r", "main", "X", "head", [{
      file: "other.ts",
    }]),
    false,
  );
});

Deno.test("ownDiffUnchanged: a repeated filename in either listing is a fresh review, since it cannot be paired by name (Issue #4542)", async () => {
  const finding = [{ file: "other.ts" }];
  const cases: [
    string,
    Parameters<typeof compareFiles>[0],
    Parameters<typeof compareFiles>[0],
  ][] = [
    [
      "sent-back listing repeats a.ts",
      [
        { filename: "a.ts", patch: dropPatch },
        { filename: "a.ts", patch: dropPatch },
      ],
      [{ filename: "a.ts", patch: dropPatch }],
    ],
    [
      "head listing repeats a.ts",
      [{ filename: "a.ts", patch: dropPatch }],
      [
        { filename: "a.ts", patch: dropPatch },
        { filename: "a.ts", patch: dropPatch },
      ],
    ],
  ];
  for (const [name, since, head] of cases) {
    const { gh } = fakeGh({
      "repos/o/r/compare/X...head": compareResponse("ahead", [{
        sha: "merge",
        parents: 2,
      }]),
      "repos/o/r/compare/main...X": compareFiles(since),
      "repos/o/r/compare/main...head": compareFiles(head),
    });
    assertEquals(
      await ownDiffUnchanged(gh, "o/r", "main", "X", "head", finding),
      false,
      name,
    );
  }
});

Deno.test("runWithTimeout kills a command that hangs, so one stuck gh call cannot wedge the watch loop", async () => {
  const started = Date.now();
  await assertRejects(
    () => runWithTimeout("sleep", ["30"], 200),
    Error,
    "timed out after 200 ms",
  );
  assertEquals(Date.now() - started < 5000, true);
  assertEquals(await runWithTimeout("echo", ["ok"], 5000), "ok\n");
});

Deno.test("old reviewer-owned test hold is reconsidered once under the new policy", async () => {
  const old = {
    state: "COMMENTED",
    author: { login: "reviewer[bot]" },
    commit: { oid: "head" },
    body:
      `Held for owner review: this PR changes existing tests.\n\n${REVIEW_MARKER}`,
  };
  const pr = searchPr({ reviews: { nodes: [old] } });
  const check = (value: SearchPr, policy: string) =>
    skipReason(value, "nleck", undefined, undefined, policy);
  assertEquals(await check(pr, "2026-11-02"), null);
  assertEquals(await check(pr, "legacy"), "already-reviewed");
  assertEquals(
    await check(
      searchPr({
        reviews: {
          nodes: [{
            ...old,
            body: `${old.body}\nTest review policy: 2026-11-02`,
          }],
        },
      }),
      "2026-11-02",
    ),
    "already-reviewed",
  );
  assertEquals(
    await check(
      searchPr({
        reviews: {
          nodes: [{
            ...old,
            body: `Held for security review.\n${REVIEW_MARKER}`,
          }],
        },
      }),
      "2026-11-02",
    ),
    "already-reviewed",
  );
  assertEquals(
    await check(
      searchPr({
        reviews: {
          nodes: [old, {
            ...old,
            state: "APPROVED",
            body: "Human approval",
            author: { login: "owner" },
          }],
        },
      }),
      "2026-11-02",
    ),
    "approved",
  );
});
