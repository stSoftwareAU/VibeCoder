/**
 * Unit tests for the pre-PR changed-workflow file-check gate (Issue #1859).
 *
 * The gate runs `WORKFLOW_FILE_CHECKS` over the `.github/workflows/` files a
 * run added or changed, so these tests drive `evaluateChangedWorkflowGate`
 * with an injected diff/file reader and assert on the verdict it returns —
 * never on how the checks are called.
 *
 * `CLEAN` is a workflow that passes all eleven checks; each seeded fixture
 * mutates exactly one thing so the finding it produces is attributable to one
 * check family.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildChangedWorkflowGateMessage,
  type ChangedWorkflowGateDeps,
  evaluateChangedWorkflowGate,
} from "../lib/changed_workflow_gate.ts";
import { WORKFLOW_FILE_CHECKS } from "../lib/workflow_file_checks.ts";

const CI_PATH = ".github/workflows/ci.yml";
const GITLEAKS_PATH = ".github/workflows/gitleaks.yml";

/** A workflow that passes every check in the table. */
const CLEAN = `name: Unit Tests

on:
  pull_request:
    branches: [main, milestone/*]

permissions:
  contents: read

jobs:
  test:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
      - name: Run tests
        run: |
          set -euo pipefail
          deno test --allow-none
          echo done
`;

/** Replace `find` in `CLEAN`, asserting the seed actually applied. */
function seed(find: string, replace: string): string {
  assert(CLEAN.includes(find), `fixture drift: CLEAN has no ${find.trim()}`);
  return CLEAN.replace(find, replace);
}

/** The clean workflow with its checkout pinned to a hijackable tag. */
const TAG_PINNED = seed(
  "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
  "actions/checkout@v4",
);

/** A gitleaks workflow that has drifted from the canonical hardened shape. */
const GITLEAKS_DRIFTED = `name: Gitleaks

on:
  pull_request:
    branches: [main, milestone/*]

permissions:
  contents: read

jobs:
  scan:
    runs-on: ubuntu-latest
    timeout-minutes: 10
    permissions:
      contents: read
    steps:
      - name: Checkout
        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2
        with:
          persist-credentials: false
          fetch-depth: 0
      - name: Gitleaks
        uses: gitleaks/gitleaks-action@v2
`;

/** Run the gate over an in-memory file set. */
function runGate(
  files: Record<string, string>,
  opts: { changed?: string[]; deps?: Partial<ChangedWorkflowGateDeps> } = {},
) {
  const reads: string[] = [];
  const result = evaluateChangedWorkflowGate({
    defaultBranch: "main",
    deps: {
      listChangedFiles: () =>
        Promise.resolve(opts.changed ?? Object.keys(files)),
      readFile: (path: string) => {
        reads.push(path);
        const text = files[path];
        if (text === undefined) {
          return Promise.reject(new Error(`ENOENT: ${path}`));
        }
        return Promise.resolve(text);
      },
      ...opts.deps,
    },
  });
  return { result, reads };
}

Deno.test("changed-workflow gate - a clean changed workflow passes", async () => {
  const { result, reads } = runGate({ [CI_PATH]: CLEAN });
  const verdict = await result;

  assertEquals(verdict.ok, true);
  assertEquals(verdict.findings, []);
  assertEquals(verdict.errors, []);
  assertEquals(verdict.scannedFiles, [CI_PATH]);
  assertEquals(reads, [CI_PATH], "the changed file is read exactly once");
});

Deno.test("changed-workflow gate - a run changing no workflow file passes", async () => {
  const { result, reads } = runGate(
    { "worker/deno/lib/foo.ts": "export const a = 1;\n" },
  );
  const verdict = await result;

  assertEquals(verdict.ok, true);
  assertEquals(verdict.scannedFiles, []);
  assertEquals(reads, [], "a non-workflow path is never read");
});

Deno.test("changed-workflow gate - a README under .github/workflows is not a workflow", async () => {
  const { result, reads } = runGate(
    { ".github/workflows/README.md": "# Workflows\n" },
  );
  const verdict = await result;

  assertEquals(verdict.ok, true);
  assertEquals(reads, []);
});

/**
 * One seeded violation per check family. Each entry names the family and the
 * finding-id prefix the family's scanner emits, so a fixture that stops
 * tripping its own check fails here rather than silently passing.
 */
const SEEDED: readonly {
  family: string;
  path: string;
  text: string;
  idPrefix: string;
}[] = [
  {
    family: "action-pins",
    path: CI_PATH,
    text: seed(
      "actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.2.2",
      "actions/checkout@v4",
    ),
    idPrefix: "BP-SHA-PIN-",
  },
  {
    family: "workflow-permissions",
    path: CI_PATH,
    // Both the job-level and workflow-level blocks: either one alone
    // satisfies the check.
    text: seed("    permissions:\n      contents: read\n", "").replace(
      "permissions:\n  contents: read\n\n",
      "",
    ),
    idPrefix: "BP-PERMISSIONS-",
  },
  {
    family: "workflow-triggers",
    path: CI_PATH,
    text: seed(
      "  pull_request:\n    branches: [main, milestone/*]",
      "  push:\n    branches: [main]",
    ),
    idPrefix: "BP-TRIGGER-",
  },
  {
    family: "checkout-persist-credentials",
    path: CI_PATH,
    text: seed("        with:\n          persist-credentials: false\n", ""),
    idPrefix: "BP-PERSIST-CREDS-",
  },
  {
    family: "milestone-branch-filters",
    path: CI_PATH,
    text: seed("branches: [main, milestone/*]", "branches: [main]"),
    idPrefix: "BP-MILESTONE-FILTER-",
  },
  {
    family: "ci-install-pins",
    path: CI_PATH,
    text: seed(
      "          deno test --allow-none",
      "          npm install -g typescript\n          deno test --allow-none",
    ),
    idPrefix: "BP-CI-INSTALL-PIN-",
  },
  {
    family: "run-injection",
    path: CI_PATH,
    text: seed(
      "          echo done",
      '          echo "${{ github.event.pull_request.title }}"',
    ),
    idPrefix: "BP-INJECTION-",
  },
  {
    family: "artifact-uploads",
    path: CI_PATH,
    text: seed(
      "      - name: Run tests",
      "      - name: Upload\n" +
        "        uses: actions/upload-artifact@50769540e7f4bd5e21e526ee35c689e35e0d6874 # v4.4.3\n" +
        "        with:\n          path: .\n" +
        "      - name: Run tests",
    ),
    idPrefix: "BP-ARTIFACT-UPLOAD-",
  },
  {
    family: "gitleaks-drift",
    path: GITLEAKS_PATH,
    text: GITLEAKS_DRIFTED,
    idPrefix: "BP-GITLEAKS-",
  },
  {
    family: "strict-mode",
    path: CI_PATH,
    text: seed("          set -euo pipefail\n", ""),
    idPrefix: "missing-strict-mode",
  },
  {
    family: "version-comment-drift",
    path: CI_PATH,
    text: seed(
      "      - name: Run tests",
      "      - name: Checkout again\n" +
        "        uses: actions/checkout@11bd71901bbe5b1630ceea73d27597364c9af683 # v4.1.0\n" +
        "        with:\n          persist-credentials: false\n" +
        "      - name: Run tests",
    ),
    idPrefix: "version-comment-drift",
  },
];

Deno.test("changed-workflow gate - the seeded set covers every check family", () => {
  const covered = new Set(SEEDED.map((s) => s.family));
  const uncovered = WORKFLOW_FILE_CHECKS.map((c) => c.id).filter((id) =>
    !covered.has(id)
  );
  assertEquals(
    uncovered,
    [],
    "a check family with no seeded fixture is a family this gate is untested on",
  );
});

for (const entry of SEEDED) {
  Deno.test(
    `changed-workflow gate - a changed file seeded with a ${entry.family} finding blocks`,
    async () => {
      const { result } = runGate({ [entry.path]: entry.text });
      const verdict = await result;

      assertEquals(verdict.ok, false, "the gate must block");
      assertEquals(verdict.errors, [], "a seeded finding is not a read fault");
      assert(
        verdict.findings.some((f) => f.id.startsWith(entry.idPrefix)),
        `expected a ${entry.family} finding, got: ${
          verdict.findings.map((f) => f.id).join(", ") || "none"
        }`,
      );
      for (const finding of verdict.findings) {
        assertEquals(finding.file, entry.path);
        assert(finding.line >= 1, "every finding anchors to a line");
        assert(finding.detail.length > 0, "every finding carries a detail");
      }

      const message = buildChangedWorkflowGateMessage(verdict);
      const first = verdict.findings[0]!;
      assertStringIncludes(message, `[${first.id}]`);
      assertStringIncludes(message, `${first.file}:${first.line}`);
      assertStringIncludes(message, first.detail);
    },
  );
}

Deno.test("changed-workflow gate - a nested file under .github/workflows is out of scope", async () => {
  // GitHub runs nothing nested there and the audit's reader is non-recursive,
  // so a template fixture must not block a PR.
  const path = ".github/workflows/templates/ci.yml";
  const { result, reads } = runGate({ [path]: TAG_PINNED });
  const verdict = await result;

  assertEquals(verdict.ok, true);
  assertEquals(reads, [], "a nested path is never read");
});

Deno.test("changed-workflow gate - a traversing path is refused, not read", async () => {
  const path = ".github/workflows/../../etc/passwd.yml";
  const { result, reads } = runGate({ [path]: "irrelevant" });
  const verdict = await result;

  assertEquals(verdict.ok, true);
  assertEquals(reads, [], "a `..` segment never reaches the filesystem");
});

Deno.test("changed-workflow gate - a long finding list is truncated, and says so", async () => {
  // 25 tag-pinned steps — more than the message names in full.
  const steps = Array.from(
    { length: 25 },
    (_, i) =>
      `      - name: Step ${i}\n        uses: actions/checkout@v${i + 1}\n`,
  )
    .join("");
  const many = seed(
    "      - name: Checkout\n",
    steps + "      - name: Checkout\n",
  );

  const { result } = runGate({ [CI_PATH]: many });
  const verdict = await result;

  assertEquals(verdict.ok, false);
  assert(verdict.findings.length > 20, "the fixture must overflow the cap");
  const message = buildChangedWorkflowGateMessage(verdict);
  assertStringIncludes(message, `…and ${verdict.findings.length - 20} more`);
});

Deno.test("changed-workflow gate - an offending file the run did not touch is ignored", async () => {
  const { result, reads } = runGate(
    {
      [CI_PATH]: CLEAN,
      [GITLEAKS_PATH]: GITLEAKS_DRIFTED,
    },
    { changed: [CI_PATH] },
  );
  const verdict = await result;

  assertEquals(verdict.ok, true, "a pre-existing offender must not block");
  assertEquals(verdict.findings, []);
  assertEquals(verdict.scannedFiles, [CI_PATH]);
  assertEquals(reads, [CI_PATH], "an untouched file is never read");
});

Deno.test("changed-workflow gate - a failed diff collection fails loud", async () => {
  const { result } = runGate({}, {
    deps: {
      listChangedFiles: () =>
        Promise.reject(new Error("fatal: bad revision 'main...HEAD'")),
    },
  });
  const verdict = await result;

  assertEquals(verdict.ok, false, "an unknown diff is never a pass");
  assertEquals(verdict.findings, []);
  assertEquals(verdict.errors.length, 1);
  assertStringIncludes(verdict.errors[0]!, "could not collect the branch diff");
  assertStringIncludes(verdict.errors[0]!, "bad revision");

  const message = buildChangedWorkflowGateMessage(verdict);
  assertStringIncludes(message, "could not decide");
  assertStringIncludes(message, "bad revision");
});

Deno.test("changed-workflow gate - an unreadable changed file fails loud", async () => {
  const { result } = runGate({}, { changed: [CI_PATH] });
  const verdict = await result;

  assertEquals(
    verdict.ok,
    false,
    "zero findings from zero reads is not a pass",
  );
  assertEquals(verdict.findings, []);
  assertEquals(verdict.errors.length, 1);
  assertStringIncludes(verdict.errors[0]!, `could not read ${CI_PATH}`);
});

Deno.test("changed-workflow gate - an unparseable changed file fails loud", async () => {
  const { result } = runGate({ [CI_PATH]: "on: [push\n  bad: : yaml\n" });
  const verdict = await result;

  assertEquals(verdict.ok, false);
  assert(
    verdict.errors.some((e) => e.includes(`could not parse ${CI_PATH}`)),
    `expected a parse error, got: ${verdict.errors.join(", ") || "none"}`,
  );
});

Deno.test("changed-workflow gate - one bad file does not hide the others", async () => {
  const { result } = runGate({
    [CI_PATH]: CLEAN,
    [GITLEAKS_PATH]: GITLEAKS_DRIFTED,
    ".github/workflows/missing.yml": undefined as unknown as string,
  }, {
    changed: [CI_PATH, GITLEAKS_PATH, ".github/workflows/missing.yml"],
  });
  const verdict = await result;

  assertEquals(verdict.ok, false);
  assert(verdict.findings.length > 0, "the readable files were still checked");
  assertEquals(verdict.errors.length, 1, "the unreadable one is reported too");
  assertEquals(verdict.scannedFiles, [CI_PATH, GITLEAKS_PATH]);
});
