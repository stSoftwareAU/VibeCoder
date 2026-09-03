/**
 * Issue #837: `security_scan` must speak the house vocabulary.
 *
 * The cross-prompt audit (#794) found the largest template in the scan family
 * drifting from its siblings: `VibeCoder` one-word in prose twice in a file
 * that says `Vibe Coder` elsewhere, `the executor` for the Deno harness every
 * sibling calls `the worker`, an H3 `Stable finding ID recipe` where nine
 * siblings use H2, an unhyphenated `idle task`, the generic
 * `<!-- finding-id: <id> -->` placeholder, and prose calling the suppression
 * grammar "shared" when three sibling keywords exist and only
 * `security-scan-ignore` fires here.
 *
 * These tests read whatever version resolves, so a later bump that
 * reintroduces a banned variant fails here rather than surfacing downstream
 * when a security_scan idle-task run misbehaves.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

async function latestSecurityScan(): Promise<string> {
  const result = await loadPrompt("security_scan", undefined, PROMPTS_DIR);
  assert(result.ok, "security_scan prompt failed to load");
  return result.value;
}

/**
 * Numbered lines with fenced blocks and inline code spans blanked out, so a
 * prose rule never fires on a shell snippet, a marker literal or a filename.
 */
function proseLines(text: string): Array<{ line: number; content: string }> {
  let inFence = false;
  return text.split("\n").map((raw, index) => {
    if (/^\s*```/.test(raw)) {
      inFence = !inFence;
      return { line: index + 1, content: "" };
    }
    if (inFence) return { line: index + 1, content: "" };
    return { line: index + 1, content: raw.replace(/`[^`]*`/g, "``") };
  });
}

/** Every prose line matching `pattern`, rendered as `line N: <content>`. */
async function proseHits(pattern: RegExp): Promise<string[]> {
  return proseLines(await latestSecurityScan())
    .filter((l) => pattern.test(l.content))
    .map((l) => `line ${l.line}: ${l.content.trim()}`);
}

Deno.test("security_scan - spells the product name Vibe Coder in prose (Issue #837)", async () => {
  // Repo slugs and URLs keep the one-word form; only prose is governed.
  const hits = await proseHits(/(?<![\w/])VibeCoder(?![\w/])/);
  assertEquals(
    hits,
    [],
    "the house form is `Vibe Coder` in prose:\n" + hits.join("\n"),
  );
  // Absence alone would also pass if the sentences were simply deleted.
  assert(
    (await latestSecurityScan()).includes("Vibe Coder"),
    "the two renamed sentences must survive, not be deleted",
  );
});

Deno.test("security_scan - calls the Deno harness the worker (Issue #837)", async () => {
  // Scoped to the harness noun: "executor" is a legitimate finding-class
  // word (thread-pool executor, statement executor) in a security prompt.
  const hits = await proseHits(/\b(?:the|The)\s+executors?\b/);
  assertEquals(
    hits,
    [],
    "the house noun for the harness is `the worker`:\n" + hits.join("\n"),
  );
  const text = await latestSecurityScan();
  assert(
    text.includes("The worker substitutes the values below"),
    "the Inputs preamble must name the worker, not be deleted",
  );
  assert(
    text.includes("the worker measures success by diffing"),
    "the Phase 4 preamble must name the worker, not be deleted",
  );
});

Deno.test("security_scan - uses ./quality.sh, hyphenated idle-task and capital Markdown (Issue #837)", async () => {
  const bareQuality = await proseHits(/(?<![./\w])quality\.sh/);
  assertEquals(
    bareQuality,
    [],
    "the house form is `./quality.sh`:\n" + bareQuality.join("\n"),
  );

  const idleTask = await proseHits(/\bidle task\b/i);
  assertEquals(
    idleTask,
    [],
    "the house form is `idle-task`:\n" + idleTask.join("\n"),
  );

  const lowerMarkdown = await proseHits(/(?<![\w-])markdown\b/);
  assertEquals(
    lowerMarkdown,
    [],
    "the house form is `Markdown` in prose:\n" + lowerMarkdown.join("\n"),
  );
});

Deno.test("security_scan - carries the family's shared headings (Issue #837)", async () => {
  const text = await latestSecurityScan();
  const expected = [
    "## Hard Constraints (apply to every phase)",
    // H2 in nine siblings; security_scan had it at H3.
    "## Stable finding ID recipe",
    "## Phase 4 — File one issue per finding (outcome-only)",
    "### For each surviving finding (skip silently if its id is in the " +
    "suppressed or known-open list)",
  ];
  const missing = expected.filter((heading) =>
    !text.includes(`\n${heading}\n`)
  );
  assertEquals(
    missing,
    [],
    "these house headings are absent:\n" + missing.join("\n"),
  );

  assert(
    !text.includes("\n### Stable finding ID recipe\n"),
    "the finding ID recipe must be H2, not H3",
  );
});

Deno.test("security_scan - uses the SEC-prefixed finding-id placeholder (Issue #837)", async () => {
  const text = await latestSecurityScan();
  assert(
    !text.includes("<!-- finding-id: <id> -->"),
    "the generic placeholder hides which family prefix this scan emits",
  );
  assert(
    text.includes("<!-- finding-id: SEC-… -->"),
    "the placeholder form is `<!-- finding-id: SEC-… -->`",
  );
  assert(
    text.includes("<!-- finding-id: SEC-0123456789ab -->"),
    "the rendered worked example keeps the twelve-hex-digit literal",
  );
});

Deno.test("security_scan - names its own suppression keyword rather than a shared grammar (Issue #837)", async () => {
  const text = await latestSecurityScan();
  assert(
    !/shared suppression-comment grammar/.test(text),
    'a maintainer reading "the shared suppression-comment grammar" cannot ' +
      "tell which of the three namespaced keywords to write",
  );
  assert(
    text.includes("`security-scan-ignore` keyword"),
    "the template must name its own keyword, `security-scan-ignore`",
  );
});

Deno.test("security_scan - cites the attribution footer one way (Issue #837)", async () => {
  const text = await latestSecurityScan();
  assert(
    text.includes("attribution footer** line from the Inputs section"),
    "the issue body's footer citation must read `from the Inputs section`",
  );
  assert(
    text.includes(
      "ends with the attribution footer line from the Inputs " +
        "section",
    ),
    "the overflow tracker's footer citation must read the same way",
  );
  assert(
    !text.includes("from the end of this prompt"),
    "`from the end of this prompt` is the drifted citation",
  );
});
