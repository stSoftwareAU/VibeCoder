/**
 * Tests for workflow_scan_common.ts — shared scaffolding for native
 * github-actions-audit pre-filers (Issue #2500, part of #2497).
 *
 * Every test exercises real functions with fixtures and an injected gh
 * stub — no network, no real gh CLI.
 */

import {
  _resetSuppressionAuthorAllowlist as _clearSuppressionAllowlist,
  setSuppressionAuthorAllowlist as _setSuppressionAllowlist,
} from "../lib/suppression_comments.ts";
import { assert, assertEquals } from "@std/assert";
import {
  fileWorkflowFinding,
  type GhCommandFn,
  isFindingSuppressed,
  makeStableId,
  readWorkflowFiles,
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
    assert(isFindingSuppressed(text, 2, id));
  } finally {
    _clearSuppressionAllowlist();
  }
});

Deno.test("isFindingSuppressed - true on the same line", async () => {
  // Issue #3941: the suppression author allowlist fails closed,
  // so authorise the marker author these fixtures use.
  _setSuppressionAllowlist(["nigel"]);
  try {
    const id = await makeStableId([
      "github-actions-audit",
      "ci.yml",
      "sha-pin",
    ]);
    const text =
      `      - uses: actions/checkout@v4 # best-practice-ignore: ${id} — author=nigel expires=2099-12-31 ok`;
    assert(isFindingSuppressed(text, 1, id));
  } finally {
    _clearSuppressionAllowlist();
  }
});

Deno.test("isFindingSuppressed - false when no marker, wrong id, or wrong line", async () => {
  const id = await makeStableId(["github-actions-audit", "ci.yml", "sha-pin"]);
  const other = await makeStableId(["github-actions-audit", "ci.yml", "other"]);
  const plain = "      - uses: actions/checkout@v4\n";
  assertEquals(isFindingSuppressed(plain, 1, id), false);

  const wrongId =
    `      # best-practice-ignore: ${other} — different finding\n      - uses: actions/checkout@v4`;
  assertEquals(isFindingSuppressed(wrongId, 2, id), false);

  const farAway =
    `      # best-practice-ignore: ${id} — too far\n\n\n      - uses: actions/checkout@v4`;
  assertEquals(isFindingSuppressed(farAway, 4, id), false);
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
