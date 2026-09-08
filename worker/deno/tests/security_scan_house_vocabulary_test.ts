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

/**
 * Issue #1614: a bounded sweep must consult prior sweep records before it
 * declares a chunk "not reached".
 *
 * The #1608 scan re-declared roughly a thousand already-recorded modules as
 * unswept because nothing in the template reads the records an earlier sweep
 * left behind. These tests pin the four literals that fix that — the Phase 1
 * inventory item, the read-only history commands it needs, the stopping
 * rule's drop order, and the two Phase 4 tracker line shapes — through the
 * real loader, so an edit that drops one fails here rather than in a filed
 * tracker.
 */

/** The Phase 1 prior-sweep-record step, literal by literal. */
const PRIOR_SWEEP_LITERALS = [
  "- **Prior sweep records**",
  "docs/audits/security-sweep-*.md",
  "sweep coverage ledger",
  "git log -1 --format=%H -- <record>",
  "git diff --name-only <commit> HEAD -- <tree>",
  "previously swept",
];

/** The two shapes a `## Chunks not reached` line may take. */
const TRACKER_LINE_SHAPES = [
  "- <n>. <chunk name> (exposure: <band>) — never recorded",
  "- <n>. <chunk name> (exposure: <band>) — recorded in <record path> at " +
  "<commit>; N modules changed since",
];

Deno.test("security_scan - Phase 1 inventories prior sweep records (Issue #1614)", async () => {
  const text = await securityScanPrompt();
  const missing = PRIOR_SWEEP_LITERALS.filter((l) => !text.includes(l));
  assertEquals(
    missing,
    [],
    "without these the scan cannot tell a swept tree from an unswept one:\n" +
      missing.join("\n"),
  );

  // Repo-agnostic: a repository with no records must inventory nothing
  // rather than treat the absent records as a blocker.
  assert(
    /no such records/i.test(text),
    "the step must say what a repository with no records does",
  );
});

Deno.test("security_scan - permits git log and git diff as read-only inspection (Issue #1614)", async () => {
  const text = await securityScanPrompt();
  assert(
    text.includes("`git log`, `git diff`"),
    "the No code execution permitted-tool list must name both commands, or " +
      "the Phase 1 prior-sweep-record step contradicts it",
  );
  assert(
    /`git log` and `git diff` are read-only/.test(text),
    "the constraint must say why they are permitted — read-only inspection",
  );
});

Deno.test("security_scan - the stopping rule drops previously swept chunks first (Issue #1614)", async () => {
  const text = await securityScanPrompt();
  assert(
    text.includes("previously-swept-and-unchanged"),
    "the stopping rule must name the chunks it drops first",
  );
  assert(
    text.includes("covered by <record> at <commit>"),
    "a chunk whose every module is previously swept is covered, not unreached",
  );
});

Deno.test("security_scan - the overflow tracker separates never-recorded from recorded chunks (Issue #1614)", async () => {
  const text = await securityScanPrompt();
  const missing = TRACKER_LINE_SHAPES.filter((l) => !text.includes(l));
  assertEquals(
    missing,
    [],
    "the `## Chunks not reached` section must offer both line shapes:\n" +
      missing.join("\n"),
  );
  assert(
    text.includes("counts only the never-recorded chunks"),
    "the tracker title's N must not count recorded, unchanged chunks",
  );
});
