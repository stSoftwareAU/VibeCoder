/**
 * Tests for prompts/ci_fix/v4.md (Issue #1692).
 *
 * v4 surfaces the failure classification (Issue #1690) in the prompt and
 * forces Claude to write `.pr_response_message` even when no code change is
 * applied. The renderer substitutes `{{FAILURE_CLASSIFICATION}}` from a real
 * `classifyCiFailure()` call.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  buildCiFixPrompt,
  formatCiFailureClassification,
} from "../lib/prompt_builder.ts";
import type { CiAnnotation } from "../lib/ci_failure_classifier.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

Deno.test("ci_fix v4 - renderer substitutes FAILURE_CLASSIFICATION for semgrep", async () => {
  const annotations: CiAnnotation[] = [
    {
      message: "Blocking code rules fired",
      title: "semgrep finding",
      path: "src/foo.ts",
    },
  ];
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "42",
    checkName: "semgrep",
    annotationDetails: "semgrep finding in src/foo.ts",
    annotations,
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    // Classification should be embedded in the rendered prompt.
    assertStringIncludes(result.value.prompt, "code-fix-required");
    assertStringIncludes(result.value.prompt, "semgrep");
    // Matched signals should be surfaced.
    assertStringIncludes(result.value.prompt, "check:semgrep");
    // The placeholder must be substituted, not retained verbatim.
    assertEquals(
      result.value.prompt.includes("{{FAILURE_CLASSIFICATION}}"),
      false,
    );
  }
});

Deno.test("ci_fix v4 - renderer substitutes FAILURE_CLASSIFICATION for timing", async () => {
  const annotations: CiAnnotation[] = [
    { message: "test timed out after 60s", title: "timeout", path: "" },
  ];
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "43",
    checkName: "test",
    annotationDetails: "test timed out",
    annotations,
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "timing");
    assertStringIncludes(result.value.prompt, "timed out");
  }
});

Deno.test("ci_fix v4 - renderer falls back to unknown when no annotations", async () => {
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "44",
    checkName: "build",
    annotationDetails: "no specific annotations",
    annotations: [],
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (result.ok) {
    assertStringIncludes(result.value.prompt, "unknown");
  }
});

Deno.test("formatCiFailureClassification - a history-rewrite failure tells the run not to rewrite (Issue #630)", () => {
  const block = formatCiFailureClassification({
    category: "history-rewrite-required",
    reason: "secret scan 'gitleaks' judges the commit range",
    signals: ["check:gitleaks"],
  });

  // Fix the content, commit normally — the worker does the rebuild, under
  // guards a coding run cannot check for itself.
  assertStringIncludes(block, "commit it normally");
  assertStringIncludes(block, "Do NOT run");
  assertStringIncludes(block, "--amend");
  // And never echo the value it just removed.
  assertStringIncludes(block, "Never");
  assertStringIncludes(block, "variable or file name");
});

Deno.test("formatCiFailureClassification - other categories carry no rebuild instruction", () => {
  const block = formatCiFailureClassification({
    category: "code-fix-required",
    reason: "semgrep finding",
    signals: ["check:semgrep"],
  });
  assertEquals(block.includes("Do NOT run"), false);
});

// --- Issue #1847: an advisory-clearing bump is exempt from the 24h floor ---

// --- Issue #2467: the supply-chain-gate inventory remedy is mechanical ---

/** Render the CI-fix prompt for a failing `supply-chain-gate` check. */
async function renderInventoryStaleFailure(): Promise<string> {
  const annotations: CiAnnotation[] = [
    {
      message:
        "[inventory-stale] dependency inventory is stale — run supply-chain-gate --write-inventory and commit the result",
      title: "supply-chain-gate",
      path: "docs/audits/dependency-inventory.md",
    },
  ];
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "45",
    checkName: "supply-chain-gate",
    annotationDetails: "inventory-stale in docs/audits/dependency-inventory.md",
    annotations,
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error("ci_fix prompt failed to build");
  return result.value.prompt;
}

Deno.test("ci_fix - an inventory-stale supply-chain-gate failure is fixed by regenerating the inventory (Issue #2467)", async () => {
  const prompt = (await renderInventoryStaleFailure()).toLowerCase();

  // The remedy: regenerate and commit, never hand-edit.
  assertStringIncludes(prompt, "supply-chain gate failures");
  assertStringIncludes(prompt, "--write-inventory");
  assertStringIncludes(prompt, "do not hand-edit");
  // Any other supply-chain finding is a real posture issue, never a suppress.
  assertStringIncludes(prompt, "never disable");
});

/** Render the CI-fix prompt for a failing `deno audit` check. */
async function renderAuditFailure(): Promise<string> {
  const annotations: CiAnnotation[] = [
    {
      message: "GHSA-xxxx-yyyy-zzzz: prototype pollution in left-pad",
      title: "deno audit",
      path: "deno.lock",
    },
  ];
  const result = await buildCiFixPrompt({
    repo: "owner/repo",
    prNumber: "45",
    checkName: "deno audit",
    annotationDetails: "GHSA-xxxx-yyyy-zzzz reported by deno audit",
    annotations,
    promptsDir: PROMPTS_DIR,
  });
  assertEquals(result.ok, true);
  if (!result.ok) throw new Error("ci_fix prompt failed to build");
  return result.value.prompt;
}

Deno.test("ci_fix - an advisory-clearing bump is exempt from the publish-age floor (Issue #1847)", async () => {
  const prompt = (await renderAuditFailure()).toLowerCase();

  // The exemption itself, and the audits it applies to.
  assertStringIncludes(prompt, "dependency audit failures");
  assertStringIncludes(prompt, "deno audit");
  assertStringIncludes(prompt, "cargo audit");
  assertStringIncludes(prompt, "ghsa");
  assertStringIncludes(prompt, "rustsec");
  assertStringIncludes(
    prompt,
    "goes to the newest release outside the 24h window that clears the advisory",
  );
  assertStringIncludes(
    prompt,
    "only when every release that clears the advisory is still inside the window is the fix applied regardless of its publish age",
  );

  // The mechanism: an explicit zero age for that package, never a config edit.
  assertStringIncludes(prompt, "--minimum-dependency-age=0");
  assertStringIncludes(prompt, "edit the repository's");
  assertStringIncludes(prompt, "minimumdependencyage` config or its `exclude`");
});

Deno.test("ci_fix - the advisory-clearing bump takes an aged fixed release over a newer in-window one (Issue #4471)", async () => {
  const prompt = await renderAuditFailure();

  // An older release outside the window is taken in preference to a newer one
  // still inside it; the zero age is only for the all-in-window case.
  assertStringIncludes(prompt, "a choice, not a necessity");
  assertStringIncludes(
    prompt,
    "when an older release outside the window already clears the same advisory",
  );
  assertStringIncludes(
    prompt,
    "Apply the zero age to the advisory-clearing version only, and only in that all-in-window case",
  );
  // The old unconditional sentence must not survive.
  assertEquals(
    prompt.includes(
      "**That advisory-clearing bump is applied regardless of the fixed version's publish age.**",
    ),
    false,
    "the unconditional advisory-clearing bump sentence remains in the prompt",
  );
});

Deno.test("ci_fix - the audit exemption names all three override mechanisms (Issue #1847)", async () => {
  const prompt = (await renderAuditFailure()).toLowerCase();

  // Direct bump; npm override for a transitive `deno.lock` entry; Cargo
  // `[patch]` or parent-crate bump for a transitive crate.
  assertStringIncludes(prompt, "direct bump");
  assertStringIncludes(prompt, "deno.json` or `package.json`");
  assertStringIncludes(prompt, "override");
  assertStringIncludes(prompt, "deno.lock");
  assertStringIncludes(prompt, "cargo.toml` `[patch]`");
  assertStringIncludes(prompt, "parent crate");

  // The reproduction loop is the audit command itself.
  assertStringIncludes(prompt, "red-capable command");
  assertStringIncludes(prompt, "watch it go green before you push");
});

Deno.test("ci_fix - every other bump in the run keeps the 24h floor (Issue #1847)", async () => {
  const prompt = await renderAuditFailure();

  assertStringIncludes(
    prompt,
    "Any other bump you make in the same run keeps the 24h floor",
  );
  assertStringIncludes(prompt, "VIBE_BUMP_QUARANTINE_HOURS");
  assertStringIncludes(
    prompt,
    "reaches no further than the advisory-clearing change",
  );

  // No template placeholder survives rendering.
  assertEquals(
    /\{\{[A-Z_]+\}\}/.test(prompt),
    false,
    "an unsubstituted {{PLACEHOLDER}} remains in the rendered prompt",
  );
});

Deno.test("ci_fix - the zero age covers the advisory-clearing version only, not the crates a parent bump pulls in (Issue #4437)", async () => {
  const prompt = await renderAuditFailure();

  assertStringIncludes(
    prompt,
    "Apply the zero age to the advisory-clearing version only",
  );
  assertStringIncludes(prompt, "cargo update -p <parent> --precise <version>");
  assertStringIncludes(
    prompt,
    "including the crates a parent bump pulls in, keeps the 24h floor",
  );
  assertStringIncludes(prompt, "cargo update -p <crate> --precise <version>");
  // PR #4450 review: a bare `Cargo.lock deno.lock` pathspec matches only the
  // root lockfiles, so a nested one (worker/deno/deno.lock, fuzz/Cargo.lock)
  // showed no moved version to hold. The wildcard pathspec reads every depth.
  assertStringIncludes(
    prompt,
    "run `git diff -- '*Cargo.lock' '*deno.lock'` from the repository root after the update",
  );
  assertStringIncludes(
    prompt,
    "so this reads every lockfile at any depth",
  );
  assertEquals(
    prompt.includes("read `git diff -- Cargo.lock deno.lock`"),
    false,
    "the root-only lockfile diff misses a nested lockfile",
  );
  // PR #4450 review: a required version with no release outside the window
  // (crates published together) cannot be held back, so it joins the
  // advisory-clearing change at its oldest satisfying release, named in the
  // reply, rather than leaving the advisory red until the window passes.
  assertStringIncludes(
    prompt,
    "Hold a version back only when an older release satisfies what the advisory-clearing version requires",
  );
  assertStringIncludes(
    prompt,
    "and that has no release outside the window meeting that requirement",
  );
  assertStringIncludes(
    prompt,
    "is part of the advisory-clearing change: take the oldest release that satisfies the requirement, and name it with its age in the `.pr_response_message` reply",
  );
  // The old sentence let "edit the manifest and lockfile directly" stand as
  // the whole mechanism for the exemption.
  assertEquals(
    prompt.includes("or by editing the manifest and lockfile directly"),
    false,
  );
});
