/**
 * Tests for workflow_scan_common.ts — shared scaffolding for native
 * github-actions-audit pre-filers (Issue #2500, part of #2497).
 *
 * Every test exercises real functions with fixtures and an injected gh
 * stub — no network, no real gh CLI.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  _resetSuppressionCommitAuthors as _clearSuppressionCommitAuthors,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
  setSuppressionCommitAuthors as _setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import {
  type BlameFileFn,
  fileWorkflowFinding,
  type GhCommandFn,
  isFindingSuppressed,
  makeStableId,
  readWorkflowFiles,
  selectLiveSteps,
  type SelectLiveStepsOptions,
  type WorkflowFile,
} from "../lib/workflow_scan_common.ts";

// ---------------------------------------------------------------------------
// Fixture helpers
// ---------------------------------------------------------------------------

const CI_YML = `name: CI
on: [push]
jobs:
  build:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

const RELEASE_YAML = `name: Release
on:
  release:
    types: [published]
jobs:
  publish:
    runs-on: ubuntu-latest
    steps:
      - uses: actions/checkout@v4
`;

const COMPOSITE_ACTION = `name: Setup
runs:
  using: composite
  steps:
    - run: echo hi
      shell: bash
`;

async function makeRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "wf-scan-common-" });
  await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
  await Deno.writeTextFile(`${dir}/.github/workflows/ci.yml`, CI_YML);
  await Deno.writeTextFile(
    `${dir}/.github/workflows/release.yaml`,
    RELEASE_YAML,
  );
  await Deno.mkdir(`${dir}/.github/actions/setup`, { recursive: true });
  await Deno.writeTextFile(
    `${dir}/.github/actions/setup/action.yml`,
    COMPOSITE_ACTION,
  );
  return dir;
}

// ---------------------------------------------------------------------------
// readWorkflowFiles
// ---------------------------------------------------------------------------

Deno.test("readWorkflowFiles - returns workflows and composite actions parsed", async () => {
  const dir = await makeRepo();
  try {
    const files = await readWorkflowFiles(dir);
    const paths = files.map((f) => f.path);
    assertEquals(paths, [
      ".github/actions/setup/action.yml",
      ".github/workflows/ci.yml",
      ".github/workflows/release.yaml",
    ]);

    const ci = files.find((f) => f.path.endsWith("ci.yml")) as WorkflowFile;
    assertEquals(ci.kind, "workflow");
    assertEquals(ci.rawText, CI_YML);
    const parsed = ci.parsed as Record<string, unknown>;
    assertEquals(parsed.name, "CI");

    const action = files.find((f) =>
      f.path.endsWith("action.yml")
    ) as WorkflowFile;
    assertEquals(action.kind, "composite-action");
    const actionParsed = action.parsed as Record<string, unknown>;
    assertEquals(actionParsed.name, "Setup");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readWorkflowFiles - repo with no .github/workflows returns empty without throwing", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wf-scan-empty-" });
  try {
    const files = await readWorkflowFiles(dir);
    assertEquals(files, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readWorkflowFiles - finds nested composite actions recursively", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wf-scan-nested-" });
  try {
    await Deno.mkdir(`${dir}/.github/actions/group/inner`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/actions/group/inner/action.yaml`,
      COMPOSITE_ACTION,
    );
    const files = await readWorkflowFiles(dir);
    assertEquals(files.length, 1);
    assertEquals(files[0]?.path, ".github/actions/group/inner/action.yaml");
    assertEquals(files[0]?.kind, "composite-action");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("readWorkflowFiles - unparseable YAML yields null parsed but keeps raw text", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wf-scan-bad-" });
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    const bad = "name: [unterminated\n  : : :\n";
    await Deno.writeTextFile(`${dir}/.github/workflows/bad.yml`, bad);
    const files = await readWorkflowFiles(dir);
    assertEquals(files.length, 1);
    assertEquals(files[0]?.parsed, null);
    assertEquals(files[0]?.rawText, bad);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// ---------------------------------------------------------------------------
// makeStableId
// ---------------------------------------------------------------------------

Deno.test("makeStableId - produces a BP-prefixed 12-hex id", async () => {
  const id = await makeStableId(["github-actions-audit", "ci.yml", "sha-pin"]);
  assert(id.startsWith("BP-"), `expected BP- prefix, got ${id}`);
  assertEquals(id.length, "BP-".length + 12);
  assert(/^BP-[0-9a-f]{12}$/.test(id), `unexpected id shape: ${id}`);
});

Deno.test("makeStableId - is deterministic and discriminator-sensitive", async () => {
  const a = await makeStableId(["github-actions-audit", "ci.yml", "x"]);
  const aAgain = await makeStableId(["github-actions-audit", "ci.yml", "x"]);
  const b = await makeStableId(["other-scan", "ci.yml", "x"]);
  assertEquals(a, aAgain);
  assert(a !== b, "different discriminator must yield a different id");
});

// ---------------------------------------------------------------------------
// isFindingSuppressed
// ---------------------------------------------------------------------------

Deno.test("isFindingSuppressed - true for a matching best-practice-ignore marker above the line", async () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const id = await makeStableId([
      "github-actions-audit",
      "ci.yml",
      "sha-pin",
    ]);
    const text = [
      "      # best-practice-ignore: " + id +
      " — author=nigel expires=2099-12-31 pinned upstream by mirror",
      "      - uses: actions/checkout@v4",
    ].join("\n");
    assert(isFindingSuppressed({ rawText: text }, 2, id));
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("isFindingSuppressed - true on the same line", async () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const id = await makeStableId([
      "github-actions-audit",
      "ci.yml",
      "sha-pin",
    ]);
    const text =
      `      - uses: actions/checkout@v4 # best-practice-ignore: ${id} — author=nigel expires=2099-12-31 ok`;
    assert(isFindingSuppressed({ rawText: text }, 1, id));
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("isFindingSuppressed - false when no marker, wrong id, or wrong line", async () => {
  const id = await makeStableId(["github-actions-audit", "ci.yml", "sha-pin"]);
  const other = await makeStableId(["github-actions-audit", "ci.yml", "other"]);
  const plain = "      - uses: actions/checkout@v4\n";
  assertEquals(isFindingSuppressed({ rawText: plain }, 1, id), false);

  const wrongId =
    `      # best-practice-ignore: ${other} — different finding\n      - uses: actions/checkout@v4`;
  assertEquals(isFindingSuppressed({ rawText: wrongId }, 2, id), false);

  const farAway =
    `      # best-practice-ignore: ${id} — too far\n\n\n      - uses: actions/checkout@v4`;
  assertEquals(isFindingSuppressed({ rawText: farAway }, 4, id), false);
});

const BLAME_ID = "BP-0123456789ab";
const BLAME_MARKER =
  `# best-practice-ignore: ${BLAME_ID} — author=nigel expires=2099-12-31 pinned upstream`;

/** Run `fn` with only the author allowlist set — never the commit-author seam. */
async function withBlameBinding(fn: () => Promise<void>): Promise<void> {
  _clearSuppressionCommitAuthors();
  _setSuppressionAllowlist(["nigel"]);
  try {
    await fn();
  } finally {
    _clearSuppressionAllowlist();
  }
}

Deno.test("isFindingSuppressed - honours a marker whose author matches the blamed line without the commit-author seam (Issue #3389)", async () => {
  await withBlameBinding(() => {
    const rawText = `${BLAME_MARKER}\n      - uses: actions/checkout@v4\n`;
    const path = ".github/workflows/ci.yml";
    assert(
      isFindingSuppressed(
        { rawText, path, lineAuthors: { 1: "nigel" } },
        2,
        BLAME_ID,
      ),
    );
    return Promise.resolve();
  });
});

Deno.test("isFindingSuppressed - rejects a marker blamed on someone else or with no blame (Issue #3389)", async () => {
  await withBlameBinding(() => {
    const rawText = `${BLAME_MARKER}\n      - uses: actions/checkout@v4\n`;
    const path = ".github/workflows/ci.yml";
    assertEquals(
      isFindingSuppressed(
        { rawText, path, lineAuthors: { 1: "mallory" } },
        2,
        BLAME_ID,
      ),
      false,
    );
    assertEquals(isFindingSuppressed({ rawText, path }, 2, BLAME_ID), false);
    return Promise.resolve();
  });
});

Deno.test("readWorkflowFiles - blames a file carrying a BP- marker and attaches lineAuthors (Issue #3389)", async () => {
  const dir = await Deno.makeTempDir({ prefix: "wsc-blame-" });
  try {
    await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
    await Deno.writeTextFile(
      `${dir}/.github/workflows/marked.yml`,
      `${BLAME_MARKER}\n${CI_YML}`,
    );
    await Deno.writeTextFile(`${dir}/.github/workflows/clean.yml`, CI_YML);
    const calls: string[] = [];
    const blameFileFn: BlameFileFn = (_dir, file) => {
      calls.push(file);
      return Promise.resolve({ 1: "nigel" });
    };

    const files = await readWorkflowFiles(dir, { blameFileFn });

    assertEquals(calls, [".github/workflows/marked.yml"]);
    const byPath = new Map(files.map((f) => [f.path, f]));
    assertEquals(byPath.get(".github/workflows/marked.yml")!.lineAuthors, {
      1: "nigel",
    });
    assertEquals(
      byPath.get(".github/workflows/clean.yml")!.lineAuthors,
      undefined,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

async function commitAs(
  cwd: string,
  login: string,
  message: string,
): Promise<void> {
  const env = {
    GIT_AUTHOR_NAME: login,
    GIT_AUTHOR_EMAIL: `${login}@users.noreply.github.com`,
    GIT_COMMITTER_NAME: login,
    GIT_COMMITTER_EMAIL: `${login}@users.noreply.github.com`,
    GIT_CONFIG_GLOBAL: "/dev/null",
    GIT_CONFIG_SYSTEM: "/dev/null",
  };
  for (const args of [["add", "-A"], ["commit", "-q", "-m", message]]) {
    const out = await new Deno.Command("git", {
      args,
      cwd,
      env,
      stdin: "null",
      stdout: "piped",
      stderr: "piped",
    }).output();
    assertEquals(
      out.code,
      0,
      `git ${args.join(" ")}: ${new TextDecoder().decode(out.stderr)}`,
    );
  }
}

Deno.test("readWorkflowFiles + isFindingSuppressed - a committed marker is honoured in production wiring (Issue #3389)", async () => {
  await withBlameBinding(async () => {
    const dir = await Deno.makeTempDir({ prefix: "wsc-e2e-" });
    try {
      const init = await new Deno.Command("git", {
        args: ["init", "-q", "-b", "main"],
        cwd: dir,
        env: { GIT_CONFIG_GLOBAL: "/dev/null", GIT_CONFIG_SYSTEM: "/dev/null" },
        stdin: "null",
        stdout: "piped",
        stderr: "piped",
      }).output();
      assertEquals(init.code, 0);
      await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
      const wf = `${dir}/.github/workflows/ci.yml`;
      const head =
        `name: CI\non: [push]\njobs:\n  b:\n    runs-on: ubuntu-latest\n    steps:\n`;
      const uses = `      - uses: actions/checkout@v4\n`;
      await Deno.writeTextFile(wf, `${head}      ${BLAME_MARKER}\n${uses}`);
      await commitAs(dir, "nigel", "add marker");

      // No deps: the default (real git blame) is the production path.
      let files = await readWorkflowFiles(dir);
      assertEquals(files.length, 1);
      const usesLine = 8;
      assert(isFindingSuppressed(files[0]!, usesLine, BLAME_ID));

      // A different author rewrites the marker line: forgery is rejected.
      await Deno.writeTextFile(
        wf,
        `${head}      ${BLAME_MARKER} (edited)\n${uses}`,
      );
      await commitAs(dir, "mallory", "forge marker");
      files = await readWorkflowFiles(dir);
      assertEquals(isFindingSuppressed(files[0]!, usesLine, BLAME_ID), false);
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  });
});

// ---------------------------------------------------------------------------
// fileWorkflowFinding
// ---------------------------------------------------------------------------

function recordingGh(
  url: string,
): { gh: GhCommandFn; calls: string[][] } {
  const calls: string[][] = [];
  const gh: GhCommandFn = (args: string[]) => {
    calls.push(args);
    return Promise.resolve(url);
  };
  return { gh, calls };
}

Deno.test("fileWorkflowFinding - files via gh stub with correct labels, marker, and footer", async () => {
  const { gh, calls } = recordingGh(
    "https://github.com/acme/widgets/issues/123\n",
  );
  const findingId = await makeStableId(["github-actions-audit", "ci.yml", "x"]);
  const result = await fileWorkflowFinding({
    repo: "acme/widgets",
    findingId,
    severity: "high",
    title: "🟠 Pin third-party action to a SHA in .github/workflows/ci.yml:7",
    file: ".github/workflows/ci.yml",
    lines: 7,
    whyItMatters: "Unpinned actions are a supply-chain risk.",
    suggestedFix: "Pin `actions/checkout` to a full 40-char commit SHA.",
    evidence: "      - uses: actions/checkout@v4",
    template: "github-actions-audit",
    runId: "vibe-abc123",
    ghCommandFn: gh,
  });

  assertEquals(result, { number: 123, findingId });

  assertEquals(calls.length, 1);
  const args = calls[0] as string[];
  // Labels: github-actions-audit + exactly one severity:*.
  const labels: string[] = [];
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--label") labels.push(args[i + 1] as string);
  }
  assertEquals(labels, ["github-actions-audit", "severity:high"]);

  const bodyIdx = args.indexOf("--body");
  const body = args[bodyIdx + 1] as string;
  assert(body.includes(`<!-- finding-id: ${findingId} -->`));
  assert(body.includes("## Why this matters"));
  assert(body.includes("## Suggested fix"));
  assert(body.includes("## Evidence"));
  // Footer is the final line.
  const expectedFooter =
    "🏷️ Filed by idle-task template: `github-actions-audit` · Run id: `vibe-abc123`";
  assert(
    body.endsWith(expectedFooter),
    `body did not end with footer:\n${body}`,
  );
});

Deno.test("fileWorkflowFinding - omits Evidence section when not supplied", async () => {
  const { gh, calls } = recordingGh(
    "https://github.com/acme/widgets/issues/9\n",
  );
  const findingId = await makeStableId(["github-actions-audit", "ci.yml", "y"]);
  await fileWorkflowFinding({
    repo: "acme/widgets",
    findingId,
    severity: "low",
    title: "🟢 Minor",
    file: ".github/workflows/ci.yml",
    whyItMatters: "rationale",
    suggestedFix: "fix",
    template: "github-actions-audit",
    runId: "vibe-x",
    ghCommandFn: gh,
  });
  const args = calls[0] as string[];
  const body = args[args.indexOf("--body") + 1] as string;
  assertEquals(body.includes("## Evidence"), false);
});

Deno.test("fileWorkflowFinding - returns null when gh throws", async () => {
  const gh: GhCommandFn = () => Promise.reject(new Error("gh boom"));
  const findingId = await makeStableId(["github-actions-audit", "ci.yml", "z"]);
  const result = await fileWorkflowFinding({
    repo: "acme/widgets",
    findingId,
    severity: "medium",
    title: "t",
    file: "f",
    whyItMatters: "w",
    suggestedFix: "s",
    template: "github-actions-audit",
    runId: "r",
    ghCommandFn: gh,
  });
  assertEquals(result, null);
});

Deno.test("fileWorkflowFinding - returns null when gh output has no issue URL", async () => {
  const { gh } = recordingGh("nonsense output without a url\n");
  const findingId = await makeStableId(["github-actions-audit", "ci.yml", "w"]);
  const result = await fileWorkflowFinding({
    repo: "acme/widgets",
    findingId,
    severity: "medium",
    title: "t",
    file: "f",
    whyItMatters: "w",
    suggestedFix: "s",
    template: "github-actions-audit",
    runId: "r",
    ghCommandFn: gh,
  });
  assertEquals(result, null);
});

// ---------------------------------------------------------------------------
// selectLiveSteps — the per-file dedup/suppression rules (Issue #2221)
// ---------------------------------------------------------------------------

/** A two-step fixture file with a marker above the second `uses:` line. */
function stepsFile(rawText: string): WorkflowFile {
  return {
    path: ".github/workflows/ci.yml",
    rawText,
    parsed: {},
    kind: "workflow",
  };
}

/** One offending step, in the shape the per-file pre-filers use. */
interface DemoStep {
  job: string;
  stepIndex: number;
  line: number;
}

const TWO_STEPS: DemoStep[] = [
  { job: "test", stepIndex: 0, line: 2 },
  { job: "lint", stepIndex: 0, line: 4 },
];

/** Options shared by the `selectLiveSteps` cases. */
function opts(
  file: WorkflowFile,
  over: {
    suppressedIds?: string[];
    knownOpenIds?: string[];
  } = {},
): SelectLiveStepsOptions<DemoStep> {
  return {
    file,
    findingId: "BP-DEMO-ci",
    stepId: (s: DemoStep) => `BP-DEMO-ci-${s.job}-${s.stepIndex}`,
    suppressedIds: new Set(over.suppressedIds ?? []),
    knownOpenIds: new Set(over.knownOpenIds ?? []),
  };
}

const PLAIN = stepsFile("jobs:\n  a: 1\n  b: 2\n  c: 3\n  d: 4\n");

Deno.test("selectLiveSteps - nothing suppressed keeps every step", () => {
  assertEquals(selectLiveSteps(TWO_STEPS, opts(PLAIN)), TWO_STEPS);
});

Deno.test("selectLiveSteps - no steps yields no steps", () => {
  assertEquals(selectLiveSteps([], opts(PLAIN)), []);
});

Deno.test("selectLiveSteps - the per-file id being open or suppressed covers the file", () => {
  assertEquals(
    selectLiveSteps(TWO_STEPS, opts(PLAIN, { knownOpenIds: ["BP-DEMO-ci"] })),
    [],
  );
  assertEquals(
    selectLiveSteps(TWO_STEPS, opts(PLAIN, { suppressedIds: ["BP-DEMO-ci"] })),
    [],
  );
});

Deno.test("selectLiveSteps - an open per-step id covers the whole file (migration)", () => {
  assertEquals(
    selectLiveSteps(
      TWO_STEPS,
      opts(PLAIN, { knownOpenIds: ["BP-DEMO-ci-lint-0"] }),
    ),
    [],
  );
});

Deno.test("selectLiveSteps - a suppressed per-step id drops only that step", () => {
  assertEquals(
    selectLiveSteps(
      TWO_STEPS,
      opts(PLAIN, { suppressedIds: ["BP-DEMO-ci-test-0"] }),
    ),
    [TWO_STEPS[1]!],
  );
});

Deno.test("selectLiveSteps - an in-source marker drops the step it sits above", () => {
  _setSuppressionAllowlist(["nigel"]);
  _setSuppressionCommitAuthors(["nigel"]);
  try {
    const file = stepsFile(
      [
        "jobs:",
        "  - uses: actions/checkout@v4",
        "  # best-practice-ignore: BP-DEMO-ci — author=nigel expires=2099-12-31 needed",
        "  - uses: actions/checkout@v4",
      ].join("\n"),
    );
    assertEquals(selectLiveSteps(TWO_STEPS, opts(file)), [TWO_STEPS[0]!]);
  } finally {
    _clearSuppressionAllowlist();
    _clearSuppressionCommitAuthors();
  }
});

Deno.test("selectLiveSteps - a file's blamed lineAuthors lets an in-source marker drop a step without the seam (Issue #3389)", async () => {
  await withBlameBinding(() => {
    const file: WorkflowFile = {
      ...stepsFile(
        [
          "jobs:",
          "  - uses: actions/checkout@v4",
          "  # best-practice-ignore: BP-DEMO-ci — author=nigel expires=2099-12-31 needed",
          "  - uses: actions/checkout@v4",
        ].join("\n"),
      ),
      lineAuthors: { 3: "nigel" },
    };
    assertEquals(selectLiveSteps(TWO_STEPS, opts(file)), [TWO_STEPS[0]!]);
    const forged = { ...file, lineAuthors: { 3: "mallory" } };
    assertEquals(selectLiveSteps(TWO_STEPS, opts(forged)), TWO_STEPS);
    return Promise.resolve();
  });
});
