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
 * These tests read `prompts/security_scan/prompt.md` through the real
 * `loadPrompt`, so a later edit that reintroduces a banned variant fails here
 * rather than surfacing downstream when a security_scan idle-task run
 * misbehaves.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertThrows } from "@std/assert";
import { loadPrompt } from "../lib/prompt_manager.ts";
import {
  findSuppressions,
  type SupportedLanguage,
} from "../lib/suppression_comments.ts";
// `loadPrompt` below is given this directory explicitly, so resolution is
// pinned to *this* checkout (Issue #844) by that parameter rather than by
// clearing a worker host's PROMPTS_DIR. The constant comes from the
// side-effect-free module so this suite stays in the gate's parallel pass
// (Issues #880, #940).
import { REPO_ROOT } from "./support/repo_root.ts";
// The prose projection and its matcher moved to a shared module when the
// all-directory gate (Issue #840) needed the same two projections; a second
// copy would drift from this one the way the templates drifted from each
// other.
import { flattenProse, hitsIn } from "./support/prompt_prose.ts";

const PROMPTS_DIR = `${REPO_ROOT}prompts`;

async function securityScanPrompt(): Promise<string> {
  const result = await loadPrompt("security_scan", PROMPTS_DIR);
  assert(result.ok, "security_scan prompt failed to load");
  return result.value;
}

/** {@link hitsIn} over the live template. */
async function proseHits(pattern: RegExp): Promise<string[]> {
  return hitsIn(await securityScanPrompt(), pattern);
}

/** A marker line in the comment syntax its leading token implies. */
function languageFor(marker: string): SupportedLanguage {
  if (marker.startsWith("#")) return "py";
  return "ts";
}

/**
 * Positive control for the five prose bans below. Each of them asserts an
 * *empty* hit list, so a `prose()` that returned nothing — an odd fence count,
 * an unbalanced backtick — would turn all five green while checking nothing.
 * This test fails in that case: it pins that the projection keeps the bulk of
 * the template, that a banned phrase is found even when the hard wrap splits
 * it, and that a code span or fenced block is still exempt.
 */
Deno.test("security_scan - the prose matcher is not vacuous (Issue #837)", async () => {
  const template = await securityScanPrompt();
  const { flat } = flattenProse(template);
  assert(
    flat.length > template.length / 2,
    `prose projection kept only ${flat.length} of ${template.length} chars — ` +
      "the fence or code-span blanking has run away and the bans below would " +
      "pass vacuously",
  );

  const wrapped = [
    "A sentence naming the",
    "executor across the wrap.",
    "",
    "Prose citing `the executor` in a code span.",
    "",
    "```sh",
    "the executor",
    "```",
  ].join("\n");
  assertEquals(
    hitsIn(wrapped, /\b(?:the|The)\s+executors?\b/g),
    ["line 1: the executor"],
    "the matcher must catch a wrapped phrase and exempt code spans and fences",
  );

  // A two-word phrase must still be caught when the wrap falls between the
  // words — the case a pattern written with a literal space would miss.
  assertEquals(
    hitsIn("A scheduled idle\ntask runs nightly.", /\bidle\s+task\b/gi),
    ["line 1: idle task"],
    "`\\s+` between the words must match a newline",
  );

  // And a pattern that spells that space literally is rejected outright,
  // rather than silently under-matching the bans below.
  assertThrows(
    () => hitsIn("idle task", /\bidle task\b/g),
    Error,
    "literal space",
  );
});

Deno.test("security_scan - spells the product name Vibe Coder in prose (Issue #837)", async () => {
  // Repo slugs and URLs keep the one-word form; only prose is governed.
  const hits = await proseHits(/(?<![\w/])VibeCoder(?![\w/])/g);
  assertEquals(
    hits,
    [],
    "the house form is `Vibe Coder` in prose:\n" + hits.join("\n"),
  );
  // Absence alone would also pass if the sentences were simply deleted.
  assert(
    (await securityScanPrompt()).includes("Vibe Coder"),
    "the two renamed sentences must survive, not be deleted",
  );
});

Deno.test("security_scan - calls the Deno harness the worker (Issue #837)", async () => {
  // Scoped to the harness noun: "executor" is a legitimate finding-class
  // word (thread-pool executor, statement executor) in a security prompt.
  const hits = await proseHits(/\b(?:the|The)\s+executors?\b/g);
  assertEquals(
    hits,
    [],
    "the house noun for the harness is `the worker`:\n" + hits.join("\n"),
  );
  const text = await securityScanPrompt();
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
  const bareQuality = await proseHits(/(?<![./\w])quality\.sh/g);
  assertEquals(
    bareQuality,
    [],
    "the house form is `./quality.sh`:\n" + bareQuality.join("\n"),
  );

  const idleTask = await proseHits(/\bidle\s+task\b/gi);
  assertEquals(
    idleTask,
    [],
    "the house form is `idle-task`:\n" + idleTask.join("\n"),
  );

  const lowerMarkdown = await proseHits(/(?<![\w-])markdown\b/g);
  assertEquals(
    lowerMarkdown,
    [],
    "the house form is `Markdown` in prose:\n" + lowerMarkdown.join("\n"),
  );
});

Deno.test("security_scan - carries the family's shared headings (Issue #837)", async () => {
  const text = await securityScanPrompt();
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

Deno.test("security_scan - files its rationale under the family slot (Issue #837)", async () => {
  const text = await securityScanPrompt();
  // The issue-body rationale slot: every sibling scan writes the reader's
  // stake under `## Why this matters`, and a reader scanning filed issues
  // across scans should not have to know which scan wrote the body.
  assert(
    !text.includes("## Why it is a bug"),
    "`## Why it is a bug` names the verdict, not the reader's stake",
  );
  // Both the prose listing the body's sections and the rendered worked
  // example must carry the house slot, so the shape and its example agree.
  assertEquals(
    [...text.matchAll(/## Why this matters/g)].length,
    2,
    "the section list and the rendered example must both name the slot",
  );
});

Deno.test("security_scan - uses the SEC-prefixed finding-id placeholder (Issue #837)", async () => {
  const text = await securityScanPrompt();
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
  const text = await securityScanPrompt();
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

/**
 * Candidate SEC- markers spanning every comment syntax a monitored repo
 * writes, each paired with the keyword a reader would have to write. Which
 * of them count is decided by the real parser below, never by this list —
 * drop a form from `suppression_comments.ts` and the template stops being
 * required to name its keyword.
 */
const CANDIDATE_MARKERS: ReadonlyArray<{ marker: string; keyword: string }> = [
  {
    marker: "# security-scan-ignore: SEC-0123456789ab",
    keyword: "security-scan-ignore",
  },
  {
    marker: "// security-scan-ignore: SEC-0123456789ab",
    keyword: "security-scan-ignore",
  },
  {
    marker: "/* security-scan-ignore: SEC-0123456789ab */",
    keyword: "security-scan-ignore",
  },
  { marker: "# noqa: SEC-0123456789ab", keyword: "noqa" },
  {
    marker: "// eslint-disable-next-line SEC-0123456789ab",
    keyword: "eslint-disable-next-line",
  },
] as const;

/** True when `worker/deno/lib/suppression_comments.ts` parses the marker. */
function parserRecognises(marker: string): boolean {
  const line = `${marker} author=someone expires=2999-01-01 because`;
  return findSuppressions(line, languageFor(marker))
    .some((record) => record.family === "security-scan");
}

/** Every marker literal the template spells out in a code span. */
function markerLiteralsIn(text: string): string[] {
  return [...text.matchAll(/`([^`]*SEC-…[^`]*)`/g)]
    .map((m) => m[1] ?? "")
    .filter((span) => /^\s*(#|\/\/|\/\*)/.test(span))
    .map((span) => span.replace("SEC-…", "SEC-0123456789ab").trim());
}

Deno.test("security_scan - the suppression markers it names match the parser (Issue #837)", async () => {
  const text = await securityScanPrompt();

  // Naming its own keyword must not narrow the honoured set: a keyword the
  // parser accepts but the template never names is a governed waiver the
  // run silently re-files.
  const omitted = [
    ...new Set(
      CANDIDATE_MARKERS
        .filter(({ marker }) => parserRecognises(marker))
        .map(({ keyword }) => keyword)
        .filter((keyword) => !text.includes(keyword)),
    ),
  ];
  assertEquals(
    omitted,
    [],
    "the parser honours these SEC- suppression keywords, so the template " +
      "must name them or a waived finding is re-filed:\n" + omitted.join("\n"),
  );

  // And the reverse: a literal the template spells out but the parser cannot
  // see makes the run skip a finding the deterministic check still flags —
  // the divergence the step's own "cannot drift" promise rules out.
  const literals = markerLiteralsIn(text);
  assert(literals.length > 0, "no SEC- marker literal found — matcher stale");
  const unrecognised = literals.filter((m) => !parserRecognises(m));
  assertEquals(
    unrecognised,
    [],
    "the template spells out marker forms the parser does not recognise:\n" +
      unrecognised.join("\n"),
  );
});

Deno.test("security_scan - cites the attribution footer one way (Issue #837)", async () => {
  const text = await securityScanPrompt();
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
