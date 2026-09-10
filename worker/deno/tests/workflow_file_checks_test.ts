/**
 * Tests for the file-scoped audit check table (Issue #1822).
 *
 * `worker/deno/tests/workflow_template_audit_conformance_test.ts` runs the
 * table over the provisioned templates and asserts **zero** findings — a
 * green result there proves the templates are clean, but it proves nothing
 * about the table: an entry wired to the wrong scanner, or one that
 * returned `[]` unconditionally, would keep that gate green while silently
 * covering nothing.
 *
 * These tests close that hole from the other side. Each entry gets a
 * workflow that violates the rule it names, and the entry must report it;
 * the same fixtures must leave a clean workflow alone. A fixture is
 * required for every id in the table, so a new check cannot arrive without
 * one.
 *
 * Australian English throughout (behaviour, organisation, authorised).
 */

import { assert, assertEquals } from "@std/assert";
import { parse as parseYaml } from "@std/yaml/parse";
import { WORKFLOW_FILE_CHECKS } from "../lib/workflow_file_checks.ts";
import type { WorkflowFile } from "../lib/workflow_scan_common.ts";

const SHA_A = "3d3c42e5aac5ba805825da76410c181273ba90b1";

/** Build the {@link WorkflowFile} a pre-filer consumes from literal YAML. */
function workflowFile(path: string, rawText: string): WorkflowFile {
  return {
    path: `.github/workflows/${path}`,
    rawText,
    parsed: parseYaml(rawText),
    kind: "workflow",
  };
}

/**
 * A workflow that satisfies every rule in the table: SHA-pinned with a
 * trailing version comment, least-privilege permissions, `pull_request`
 * only and milestone-aware, no persisted credentials, no unpinned install,
 * no interpolation into the shell, strict mode on its one multi-line
 * `run:`.
 */
const CLEAN = `name: Test
on:
  pull_request:
    branches: [Develop, main, milestone/*]
permissions:
  contents: read
concurrency:
  group: test-\${{ github.ref }}
  cancel-in-progress: true
jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    steps:
      - uses: actions/checkout@${SHA_A} # v7.0.1
        with:
          persist-credentials: false
      - name: Run the suite
        run: |
          set -euo pipefail
          echo running
          npm test
`;

/**
 * One workflow per check that breaks exactly the rule the check names.
 *
 * A fixture may trip other checks too — a workflow with no `permissions:`
 * also has an unpinned action, say. The assertion is only ever "this check
 * reports this fixture", never "no other check does", so the fixtures stay
 * readable.
 */
const VIOLATIONS: Readonly<Record<string, WorkflowFile[]>> = {
  "action-pins": [workflowFile(
    "pins.yml",
    `name: Test
on:
  pull_request:
    branches: [Develop, main, milestone/*]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: third-party/some-action@v4
`,
  )],
  "workflow-permissions": [workflowFile(
    "perms.yml",
    `name: Test
on:
  pull_request:
    branches: [Develop, main, milestone/*]
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
  )],
  "workflow-triggers": [workflowFile(
    "ci.yml",
    `name: Test
on:
  push:
    branches: [main]
  pull_request:
    branches: [Develop, main, milestone/*]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
  )],
  "checkout-persist-credentials": [workflowFile(
    "checkout.yml",
    `name: Test
on:
  pull_request:
    branches: [Develop, main, milestone/*]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@${SHA_A} # v7.0.1
      - run: npm test
`,
  )],
  "milestone-branch-filters": [workflowFile(
    "ci.yml",
    `name: Test
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm test
`,
  )],
  "ci-install-pins": [workflowFile(
    "install.yml",
    `name: Test
on:
  pull_request:
    branches: [Develop, main, milestone/*]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: npm install -g markdownlint-cli2
`,
  )],
  "run-injection": [workflowFile(
    "injection.yml",
    `name: Test
on:
  pull_request:
    branches: [Develop, main, milestone/*]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: echo "\${{ github.event.pull_request.title }}"
`,
  )],
  "artifact-uploads": [workflowFile(
    "artifact.yml",
    `name: Test
on:
  pull_request:
    branches: [Develop, main, milestone/*]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/upload-artifact@${SHA_A} # v7.0.1
        with:
          path: .
`,
  )],
  "gitleaks-drift": [workflowFile(
    "gitleaks.yml",
    `name: Gitleaks
on:
  pull_request:
    branches: [main]
permissions:
  contents: read
jobs:
  scan:
    runs-on: ubuntu-latest
    steps:
      - uses: gitleaks/gitleaks-action@v2
`,
  )],
  "strict-mode": [workflowFile(
    "strict.yml",
    `name: Test
on:
  pull_request:
    branches: [Develop, main, milestone/*]
permissions:
  contents: read
jobs:
  test:
    runs-on: ubuntu-latest
    steps:
      - run: |
          echo first
          npm test
`,
  )],
  // Drift is cross-file by nature: one SHA, two disagreeing annotations.
  "version-comment-drift": [
    workflowFile(
      "one.yml",
      `jobs:
  a:
    steps:
      - uses: actions/checkout@${SHA_A} # v7.0.1
`,
    ),
    workflowFile(
      "two.yml",
      `jobs:
  b:
    steps:
      - uses: actions/checkout@${SHA_A} # v6.0.0
`,
    ),
  ],
};

const CTX = { defaultBranch: "main" };

Deno.test(
  "workflow file checks - every check has a violating fixture",
  () => {
    // A new entry in the table with no fixture would otherwise be asserted
    // only against clean input, which proves nothing about its wiring.
    assertEquals(
      WORKFLOW_FILE_CHECKS.map((c) => c.id).filter((id) =>
        VIOLATIONS[id] === undefined
      ),
      [],
      "add a workflow that breaks the new check to VIOLATIONS",
    );
  },
);

for (const check of WORKFLOW_FILE_CHECKS) {
  Deno.test(
    `workflow file checks - ${check.id} reports a workflow that breaks it`,
    () => {
      const files = VIOLATIONS[check.id];
      assert(files !== undefined, `no fixture for ${check.id}`);
      const findings = check.run(files, CTX);
      assert(
        findings.length > 0,
        `${check.id} ("${check.label}") reported nothing against a workflow ` +
          "that breaks it — the entry is not wired to a live scanner",
      );
      for (const finding of findings) {
        assert(finding.id.length > 0, `${check.id}: finding has no id`);
        assert(
          finding.file.startsWith(".github/workflows/"),
          `${check.id}: finding does not name the offending file`,
        );
        assert(finding.line > 0, `${check.id}: finding has no line`);
        assert(finding.detail.length > 0, `${check.id}: finding has no detail`);
      }
    },
  );

  Deno.test(
    `workflow file checks - ${check.id} passes a clean workflow`,
    () => {
      const findings = check.run([workflowFile("clean.yml", CLEAN)], CTX);
      assertEquals(
        findings.length,
        0,
        `${check.id} ("${check.label}") flagged a compliant workflow: ` +
          findings.map((f) => `${f.id} (${f.file}:${f.line})`).join("; "),
      );
    },
  );
}

Deno.test(
  "workflow file checks - the trigger check honours the default branch",
  () => {
    // `defaultBranch` is the one piece of repository context the table
    // takes, so a `push:` to some other branch must stay silent.
    const files = VIOLATIONS["workflow-triggers"];
    assert(files !== undefined);
    const check = WORKFLOW_FILE_CHECKS.find((c) =>
      c.id === "workflow-triggers"
    );
    assert(check !== undefined);
    assert(check.run(files, { defaultBranch: "main" }).length > 0);
    assertEquals(check.run(files, { defaultBranch: "Develop" }).length, 0);
  },
);
