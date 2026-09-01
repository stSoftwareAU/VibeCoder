/**
 * Tests for prompt manager module (Issue #914).
 *
 * Migrated from tests/prompt-management.bats.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  getLatestVersion,
  getOptionalPlaceholders,
  getPromptsDir,
  getRequiredPlaceholders,
  listPromptVersions,
  loadPrompt,
  recordPromptVersion,
  validateAllPromptTemplates,
  validatePromptImmutability,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

// Resolve the prompts directory relative to this test file
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- listPromptVersions tests ---

Deno.test("prompt manager - lists coding_guidelines versions", async () => {
  const result = await listPromptVersions("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
    assertEquals(result.value[0], "v1");
  }
});

Deno.test("prompt manager - returns error for non-existent prompt", async () => {
  const result = await listPromptVersions("nonexistent_prompt", PROMPTS_DIR);
  assertEquals(result.ok, false);
});

Deno.test("prompt manager - sorts versions numerically", async () => {
  const result = await listPromptVersions("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok && result.value.length >= 2) {
    const nums = result.value.map((v) => parseInt(v.replace("v", ""), 10));
    for (let i = 1; i < nums.length; i++) {
      assertEquals(nums[i]! > nums[i - 1]!, true);
    }
  }
});

// --- getLatestVersion tests ---

Deno.test("prompt manager - gets latest version for coding_guidelines", async () => {
  const result = await getLatestVersion("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    // Latest version should be a vN string
    assertEquals(/^v\d+$/.test(result.value), true);
  }
});

Deno.test("prompt manager - returns error for non-existent prompt", async () => {
  const result = await getLatestVersion("does_not_exist", PROMPTS_DIR);
  assertEquals(result.ok, false);
});

// --- loadPrompt tests ---

Deno.test("prompt manager - loads coding_guidelines template", async () => {
  const result = await loadPrompt("coding_guidelines", undefined, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("prompt manager - loads specific version", async () => {
  const result = await loadPrompt("coding_guidelines", "v1", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("prompt manager - returns error for non-existent version", async () => {
  const result = await loadPrompt("coding_guidelines", "v9999", PROMPTS_DIR);
  assertEquals(result.ok, false);
});

Deno.test("prompt manager - loads issue template", async () => {
  const result = await loadPrompt("issue", undefined, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{ISSUE_NUMBER}}");
  }
});

Deno.test("prompt manager - loads planning template", async () => {
  const result = await loadPrompt("planning", undefined, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{PLANNING_LABEL}}");
  }
});

Deno.test("prompt manager - loads question template", async () => {
  const result = await loadPrompt("question", undefined, PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{QUESTION_LABEL}}");
  }
});

// --- recordPromptVersion tests ---

Deno.test("prompt manager - records version to log file", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = `${tempDir}/versions.log`;

  try {
    const result = await recordPromptVersion(logFile, "issue", "v2");
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(logFile);
    assertStringIncludes(content, "prompt=issue");
    assertStringIncludes(content, "version=v2");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("prompt manager - appends multiple entries", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = `${tempDir}/versions.log`;

  try {
    await recordPromptVersion(logFile, "issue", "v1");
    await recordPromptVersion(logFile, "coding_guidelines", "v3");

    const content = await Deno.readTextFile(logFile);
    assertStringIncludes(content, "prompt=issue");
    assertStringIncludes(content, "prompt=coding_guidelines");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

// --- getRequiredPlaceholders tests ---

// Issue #3813: `CODING_GUIDELINES` moved from required to optional — since
// #1262 the guidelines ride in the system prompt, so issue v31+ carries no
// placeholder for them.
Deno.test("prompt manager - returns placeholders for issue template", () => {
  const result = getRequiredPlaceholders("issue");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.includes("ISSUE_NUMBER"), true);
    assertEquals(result.value.includes("QUALITY_INSTRUCTIONS"), true);
    assertEquals(result.value.includes("CODING_GUIDELINES"), false);
  }
});

Deno.test("prompt manager - returns placeholders for planning template", () => {
  const result = getRequiredPlaceholders("planning");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.includes("REPO"), true);
    assertEquals(result.value.includes("PLANNING_LABEL"), true);
  }
});

Deno.test("prompt manager - returns placeholders for question template", () => {
  const result = getRequiredPlaceholders("question");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.includes("REPO"), true);
    assertEquals(result.value.includes("QUESTION_LABEL"), true);
  }
});

Deno.test("prompt manager - returns empty for coding_guidelines", () => {
  const result = getRequiredPlaceholders("coding_guidelines");
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length, 0);
  }
});

Deno.test("prompt manager - returns error for unknown template type", () => {
  const result = getRequiredPlaceholders("unknown_type");
  assertEquals(result.ok, false);
});

// --- validatePromptTemplate tests ---

Deno.test("prompt manager - validates template with all placeholders", () => {
  const content =
    "Use {{ISSUE_NUMBER}} and {{QUALITY_INSTRUCTIONS}} with {{CODING_GUIDELINES}}";
  const result = validatePromptTemplate("issue", content);
  assertEquals(result.ok, true);
});

Deno.test("prompt manager - reports missing placeholders", () => {
  const content = "Use {{ISSUE_NUMBER}} only";
  const result = validatePromptTemplate("issue", content);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "QUALITY_INSTRUCTIONS");
  }
});

// Issue #3813: a template that omits the now-optional CODING_GUIDELINES
// placeholder still validates.
Deno.test("prompt manager - validates issue template without CODING_GUIDELINES", () => {
  const content = "Use {{ISSUE_NUMBER}} and {{QUALITY_INSTRUCTIONS}}";
  const result = validatePromptTemplate("issue", content);
  assertEquals(result.ok, true);
});

Deno.test("prompt manager - validates coding_guidelines with no placeholders needed", () => {
  const result = validatePromptTemplate("coding_guidelines", "Any content");
  assertEquals(result.ok, true);
});

// --- OPEN_ISSUE_TITLES optional placeholder tests (Issue #536) ---
//
// The scan types that file findings share the all-open-issues dedup block.
// `{{OPEN_ISSUE_TITLES}}` is registered as *optional*: a prompt version that
// carries it validates, and every version shipped before it still validates.

/** Scan template types that may carry the all-open-issues dedup block. */
const SCAN_TYPES_WITH_OPEN_ISSUE_TITLES = [
  "security_scan",
  "best_practices",
  "test_audit",
  "github_actions_audit",
  "supply_chain_readiness",
  "supply_chain_detection",
  "orphan_deps",
  "documentation_audit",
  "private_repo_reference_audit",
  "doc_coverage",
  "duplicated_knowledge",
  "retro",
  "dead_code",
  "deprecated_api",
  "format_drift",
];

/** Render a minimal body carrying every required placeholder for a type. */
function scanBody(templateType: string, extra = ""): string {
  const required = getRequiredPlaceholders(templateType);
  assertEquals(required.ok, true, `type '${templateType}' is unregistered`);
  const blocks = required.ok
    ? required.value.map((p) => `{{${p}}}`).join("\n")
    : "";
  return `Scan instructions\n${blocks}\n${extra}`;
}

Deno.test("prompt manager - OPEN_ISSUE_TITLES is optional for every scan type", () => {
  for (const type of SCAN_TYPES_WITH_OPEN_ISSUE_TITLES) {
    const optional = getOptionalPlaceholders(type);
    assertEquals(optional.ok, true, `Failed for type '${type}'`);
    if (optional.ok) {
      assertEquals(
        optional.value.includes("OPEN_ISSUE_TITLES"),
        true,
        `OPEN_ISSUE_TITLES missing from optional placeholders for '${type}'`,
      );
    }

    // Optional, never required — registering it as required would
    // retroactively invalidate every already-shipped prompt version.
    const required = getRequiredPlaceholders(type);
    assertEquals(required.ok, true, `Failed for type '${type}'`);
    if (required.ok) {
      assertEquals(
        required.value.includes("OPEN_ISSUE_TITLES"),
        false,
        `OPEN_ISSUE_TITLES must not be required for '${type}'`,
      );
    }
  }
});

Deno.test("prompt manager - accepts a scan body carrying OPEN_ISSUE_TITLES", () => {
  for (const type of SCAN_TYPES_WITH_OPEN_ISSUE_TITLES) {
    const result = validatePromptTemplate(
      type,
      scanBody(type, "Already open:\n{{OPEN_ISSUE_TITLES}}"),
    );
    assertEquals(result.ok, true, `Rejected OPEN_ISSUE_TITLES for '${type}'`);
  }
});

Deno.test("prompt manager - accepts a scan body without OPEN_ISSUE_TITLES", () => {
  for (const type of SCAN_TYPES_WITH_OPEN_ISSUE_TITLES) {
    const result = validatePromptTemplate(type, scanBody(type));
    assertEquals(
      result.ok,
      true,
      `Body without OPEN_ISSUE_TITLES rejected for '${type}'`,
    );
  }
});

Deno.test("prompt manager - every shipped scan version still validates", async () => {
  for (const type of SCAN_TYPES_WITH_OPEN_ISSUE_TITLES) {
    const versions = await listPromptVersions(type, PROMPTS_DIR);
    assertEquals(versions.ok, true, `No versions listed for '${type}'`);
    if (!versions.ok) continue;

    for (const version of versions.value) {
      const loaded = await loadPrompt(type, version, PROMPTS_DIR);
      assertEquals(loaded.ok, true, `Failed to load ${type}/${version}`);
      if (!loaded.ok) continue;

      const result = validatePromptTemplate(type, loaded.value);
      assertEquals(
        result.ok,
        true,
        `${type}/${version} failed validation: ${
          result.ok ? "" : result.error.message
        }`,
      );
    }
  }
});

// --- validateAllPromptTemplates tests ---

Deno.test("prompt manager - validates all prompt templates pass", async () => {
  const result = await validateAllPromptTemplates(PROMPTS_DIR);
  assertEquals(result.ok, true);
});

// --- validatePromptImmutability tests (Issue #3041) ---
//
// These WHAT-tests drive the function against real temporary git repositories
// and assert on the observable contract — the set of modified prompt version
// files returned — rather than which git subcommands run or in what order, so
// they survive a reimplementation of the diff parsing.

/** Create a temporary git repo with a committed prompt version file. */
async function createPromptRepo(): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "prompt-immutability-test-" });

  const run = async (args: string[]) => {
    const cmd = new Deno.Command("git", {
      args,
      cwd: dir,
      stdout: "piped",
      stderr: "piped",
    });
    await cmd.output();
  };

  await run(["init", "-b", "main"]);
  await run(["config", "user.email", "test@example.com"]);
  await run(["config", "user.name", "Test"]);

  await Deno.mkdir(`${dir}/prompts/issue`, { recursive: true });
  await Deno.writeTextFile(`${dir}/prompts/issue/v1.md`, "original v1\n");
  await run(["add", "."]);
  await run(["commit", "-m", "initial prompt"]);

  return dir;
}

async function gitRun(dir: string, args: string[]): Promise<void> {
  const cmd = new Deno.Command("git", {
    args,
    cwd: dir,
    stdout: "piped",
    stderr: "piped",
  });
  await cmd.output();
}

async function cleanupRepo(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Ignore
  }
}

Deno.test("prompt manager - immutability reports unstaged modified version file", async () => {
  const dir = await createPromptRepo();
  try {
    // Modify an existing committed prompt version (the prohibited edit).
    await Deno.writeTextFile(`${dir}/prompts/issue/v1.md`, "tampered\n");

    const result = await validatePromptImmutability(dir);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "prompts/issue/v1.md");
      assertStringIncludes(result.error.message, "Issue #235");
    }
  } finally {
    await cleanupRepo(dir);
  }
});

Deno.test("prompt manager - immutability passes on a clean repo", async () => {
  const dir = await createPromptRepo();
  try {
    const result = await validatePromptImmutability(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, []);
    }
  } finally {
    await cleanupRepo(dir);
  }
});

Deno.test("prompt manager - immutability allows a brand-new version file", async () => {
  const dir = await createPromptRepo();
  try {
    // Adding a new version is permitted — only modifications are rejected.
    await Deno.writeTextFile(`${dir}/prompts/issue/v2.md`, "new version\n");
    await gitRun(dir, ["add", "prompts/issue/v2.md"]);

    const result = await validatePromptImmutability(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, []);
    }
  } finally {
    await cleanupRepo(dir);
  }
});

Deno.test("prompt manager - immutability ignores non-version prompt files", async () => {
  const dir = await createPromptRepo();
  try {
    // A non-version file (README) is not subject to the immutability rule.
    await Deno.writeTextFile(`${dir}/prompts/issue/README.md`, "docs\n");
    await gitRun(dir, ["add", "prompts/issue/README.md"]);
    await gitRun(dir, ["commit", "-m", "add readme"]);
    await Deno.writeTextFile(
      `${dir}/prompts/issue/README.md`,
      "changed docs\n",
    );

    const result = await validatePromptImmutability(dir);
    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value, []);
    }
  } finally {
    await cleanupRepo(dir);
  }
});

Deno.test("prompt manager - immutability detects committed change vs base branch", async () => {
  const dir = await createPromptRepo();
  try {
    // Branch off main, commit a modification to an existing version file.
    await gitRun(dir, ["checkout", "-b", "feature"]);
    await Deno.writeTextFile(
      `${dir}/prompts/issue/v1.md`,
      "tampered on branch\n",
    );
    await gitRun(dir, ["commit", "-am", "modify v1"]);

    const result = await validatePromptImmutability(dir, "main");
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(result.error.message, "prompts/issue/v1.md");
    }
  } finally {
    await cleanupRepo(dir);
  }
});

Deno.test("getPromptsDir - VIBE_BASE_DIR names the checkout when the driver runs from a staged copy (Issue #4302)", () => {
  const savedBase = Deno.env.get("VIBE_BASE_DIR");
  const savedPrompts = Deno.env.get("PROMPTS_DIR");
  Deno.env.delete("PROMPTS_DIR");
  Deno.env.set("VIBE_BASE_DIR", "/workspace");
  try {
    assertEquals(getPromptsDir(), "/workspace/prompts");
    // PROMPTS_DIR still wins outright.
    Deno.env.set("PROMPTS_DIR", "/elsewhere/prompts");
    assertEquals(getPromptsDir(), "/elsewhere/prompts");
  } finally {
    if (savedBase !== undefined) Deno.env.set("VIBE_BASE_DIR", savedBase);
    else Deno.env.delete("VIBE_BASE_DIR");
    if (savedPrompts !== undefined) Deno.env.set("PROMPTS_DIR", savedPrompts);
    else Deno.env.delete("PROMPTS_DIR");
  }
});
