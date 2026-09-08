/**
 * Tests for the native gate-skip drift scanner (Issue #1597, follow-up
 * from #1574).
 *
 * The drift this scanner exists to catch: a fleet repository's
 * `quality.sh` prints a warning and skips a tool when the container image
 * lacks it, while the same repository's CI installs and enforces that tool
 * — so the Vibe Coder's local gate passes and the PR fails in CI. That is
 * exactly what happened to NEAT-AI-core PR 597, whose 394 BATS tests ran
 * only in CI.
 *
 * The fixtures under `fixtures/gate_skip_drift/` are snapshots of the
 * NEAT-AI-core and NEAT-AI-scorer gates as they stood before #1595 baked
 * `bats` and `codespell` into the image, plus two synthetic pairs for the
 * negative cases (enforced-and-hard-failing, skipped-but-not-enforced).
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import {
  bakedToolsForRepo,
  findCiToolEnforcements,
  findGateToolSkips,
  type GateSkipDriftResult,
  type GateSkipDriftValue,
  scanGateSkipDrift,
} from "../lib/gate_skip_drift_scanner.ts";
import { parseContainerManifest } from "../lib/container_manifest.ts";
import {
  _resetSuppressionAuthorAllowlist,
  _resetSuppressionCommitAuthors,
  setSuppressionAuthorAllowlist,
  setSuppressionCommitAuthors,
} from "../lib/suppression_comments.ts";
import { readWorkflowFiles } from "../lib/workflow_scan_common.ts";

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);
const FIXTURES = new URL("fixtures/gate_skip_drift/", import.meta.url);

/** Read a committed fixture pair. */
async function fixture(
  name: string,
): Promise<{ gate: string; workflow: string }> {
  return {
    gate: await Deno.readTextFile(
      new URL(`${name}/quality.sh.snapshot`, FIXTURES),
    ),
    workflow: await Deno.readTextFile(new URL(`${name}/ci.yml`, FIXTURES)),
  };
}

/**
 * Lay a fixture pair out as a repository checkout: `quality.sh` at the
 * root and the workflow under `.github/workflows/`. Returns the temp dir.
 */
async function checkoutFixture(name: string): Promise<string> {
  const { gate, workflow } = await fixture(name);
  const dir = await Deno.makeTempDir({ prefix: "gate-skip-drift-" });
  await Deno.writeTextFile(`${dir}/quality.sh`, gate);
  await Deno.mkdir(`${dir}/.github/workflows`, { recursive: true });
  await Deno.writeTextFile(`${dir}/.github/workflows/ci.yml`, workflow);
  return dir;
}

/** The committed manifest, which names bats/codespell for the NEAT repos. */
async function currentManifestText(): Promise<string> {
  return await Deno.readTextFile(new URL("container/tools.json", REPO_ROOT));
}

/**
 * The manifest as it stood *before* #1595: the same file with the
 * toolchains #1595 added stripped out, so the fixture snapshots and the
 * manifest describe the same moment in time.
 */
async function pre1595ManifestText(): Promise<string> {
  const manifest = JSON.parse(await currentManifestText()) as {
    toolchains: Array<{ id: string }>;
  };
  manifest.toolchains = manifest.toolchains.filter(
    (t) => t.id !== "bats-core" && t.id !== "codespell",
  );
  return JSON.stringify(manifest);
}

/** Unwrap a scan result, failing loud with the scanner's own message. */
function unwrap(result: GateSkipDriftResult): GateSkipDriftValue {
  if (!result.ok) throw new Error(`scan failed: ${result.error.message}`);
  return result.value;
}

// ---------------------------------------------------------------------------
// findGateToolSkips — the `command -v <tool> … skipping` shape
// ---------------------------------------------------------------------------

Deno.test("findGateToolSkips - reports every tool the gate skips with a warning", async () => {
  const { gate } = await fixture("neat_ai_core");
  const skips = findGateToolSkips(gate);

  assertEquals(skips.map((s) => s.tool), ["bats", "codespell"]);

  const bats = skips[0]!;
  const gateLines = gate.split("\n");
  assert(
    gateLines[bats.guardLine - 1]?.includes("command -v bats"),
    `guard line ${bats.guardLine} is not the command -v line`,
  );
  assert(
    /not installed .* skipping/i.test(bats.skipText),
    `skip text does not announce a skip: ${bats.skipText}`,
  );
  assertEquals(gateLines[bats.skipLine - 1]?.trim(), bats.skipText);
});

Deno.test("findGateToolSkips - a guard that exits is enforced, not skipped", async () => {
  const { gate } = await fixture("hard_fail");
  assertEquals(findGateToolSkips(gate), []);
});

Deno.test("findGateToolSkips - the NEAT-AI-core gate's shellcheck guard is not a skip", async () => {
  // The same snapshot carries a hard-failing shellcheck guard three blocks
  // above the bats skip: proximity must not turn it into a finding.
  const { gate } = await fixture("neat_ai_core");
  assert(gate.includes("command -v shellcheck"));
  assertEquals(
    findGateToolSkips(gate).some((s) => s.tool === "shellcheck"),
    false,
  );
});

Deno.test("findGateToolSkips - a gate with no guards yields nothing", () => {
  assertEquals(findGateToolSkips("#!/bin/bash\nset -e\ncargo test\n"), []);
});

// ---------------------------------------------------------------------------
// findCiToolEnforcements — install-and-run in the repo's own workflows
// ---------------------------------------------------------------------------

Deno.test("findCiToolEnforcements - finds an installed-and-run tool with both lines", async () => {
  const dir = await checkoutFixture("neat_ai_core");
  try {
    const files = await readWorkflowFiles(dir);
    const found = findCiToolEnforcements(files, ["bats", "codespell"]);

    const bats = found.find((e) => e.tool === "bats");
    assert(bats, "bats enforcement not found");
    assertEquals(bats.kind, "run");
    assertEquals(bats.file, ".github/workflows/ci.yml");
    assertEquals(bats.text, "bats tests/scripts");
    assert(
      bats.installText?.includes("apt-get install"),
      `install evidence missing: ${bats.installText}`,
    );

    const raw = await Deno.readTextFile(`${dir}/${bats.file}`);
    assertEquals(
      raw.split("\n")[bats.line - 1]?.trim(),
      "run: bats tests/scripts",
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findCiToolEnforcements - a third-party action counts as enforcement", async () => {
  const dir = await checkoutFixture("neat_ai_core");
  try {
    const files = await readWorkflowFiles(dir);
    const codespell = findCiToolEnforcements(files, ["codespell"])
      .find((e) => e.tool === "codespell");

    assert(codespell, "codespell enforcement not found");
    assertEquals(codespell.kind, "uses");
    assert(
      codespell.text.includes("codespell-project/actions-codespell"),
      `unexpected action reference: ${codespell.text}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findCiToolEnforcements - a tool no workflow runs is not enforced", async () => {
  const dir = await checkoutFixture("skip_only");
  try {
    const files = await readWorkflowFiles(dir);
    assertEquals(findCiToolEnforcements(files, ["codespell"]), []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("findCiToolEnforcements - a setup action alone is not enforcement", async () => {
  const files = [{
    path: ".github/workflows/ci.yml",
    kind: "workflow" as const,
    rawText: "jobs:\n  a:\n    steps:\n      - uses: denoland/setup-deno@v2\n",
    parsed: {
      jobs: { a: { steps: [{ uses: "denoland/setup-deno@v2" }] } },
    },
  }];
  assertEquals(findCiToolEnforcements(files, ["deno"]), []);
});

// ---------------------------------------------------------------------------
// bakedToolsForRepo — the container/tools.json suppression
// ---------------------------------------------------------------------------

Deno.test("bakedToolsForRepo - lists the commands the image carries for a repo", async () => {
  const manifest = parseContainerManifest(await currentManifestText());

  const core = bakedToolsForRepo(manifest, "stSoftwareAU/NEAT-AI-core");
  assert(core.includes("bats"), `bats missing from ${core.join(", ")}`);
  assert(
    core.includes("codespell"),
    `codespell missing from ${core.join(", ")}`,
  );

  // A repo the toolchain does not name gets nothing from it.
  assertEquals(
    bakedToolsForRepo(manifest, "stSoftwareAU/VibeCoder").includes("bats"),
    false,
  );
});

// ---------------------------------------------------------------------------
// scanGateSkipDrift — end to end over a checkout
// ---------------------------------------------------------------------------

Deno.test("scanGateSkipDrift - reports NEAT-AI-core's bats and codespell drift", async () => {
  const dir = await checkoutFixture("neat_ai_core");
  try {
    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: await pre1595ManifestText(),
    });

    const value = unwrap(result);
    assertEquals(value.drifts.map((d) => d.tool), ["bats", "codespell"]);

    const bats = value.drifts[0]!;
    assertEquals(bats.skip.tool, "bats");
    assertEquals(bats.enforcement.file, ".github/workflows/ci.yml");
    assert(bats.skip.skipLine > 0, "skip line not resolved");
    assert(bats.enforcement.line > 0, "enforcement line not resolved");
    assert(
      bats.findingId.startsWith("BP-"),
      `finding id must carry the BP- prefix: ${bats.findingId}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanGateSkipDrift - reports NEAT-AI-scorer's bats drift", async () => {
  const dir = await checkoutFixture("neat_ai_scorer");
  try {
    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-scorer",
      manifestText: await pre1595ManifestText(),
    });

    const value = unwrap(result);
    assertEquals(value.drifts.map((d) => d.tool), ["bats"]);
    assertEquals(value.drifts[0]?.enforcement.kind, "run");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanGateSkipDrift - a baked toolchain suppresses the finding", async () => {
  const dir = await checkoutFixture("neat_ai_core");
  try {
    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: await currentManifestText(),
    });

    const value = unwrap(result);
    assertEquals(value.drifts, []);
    assertEquals(value.suppressedTools, ["bats", "codespell"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanGateSkipDrift - an enforced, hard-failing gate yields no finding", async () => {
  const dir = await checkoutFixture("hard_fail");
  try {
    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: await pre1595ManifestText(),
    });

    const value = unwrap(result);
    assertEquals(value.drifts, []);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanGateSkipDrift - a skip no workflow enforces yields no finding", async () => {
  const dir = await checkoutFixture("skip_only");
  try {
    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: await pre1595ManifestText(),
    });

    const value = unwrap(result);
    assertEquals(value.drifts, []);
    assertEquals(value.skips.map((s) => s.tool), ["codespell"]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanGateSkipDrift - a repo with no quality.sh is not applicable", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gate-skip-drift-none-" });
  try {
    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: await pre1595ManifestText(),
    });

    const value = unwrap(result);
    assertEquals(value.gateScriptPath, null);
    assertEquals(value.drifts, []);
    assertEquals(value.workflowsLoaded, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

/** Write the gate with a `best-practice-ignore` marker above the bats skip. */
async function waiveBats(dir: string, trailer: string): Promise<void> {
  const gate = await Deno.readTextFile(`${dir}/quality.sh`);
  const echo = 'echo "⚠️  bats not installed — skipping shell helper tests"';
  await Deno.writeTextFile(
    `${dir}/quality.sh`,
    gate.replace(
      echo,
      `# best-practice-ignore: BP-GATE-SKIP-BATS${trailer}\n    ${echo}`,
    ),
  );
}

Deno.test("scanGateSkipDrift - an attributed in-source waiver suppresses the tool", async () => {
  // The waiver grammar fails closed (Issues #3941, #269): authorise the
  // marker's author the way every other native scanner's tests do.
  setSuppressionAuthorAllowlist(["nigel"]);
  setSuppressionCommitAuthors(["nigel"]);
  const dir = await checkoutFixture("neat_ai_core");
  try {
    await waiveBats(dir, " — author=nigel expires=2099-12-31 CI-only suite");

    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: await pre1595ManifestText(),
    });

    assertEquals(unwrap(result).drifts.map((d) => d.tool), ["codespell"]);
  } finally {
    _resetSuppressionAuthorAllowlist();
    _resetSuppressionCommitAuthors();
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanGateSkipDrift - an unattributed waiver suppresses nothing", async () => {
  const dir = await checkoutFixture("neat_ai_core");
  try {
    await waiveBats(dir, "");

    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: await pre1595ManifestText(),
    });

    assertEquals(unwrap(result).drifts.map((d) => d.tool), [
      "bats",
      "codespell",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanGateSkipDrift - an unreadable gate script fails loud", async () => {
  const dir = await Deno.makeTempDir({ prefix: "gate-skip-drift-bad-" });
  try {
    // A directory named quality.sh: the path exists but cannot be read as
    // text, which must surface as ok:false rather than a silent green.
    await Deno.mkdir(`${dir}/quality.sh`);

    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: await pre1595ManifestText(),
    });

    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "read");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("scanGateSkipDrift - an unparseable manifest fails loud", async () => {
  const dir = await checkoutFixture("neat_ai_core");
  try {
    const result = await scanGateSkipDrift({
      repoPath: dir,
      repo: "stSoftwareAU/NEAT-AI-core",
      manifestText: "{ not json",
    });

    assertEquals(result.ok, false);
    if (!result.ok) assertEquals(result.error.kind, "manifest");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});
