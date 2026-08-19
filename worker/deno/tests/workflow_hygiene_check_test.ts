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

import { assertEquals, assertExists } from "@std/assert";
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
