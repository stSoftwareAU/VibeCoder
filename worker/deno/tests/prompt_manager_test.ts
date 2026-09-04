/**
 * Tests for prompt manager module (Issue #914, #844).
 *
 * Migrated from tests/prompt-management.bats. Issue #844 removed `vN.md`
 * versioning, so these drive the single-`prompt.md` contract and the
 * commit-hash traceability that replaced version numbers.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import { emptyEnv, envFrom } from "./support/env_lookup.ts";
import {
  getOptionalPlaceholders,
  getPromptsCommit,
  getPromptsDir,
  getRequiredPlaceholders,
  loadPrompt,
  PROMPT_FILENAME,
  recordPromptCommit,
  validateAllPromptTemplates,
  validatePromptTemplate,
} from "../lib/prompt_manager.ts";

// Resolve the prompts directory relative to this test file
const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

// --- loadPrompt tests (Issue #844: one `prompt.md` per type) ---

Deno.test("prompt manager - loads coding_guidelines template", async () => {
  const result = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(result.value.length > 0, true);
  }
});

Deno.test("prompt manager - loads the type's prompt.md, not a versioned file", async () => {
  const result = await loadPrompt("coding_guidelines", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (!result.ok) return;

  const onDisk = await Deno.readTextFile(
    `${PROMPTS_DIR}/coding_guidelines/${PROMPT_FILENAME}`,
  );
  assertEquals(result.value, onDisk);
});

Deno.test("prompt manager - returns an error naming the missing file", async () => {
  const result = await loadPrompt("nonexistent_prompt", PROMPTS_DIR);
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(result.error.message, "nonexistent_prompt");
    assertStringIncludes(result.error.message, PROMPT_FILENAME);
  }
});

Deno.test("prompt manager - errors when the directory exists but prompt.md does not", async () => {
  const dir = await Deno.makeTempDir({ prefix: "prompt-missing-file-" });
  try {
    await Deno.mkdir(`${dir}/issue`);
    const result = await loadPrompt("issue", dir);
    assertEquals(result.ok, false);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("prompt manager - no versioned prompt files remain in the tree", async () => {
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (!entry.isDirectory) continue;
    for await (const file of Deno.readDir(`${PROMPTS_DIR}/${entry.name}`)) {
      assertEquals(
        /^v\d+\.md$/.test(file.name),
        false,
        `${entry.name}/${file.name} is a leftover versioned template`,
      );
    }
  }
});

Deno.test("prompt manager - loads issue template", async () => {
  const result = await loadPrompt("issue", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{ISSUE_NUMBER}}");
  }
});

Deno.test("prompt manager - loads planning template", async () => {
  const result = await loadPrompt("planning", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{PLANNING_LABEL}}");
  }
});

Deno.test("prompt manager - loads question template", async () => {
  const result = await loadPrompt("question", PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value, "{{QUESTION_LABEL}}");
  }
});

// --- recordPromptCommit tests ---

Deno.test("prompt manager - records the prompts commit to a log file", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = `${tempDir}/prompts.log`;

  try {
    const result = await recordPromptCommit(logFile, "2326b04");
    assertEquals(result.ok, true);

    const content = await Deno.readTextFile(logFile);
    assertStringIncludes(content, "prompts_commit=2326b04");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("prompt manager - appends multiple commit entries", async () => {
  const tempDir = await Deno.makeTempDir();
  const logFile = `${tempDir}/prompts.log`;

  try {
    await recordPromptCommit(logFile, "aaaaaaa");
    await recordPromptCommit(logFile, "bbbbbbb");

    const content = await Deno.readTextFile(logFile);
    assertStringIncludes(content, "prompts_commit=aaaaaaa");
    assertStringIncludes(content, "prompts_commit=bbbbbbb");
  } finally {
    await Deno.remove(tempDir, { recursive: true });
  }
});

Deno.test("prompt manager - recordPromptCommit fails loud on an unwritable path", async () => {
  const result = await recordPromptCommit("/nonexistent-dir/x.log", "abc1234");
  assertEquals(result.ok, false);
  if (!result.ok) {
    assertStringIncludes(
      result.error.message,
      "Failed to record prompt commit",
    );
  }
});

// --- getPromptsCommit tests (Issue #844) ---

Deno.test("getPromptsCommit - resolves the short HEAD hash of the checkout", async () => {
  const result = await getPromptsCommit(PROMPTS_DIR);
  assertEquals(result.ok, true);
  if (result.ok) {
    assertEquals(/^[0-9a-f]{7,40}$/.test(result.value), true, result.value);
  }
});

Deno.test("getPromptsCommit - fails loud outside a git checkout", async () => {
  const dir = await Deno.makeTempDir({ prefix: "prompts-commit-nogit-" });
  try {
    const result = await getPromptsCommit(dir);
    assertEquals(result.ok, false);
    if (!result.ok) {
      assertStringIncludes(
        result.error.message,
        "Failed to resolve prompts commit",
      );
    }
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- getRequiredPlaceholders tests ---

// Issue #3813: `CODING_GUIDELINES` moved from required to optional — since
// #1262 the guidelines ride in the system prompt, so the issue template
// carries no placeholder for them.
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

Deno.test("prompt manager - every shipped scan template still validates", async () => {
  for (const type of SCAN_TYPES_WITH_OPEN_ISSUE_TITLES) {
    const loaded = await loadPrompt(type, PROMPTS_DIR);
    assertEquals(loaded.ok, true, `Failed to load ${type}`);
    if (!loaded.ok) continue;

    const result = validatePromptTemplate(type, loaded.value);
    assertEquals(
      result.ok,
      true,
      `${type} failed validation: ${result.ok ? "" : result.error.message}`,
    );
  }
});

// --- validateAllPromptTemplates tests ---

Deno.test("prompt manager - validates all prompt templates pass", async () => {
  const result = await validateAllPromptTemplates(PROMPTS_DIR);
  assertEquals(result.ok, true);
});

// --- getPromptsDir tests (Issue #4302, #968) ---
//
// The environment is handed in (Issue #968). Every value below is absent from
// the real process environment, so a resolution order that quietly fell back
// to `Deno.env.get` would read the *ambient* worker configuration and fail
// these assertions rather than pass on it.

Deno.test("getPromptsDir - VIBE_BASE_DIR names the checkout when the driver runs from a staged copy (Issue #4302)", () => {
  assertEquals(
    getPromptsDir(undefined, envFrom({ VIBE_BASE_DIR: "/workspace" })),
    "/workspace/prompts",
  );
});

Deno.test("getPromptsDir - PROMPTS_DIR wins outright over VIBE_BASE_DIR (Issue #4302)", () => {
  const env = envFrom({
    PROMPTS_DIR: "/elsewhere/prompts",
    VIBE_BASE_DIR: "/workspace",
  });
  assertEquals(getPromptsDir(undefined, env), "/elsewhere/prompts");
  // …and over an explicit worker directory too.
  assertEquals(getPromptsDir("/staged/worker/deno", env), "/elsewhere/prompts");
});

Deno.test("getPromptsDir - a worker directory beats VIBE_BASE_DIR", () => {
  assertEquals(
    getPromptsDir(
      "/staged/worker/deno",
      envFrom({ VIBE_BASE_DIR: "/workspace" }),
    ),
    "/staged/worker/deno/../prompts",
  );
});

Deno.test("getPromptsDir - falls back to this module's checkout when nothing is set", () => {
  // The injected environment carries neither override, so the result must be
  // the module-relative path — the same directory these tests load from. The
  // fallback is spelled with `..` segments, so compare the resolved paths.
  assertEquals(
    Deno.realPathSync(getPromptsDir(undefined, emptyEnv)),
    Deno.realPathSync(PROMPTS_DIR),
  );
});

Deno.test("getPromptsDir - an empty override is not an override", () => {
  assertEquals(
    Deno.realPathSync(
      getPromptsDir(undefined, envFrom({ PROMPTS_DIR: "", VIBE_BASE_DIR: "" })),
    ),
    Deno.realPathSync(PROMPTS_DIR),
  );
});
