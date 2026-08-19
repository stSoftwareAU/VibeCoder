/**
 * Tests for Issue #2282 — the root instruction documents must not hard-code
 * stale prompt version numbers.
 *
 * Issue #3419 consolidated the former provider-specific `CLAUDE.md` into
 * `CODING-STANDARDS.md` + `DESIGN-PRINCIPLES.md`, leaving `AGENTS.md` a thin
 * pointer. These files are injected into worker runs as system context. Any
 * literal `prompts/<type>/vN.md` reference inside them ends up in the
 * LLM's context for every task and misleads the worker into editing
 * stale prompt files.
 *
 * The convention: refer to prompt templates by directory
 * (`prompts/coding_guidelines/`) rather than by version number. The
 * worker always loads the latest version at runtime. An "onward"
 * statement that intentionally pins the introduction version of a
 * feature should still reference the directory and add textual
 * "from vN onward" wording rather than a literal `vN.md` filename.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assert } from "@std/assert";

// Match `prompts/<some_dir>/vNN.md` or `<some_dir>/vNN.md` where the
// path component looks like a known prompt template directory. The
// project keeps prompt directories under `prompts/`; this regex catches
// both fully-qualified and bare references that humans naturally write.
const PROMPT_VERSION_PATTERN =
  /(?:prompts\/)?(?:coding_guidelines|pr_feedback|ci_fix|issue|best_practices|security_scan|refinement)\/v\d+\.md/g;

async function readDocFile(relativePath: string): Promise<string> {
  // Tests run from the repo root via `quality.sh` / `deno test`; the
  // worker/deno/tests files reach the repo root by walking up two
  // directories from `worker/deno/`.
  const url = new URL(`../../../${relativePath}`, import.meta.url);
  return await Deno.readTextFile(url);
}

// Issue #3419 retired the provider-specific `CLAUDE.md`. The root instruction
// documents it consolidated into (`CODING-STANDARDS.md`, `DESIGN-PRINCIPLES.md`)
// are injected as worker context and are guarded here in its place.
for (const doc of ["CODING-STANDARDS.md", "DESIGN-PRINCIPLES.md"]) {
  Deno.test(`${doc} has no hard-coded prompts/<type>/vN.md references (Issue #2282)`, async () => {
    const text = await readDocFile(doc);
    const matches = text.match(PROMPT_VERSION_PATTERN) ?? [];
    assert(
      matches.length === 0,
      `${doc} still references stale prompt versions: ${matches.join(", ")}. ` +
        `Refer to the directory (e.g. prompts/coding_guidelines/) instead of a versioned file. ` +
        `For features introduced at a specific version, use textual "from vN onward" wording.`,
    );
  });
}

Deno.test("AGENTS.md has no hard-coded prompts/<type>/vN.md references (Issue #2282)", async () => {
  const text = await readDocFile("AGENTS.md");
  const matches = text.match(PROMPT_VERSION_PATTERN) ?? [];
  assert(
    matches.length === 0,
    `AGENTS.md still references stale prompt versions: ${
      matches.join(", ")
    }. ` +
      `Refer to the directory (e.g. prompts/coding_guidelines/) instead of a versioned file.`,
  );
});

// Note (Issue #3116): the former "CLAUDE.md documents the prompt-version
// convention" test was deleted. It asserted that CLAUDE.md contained the
// phrase "latest version" and a `prompts/coding_guidelines/` reference — a
// pure prose-presence grep (WHAT-vs-HOW anti-pattern 2). It guarded exact
// documentation wording, not observable behaviour, so it broke on harmless
// rewordings (e.g. "newest version") and passed for the wrong reasons. The
// two negative-match assertions above are retained: they catch a genuine
// regression — a re-introduced stale `prompts/<type>/vN.md` filename.
