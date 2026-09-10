/**
 * Tests for the workflow-hygiene quality gate (Issue #3716).
 *
 * Two invariants: every multi-line `run:` block opens with
 * `set -euo pipefail`, and one pinned SHA carries one version comment.
 * The regression tests at the bottom scan this repo's real workflows —
 * they fail against the unfixed tree (the `dependency-audit.yml`
 * notification block, and `actions/checkout` annotated both v6.0.0 and
 * v6.0.2).
 *
 * Australian English spelling used throughout (behaviour, colour, etc.).
 */

import { assertEquals, assertExists, assertStringIncludes } from "@std/assert";
import {
  collectActionPins,
  findVersionCommentDrift,
  scanWorkflowForStrictMode,
  scanWorkflowsForHygiene,
} from "../lib/workflow_hygiene_check.ts";

const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

Deno.test("scanWorkflowForStrictMode - flags a multi-line run block without strict mode", () => {
  const yaml = `jobs:
  audit:
    steps:
      - name: Notify
        run: |
          deno run --allow-run mod.ts notify \\
            --repo "$REPO"
`;
  const violations = scanWorkflowForStrictMode(yaml, "wf.yml");
  assertEquals(violations.length, 1);
  const [first] = violations;
  assertExists(first);
  assertEquals(first.kind, "missing-strict-mode");
  assertEquals(first.file, "wf.yml");
  assertEquals(first.line, 5);
});

Deno.test("scanWorkflowForStrictMode - accepts a block opening with set -euo pipefail", () => {
  const yaml = `jobs:
  audit:
    steps:
      - name: Notify
        run: |
          set -euo pipefail
          echo hello
          deno task audit
`;
  assertEquals(scanWorkflowForStrictMode(yaml, "wf.yml"), []);
});

Deno.test("scanWorkflowForStrictMode - leading comments do not hide the preamble", () => {
  const yaml = `jobs:
  audit:
    steps:
      - run: |
          # Explain what this step does.
          set -euo pipefail
          echo one
          echo two
`;
  assertEquals(scanWorkflowForStrictMode(yaml, "wf.yml"), []);
});

Deno.test("scanWorkflowForStrictMode - strict mode below the first command still fails", () => {
  const yaml = `jobs:
  audit:
    steps:
      - run: |
          echo first
          set -euo pipefail
          echo two
`;
  assertEquals(
    scanWorkflowForStrictMode(yaml, "wf.yml").map((v) => v.line),
    [4],
  );
});

Deno.test("scanWorkflowForStrictMode - single-command block is exempt", () => {
  const yaml = `jobs:
  audit:
    steps:
      - name: One thing
        run: |
          # only one effective command, nothing can be skipped after it
          deno task audit
`;
  assertEquals(scanWorkflowForStrictMode(yaml, "wf.yml"), []);
});

Deno.test("scanWorkflowForStrictMode - single-line run: is exempt", () => {
  const yaml = `jobs:
  audit:
    steps:
      - run: sudo apt-get update && sudo apt-get install -y shellcheck
`;
  assertEquals(scanWorkflowForStrictMode(yaml, "wf.yml"), []);
});

Deno.test("scanWorkflowForStrictMode - non-POSIX shell is exempt", () => {
  const yaml = `jobs:
  audit:
    steps:
      - name: Python step
        shell: python
        run: |
          import os
          print(os.getcwd())
`;
  assertEquals(scanWorkflowForStrictMode(yaml, "wf.yml"), []);
});

Deno.test("scanWorkflowForStrictMode - explicit bash shell is still checked", () => {
  const yaml = `jobs:
  audit:
    steps:
      - name: Bash step
        shell: bash
        run: |
          echo one
          echo two
`;
  assertEquals(scanWorkflowForStrictMode(yaml, "wf.yml").length, 1);
});

Deno.test("scanWorkflowForStrictMode - a sibling step's shell does not leak in", () => {
  const yaml = `jobs:
  audit:
    steps:
      - name: Python step
        shell: python
        run: |
          import os
          print(os.getcwd())
      - name: Shell step
        run: |
          echo one
          echo two
`;
  assertEquals(
    scanWorkflowForStrictMode(yaml, "wf.yml").map((v) => v.line),
    [10],
  );
});

Deno.test("scanWorkflowForStrictMode - reports every offending block in a file", () => {
  const yaml = `jobs:
  audit:
    steps:
      - run: |
          echo a
          echo b
      - run: |
          set -euo pipefail
          echo c
          echo d
      - run: |
          echo e
          echo f
`;
  const violations = scanWorkflowForStrictMode(yaml, "wf.yml");
  assertEquals(violations.map((v) => v.line), [4, 11]);
});

Deno.test("collectActionPins - reads the version from the leading comment", () => {
  const yaml = `      - name: Checkout code
        # actions/checkout@v6.0.2
        uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
`;
  assertEquals(collectActionPins(yaml, "wf.yml"), [{
    action: "actions/checkout",
    sha: "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    version: "v6.0.2",
    file: "wf.yml",
    line: 3,
  }]);
});

Deno.test("collectActionPins - reads the version from a trailing comment", () => {
  // The form `pinnedAction()` renders into every emitted workflow template
  // (Issue #1822): without it the drift rule passed over templates
  // vacuously, because no template writes a leading pin comment.
  const yaml =
    `      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
`;
  assertEquals(collectActionPins(yaml, "wf.yml"), [{
    action: "actions/checkout",
    sha: "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    version: "v6.0.2",
    file: "wf.yml",
    line: 1,
  }]);
});

Deno.test("collectActionPins - a trailing comment for another action is not borrowed", () => {
  const yaml =
    `      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # actions/setup-node@v6.4.0
`;
  assertEquals(collectActionPins(yaml, "wf.yml"), [{
    action: "actions/checkout",
    sha: "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    file: "wf.yml",
    line: 1,
  }]);
});

Deno.test("collectActionPins - one pin annotated both ways yields both claims", () => {
  const yaml = `      # actions/checkout@v6.0.0
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v7.0.1
`;
  assertEquals(
    collectActionPins(yaml, "wf.yml").map((p) => p.version),
    ["v7.0.1", "v6.0.0"],
  );
});

Deno.test("collectActionPins - two agreeing comments on one pin yield one entry", () => {
  const yaml = `      # actions/checkout@v7.0.1
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v7.0.1
`;
  assertEquals(collectActionPins(yaml, "wf.yml").length, 1);
});

Deno.test("findVersionCommentDrift - the two forms disagreeing on one pin is drift", () => {
  // Neither annotation silently wins: a single `uses:` whose leading and
  // trailing comments claim different versions is exactly the "one SHA,
  // two versions" defect the rule exists to catch.
  const pins = collectActionPins(
    `      # actions/checkout@v6.0.0
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v7.0.1
`,
    "wf.yml",
  );
  const violations = findVersionCommentDrift(pins);
  assertEquals(violations.length, 2);
  assertEquals(violations[0]?.kind, "version-comment-drift");
  assertStringIncludes(violations[0]?.detail ?? "", "v6.0.0, v7.0.1");
});

Deno.test("collectActionPins - a trailing comment need not be a bare version", () => {
  // `pinnedAction()` records branch-HEAD pins as `# master HEAD 2024-06-20`
  // (see PINNED_ACTIONS), so the trailing comment is read verbatim rather
  // than being held to a `vX.Y.Z` shape. The drift rule then compares
  // whatever two annotations of one SHA claim, which is the point: two
  // different claims about one SHA are the defect, whatever their spelling.
  const yaml =
    `      - uses: ludeeus/action-shellcheck@de0fac2e4500dabe0009e67214ff5f5447ce83dd # master HEAD 2024-06-20
`;
  assertEquals(
    collectActionPins(yaml, "wf.yml")[0]?.version,
    "master HEAD 2024-06-20",
  );
});

Deno.test("findVersionCommentDrift - a trailing and a leading comment may disagree", () => {
  const trailing = collectActionPins(
    `      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd # v6.0.2
`,
    "a.yml",
  );
  const leading = collectActionPins(
    `      # actions/checkout@v6.0.0
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
`,
    "b.yml",
  );
  const violations = findVersionCommentDrift([...trailing, ...leading]);
  assertEquals(violations.length, 2);
  assertEquals(
    violations.map((v) => v.file),
    ["a.yml", "b.yml"],
  );
  assertEquals(violations[0]?.kind, "version-comment-drift");
  assertStringIncludes(violations[0]?.detail ?? "", "v6.0.0, v6.0.2");
});

Deno.test("collectActionPins - a comment for a different action is not borrowed", () => {
  const yaml = `      # actions/setup-node@v6.4.0
      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd
`;
  assertEquals(collectActionPins(yaml, "wf.yml"), [{
    action: "actions/checkout",
    sha: "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
    file: "wf.yml",
    line: 2,
  }]);
});

Deno.test("collectActionPins - tag-pinned actions are ignored", () => {
  const yaml = `      - uses: actions/checkout@v6
`;
  assertEquals(collectActionPins(yaml, "wf.yml"), []);
});

Deno.test("findVersionCommentDrift - flags one SHA carrying two version comments", () => {
  const sha = "de0fac2e4500dabe0009e67214ff5f5447ce83dd";
  const drift = findVersionCommentDrift([
    {
      action: "actions/checkout",
      sha,
      version: "v6.0.0",
      file: "a.yml",
      line: 3,
    },
    {
      action: "actions/checkout",
      sha,
      version: "v6.0.2",
      file: "b.yml",
      line: 9,
    },
  ]);
  assertEquals(drift.map((v) => v.kind), [
    "version-comment-drift",
    "version-comment-drift",
  ]);
  assertEquals(drift.map((v) => `${v.file}:${v.line}`), ["a.yml:3", "b.yml:9"]);
});

Deno.test("findVersionCommentDrift - consistent comments produce no violation", () => {
  const sha = "de0fac2e4500dabe0009e67214ff5f5447ce83dd";
  assertEquals(
    findVersionCommentDrift([
      {
        action: "actions/checkout",
        sha,
        version: "v6.0.2",
        file: "a.yml",
        line: 3,
      },
      {
        action: "actions/checkout",
        sha,
        version: "v6.0.2",
        file: "b.yml",
        line: 9,
      },
    ]),
    [],
  );
});

Deno.test("findVersionCommentDrift - distinct SHAs are independent", () => {
  assertEquals(
    findVersionCommentDrift([
      {
        action: "actions/checkout",
        sha: "de0fac2e4500dabe0009e67214ff5f5447ce83dd",
        version: "v6.0.2",
        file: "a.yml",
        line: 3,
      },
      {
        action: "actions/checkout",
        sha: "1af3b93b6815bc44a9784bd300feb67ff0d1eeb3",
        version: "v6.0.0",
        file: "b.yml",
        line: 9,
      },
    ]),
    [],
  );
});

Deno.test("scanWorkflowsForHygiene - missing workflow directory yields no violations", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    const result = await scanWorkflowsForHygiene(tmp);
    assertEquals(result.violations, []);
    assertEquals(result.filesScanned, 0);
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("scanWorkflowsForHygiene - detects drift across two workflow files", async () => {
  const tmp = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tmp}/.github/workflows`, { recursive: true });
    const step = (version: string) =>
      `jobs:\n  j:\n    steps:\n      # actions/checkout@${version}\n      - uses: actions/checkout@de0fac2e4500dabe0009e67214ff5f5447ce83dd\n`;
    await Deno.writeTextFile(`${tmp}/.github/workflows/a.yml`, step("v6.0.0"));
    await Deno.writeTextFile(`${tmp}/.github/workflows/b.yml`, step("v6.0.2"));

    const result = await scanWorkflowsForHygiene(tmp);
    assertEquals(result.filesScanned, 2);
    assertEquals(result.violations.length, 2);
    assertEquals(
      new Set(result.violations.map((v) => v.kind)),
      new Set(["version-comment-drift"]),
    );
  } finally {
    await Deno.remove(tmp, { recursive: true });
  }
});

Deno.test("regression (Issue #3716) - this repo's workflows are hygienic", async () => {
  const result = await scanWorkflowsForHygiene(REPO_ROOT);
  assertEquals(
    result.violations.map((v) => `${v.file}:${v.line}: ${v.detail}`),
    [],
  );
});
