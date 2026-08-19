/**
 * Regression tests for Issue #3601 — README.md, CODING-STANDARDS.md and
 * CONTRIBUTING.md still enumerated `shellcheck` as a check the local quality
 * gate runs, and never mentioned `deno fmt --check`.
 *
 * Shellcheck was removed from the worker's gate by Issue #3129 (bash linting is
 * owned by each target repo's own CI) and `deno fmt --check` was added by Issue
 * #2940. These tests tie the prose back to the real behaviour:
 *   - the check names `runQualityGate` actually records, and
 *   - the tools `checkAllPrerequisites` actually requires.
 *
 * Australian English spelling used throughout (behaviour, enumerated, etc.).
 */

import { assert } from "@std/assert";
import { runQualityGate } from "../lib/quality_gate.ts";
import { checkAllPrerequisites } from "../setup/prerequisites.ts";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(repoPath(relative));
}

/**
 * The blank-line-delimited paragraph (or list block) containing `needle`.
 *
 * Scoping each assertion to the paragraph that enumerates the gate keeps
 * legitimate shellcheck mentions elsewhere in the same document (e.g. the
 * bash-syntax audit scan, which really does check target repos for a
 * shellcheck CI gate) out of the comparison.
 */
function paragraphContaining(markdown: string, needle: string): string {
  const paragraph = markdown.split(/\n\s*\n/).find((p) => p.includes(needle));
  assert(
    paragraph !== undefined,
    `Expected to find a paragraph containing ${JSON.stringify(needle)}`,
  );
  return paragraph;
}

/**
 * The single sentence containing `needle`.
 *
 * The enumeration sentence is what must match the gate; a neighbouring
 * sentence may legitimately mention shellcheck to explain that it is *not*
 * part of the gate.
 */
function sentenceContaining(text: string, needle: string): string {
  const sentence = text
    .replace(/\n/g, " ")
    .split(/(?<=\.)\s+/)
    .find((s) => s.includes(needle));
  assert(
    sentence !== undefined,
    `Expected to find a sentence containing ${JSON.stringify(needle)}`,
  );
  return sentence;
}

/** The body of the `## <heading>` section, up to the next `## ` heading. */
function section(markdown: string, heading: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("## ") && line.includes(heading)
  );
  assert(start !== -1, `Expected a "## ...${heading}..." heading`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end === -1 ? rest : rest.slice(0, end)).join("\n");
}

/** Check names the real gate records for a minimal repo. */
async function gateCheckNames(): Promise<string[]> {
  const tmpDir = await Deno.makeTempDir();
  try {
    // A script with an unquoted expansion — shellcheck would flag SC2086.
    await Deno.writeTextFile(
      `${tmpDir}/script.sh`,
      "#!/bin/bash\nls $unquoted\n",
    );
    const result = await runQualityGate({
      scriptDir: tmpDir,
      options: { strict: false, sequential: false, validatePrompts: false },
    });
    assert(result.ok, "quality gate should return a result");
    return result.value.checks.map((check) => check.name);
  } finally {
    await Deno.remove(tmpDir, { recursive: true });
  }
}

Deno.test("quality gate - records no shellcheck check (Issue #3129)", async () => {
  const names = await gateCheckNames();
  assert(
    !names.some((name) => /shellcheck/i.test(name)),
    `Gate must not run shellcheck (Issue #3129); recorded: ${names.join(", ")}`,
  );
});

Deno.test("quality gate - records a deno fmt check (Issue #2940)", async () => {
  const names = await gateCheckNames();
  assert(
    names.includes("deno fmt"),
    `Gate must run deno fmt --check; recorded: ${names.join(", ")}`,
  );
});

Deno.test("README - quality-gate enumeration matches the real gate", async () => {
  const paragraph = paragraphContaining(
    await read("README.md"),
    "every PR runs the full quality gate",
  );
  assert(
    !/shellcheck/i.test(paragraph),
    "README must not list shellcheck as a quality-gate check (Issue #3129)",
  );
  assert(
    paragraph.includes("deno fmt --check"),
    "README must list `deno fmt --check` as a quality-gate check (Issue #2940)",
  );
});

Deno.test("CODING-STANDARDS - quality-gate enumeration matches the real gate", async () => {
  const enumeration = sentenceContaining(
    paragraphContaining(await read("CODING-STANDARDS.md"), "quality.sh"),
    "worker/deno/quality.ts",
  );
  assert(
    !/shellcheck/i.test(enumeration),
    "CODING-STANDARDS must not list shellcheck as a gate check (Issue #3129)",
  );
  assert(
    enumeration.includes("deno fmt"),
    "CODING-STANDARDS must list `deno fmt --check` (Issue #2940)",
  );
});

Deno.test("CONTRIBUTING - local quality gate enumeration matches the real gate", async () => {
  const enumeration = sentenceContaining(
    await read("CONTRIBUTING.md"),
    "delegates to `worker/deno/quality.ts`",
  );
  assert(
    !/shellcheck/i.test(enumeration),
    "CONTRIBUTING must not list shellcheck among `./quality.sh` checks",
  );
  assert(
    enumeration.includes("deno fmt"),
    "CONTRIBUTING must list `deno fmt --check` (Issue #2940)",
  );
});

Deno.test("README - shellcheck is not claimed to be a required prerequisite", async () => {
  const required = (await checkAllPrerequisites({ skipAuthCheck: true }))
    .results.map((r) => r.tool);
  assert(
    !required.includes("shellcheck"),
    "setup does not check for shellcheck, so the docs must not require it",
  );

  const requirements = section(await read("README.md"), "Requirements");
  assert(
    !/required by quality gate/i.test(requirements),
    "README must not describe shellcheck as required by the quality gate",
  );
  assert(
    !/setup can install/i.test(requirements),
    "setup does not install shellcheck, so the README must not claim it does",
  );
});
