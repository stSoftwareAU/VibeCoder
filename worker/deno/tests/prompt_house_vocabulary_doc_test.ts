/**
 * Tests for the prompt house vocabulary document (Issue #834).
 *
 * `docs/PROMPT-HOUSE-VOCABULARY.md` records one house form per drifted
 * term and per shared section heading across the prompt set, so a
 * maintainer bumping a template picks the agreed form instead of
 * re-litigating it — 33 templates each made that call independently,
 * which is why #794 exists.
 *
 * These tests pin the properties that make the document usable as a
 * canon rather than as an essay:
 *
 *   - every recorded row carries a house form, its banned variants and a
 *     rationale, so nothing is asserted without a reason;
 *   - the family memberships it declares partition the prompt directories
 *     that actually exist on disk, resolved through `getLatestVersion()`
 *     and `loadPrompt()` — never a hard-coded `vN`;
 *   - the scan-family membership rule it states really selects the set it
 *     claims, so the recorded count cannot go stale silently;
 *   - the suppression keywords it records match what
 *     `worker/deno/lib/suppression_comments.ts` actually parses, checked
 *     by parsing a marker of each keyword; and
 *   - the two pointer documents link to it.
 *
 * Enforcement of the canon *against the templates* is a separate test
 * (#840); this file only guarantees the canon itself is complete,
 * internally consistent and true of the code it cites.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { getLatestVersion, loadPrompt } from "../lib/prompt_manager.ts";
import { findSuppressions } from "../lib/suppression_comments.ts";

/** Resolve the repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

const VOCABULARY_PATH = "docs/PROMPT-HOUSE-VOCABULARY.md";
const PROMPTS_DIR = `${repoRoot()}prompts`;

async function readVocabulary(): Promise<string> {
  return await Deno.readTextFile(`${repoRoot()}${VOCABULARY_PATH}`);
}

/** Parse every Markdown table row in `markdown` into trimmed cell arrays. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
}

/** Extract the body of the `## ` section whose heading contains `title`. */
function section(markdown: string, title: string): string {
  const lines = markdown.split("\n");
  const start = lines.findIndex((line) =>
    line.startsWith("## ") && line.slice(3).includes(title)
  );
  assert(start >= 0, `missing section heading containing "${title}"`);
  const rest = lines.slice(start + 1);
  const end = rest.findIndex((line) => line.startsWith("## "));
  return (end < 0 ? rest : rest.slice(0, end)).join("\n");
}

/** A canon row: house form, the variants it bans, and why it won. */
interface CanonRow {
  houseForm: string;
  banned: string;
  rationale: string;
}

/**
 * Canon rows of a four-column table — `Concept | House form | Banned
 * variants | Why`. The header row and any separator are dropped.
 */
function canonRows(body: string): CanonRow[] {
  return tableRows(body)
    .filter((cells) => cells.length === 4 && !/^house form$/i.test(cells[1]!))
    .map((cells) => ({
      houseForm: cells[1]!,
      banned: cells[2]!,
      rationale: cells[3]!,
    }));
}

/**
 * Fail unless the row states a reason. The canon exists to record *why*
 * a form won, so an empty or placeholder `Why` cell is a row that cannot
 * settle the next argument about it.
 */
function assertHasRationale(row: CanonRow): void {
  const rationale = row.rationale.trim();
  assert(
    rationale !== "" && !/^[-—–]$/.test(rationale),
    `house form ${row.houseForm} carries no rationale`,
  );
}

/** Find the row whose house-form cell contains `houseForm`. */
function rowFor(rows: CanonRow[], houseForm: string): CanonRow {
  const row = rows.find((candidate) => candidate.houseForm.includes(houseForm));
  if (!row) throw new Error(`no canon row records the house form ${houseForm}`);
  return row;
}

/**
 * Every prompt directory on disk. The set is read from the filesystem so
 * a new prompt type joins the check the day it lands.
 */
function promptDirectories(): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(PROMPTS_DIR)) {
    if (entry.isDirectory) names.push(entry.name);
  }
  return names.sort();
}

/** Directory names in code spans within `body`, deduplicated and sorted. */
function citedDirectories(body: string): string[] {
  const cited = new Set<string>();
  for (const match of body.matchAll(/`prompts\/([a-z][a-z0-9_-]*)\/`/g)) {
    cited.add(match[1]!);
  }
  return [...cited].sort();
}

/** The latest template of every prompt directory, keyed by directory. */
async function latestTemplates(): Promise<Map<string, string>> {
  const templates = new Map<string, string>();
  for (const name of promptDirectories()) {
    const latest = await getLatestVersion(name, PROMPTS_DIR);
    if (!latest.ok) throw new Error(`no version found for prompts/${name}/`);
    const template = await loadPrompt(name, latest.value, PROMPTS_DIR);
    if (!template.ok) {
      throw new Error(`could not load prompts/${name}/${latest.value}.md`);
    }
    templates.set(name, template.value);
  }
  return templates;
}

// ---------------------------------------------------------------------------
// Terminology
// ---------------------------------------------------------------------------

/** House form → a banned variant that must be recorded against it. */
const TERMINOLOGY: Array<[string, string]> = [
  ["`Vibe Coder`", "VibeCoder"],
  ["`the worker`", "the executor"],
  ["`./quality.sh`", "quality.sh"],
  ["`idle-task`", "idle task"],
  ["`Markdown`", "markdown"],
  ["`senior engineer`", "experienced software engineer"],
];

Deno.test("terminology table records every drifted term", async () => {
  const rows = canonRows(section(await readVocabulary(), "Terminology"));

  for (const [houseForm, banned] of TERMINOLOGY) {
    const row = rowFor(rows, houseForm);
    assert(
      row.banned.includes(banned),
      `${houseForm} does not ban "${banned}"`,
    );
  }
});

Deno.test("every terminology row explains why the form won", async () => {
  const rows = canonRows(section(await readVocabulary(), "Terminology"));

  assertEquals(rows.length, TERMINOLOGY.length);
  for (const row of rows) assertHasRationale(row);
});

Deno.test("the product-name row exempts the repo slug", async () => {
  const row = rowFor(
    canonRows(section(await readVocabulary(), "Terminology")),
    "`Vibe Coder`",
  );

  assert(
    row.rationale.includes("stSoftwareAU/VibeCoder"),
    "the repo-slug exemption is not recorded",
  );
});

// ---------------------------------------------------------------------------
// Shared headings
// ---------------------------------------------------------------------------

/** Scan-family house heading → the variants it must ban. */
const SCAN_HEADINGS: Array<[string, string[]]> = [
  ["`## Hard Constraints (apply to every phase)`", [
    "## Hard constraints (apply to every phase)",
    "## Hard Constraints (apply throughout)",
  ]],
  ["`## Stable finding ID recipe`", ["H3"]],
  [
    "`### For each surviving finding (skip silently if its id is in the suppressed or known-open list)`",
    ["### For each surviving finding", "### Filing the finding"],
  ],
  ["`## Suggested fix`", ["## Suggested action", "## Suggested replacement"]],
  ["`## Why this matters`", [
    "## Why this is a candidate",
    "## Why this is flagged",
    "## Why it is safe to remove",
  ]],
  ["(outcome-only)", ["unsuffixed"]],
];

/** Interactive-family house heading → the variants it must ban. */
const INTERACTIVE_HEADINGS: Array<[string, string[]]> = [
  ["`## <X> Mode`", ["no mode heading"]],
  ["`## Project Guidelines`", [
    "## Coding Guidelines",
    "## Guidelines",
    "### Guidelines",
  ]],
  ["`### Worked Examples`", [
    "## Worked Examples",
    "### Worked examples",
    "### Worked cases",
    "### Examples",
  ]],
];

Deno.test("scan-family headings record house form and banned variants", async () => {
  const rows = canonRows(
    section(await readVocabulary(), "Shared headings — scan family"),
  );

  assertEquals(rows.length, SCAN_HEADINGS.length);
  for (const [houseForm, banned] of SCAN_HEADINGS) {
    const row = rowFor(rows, houseForm);
    for (const variant of banned) {
      assert(
        row.banned.includes(variant),
        `${houseForm} does not ban "${variant}"`,
      );
    }
    assertHasRationale(row);
  }
});

Deno.test("interactive-family headings record house form and banned variants", async () => {
  const rows = canonRows(
    section(await readVocabulary(), "Shared headings — interactive family"),
  );

  assertEquals(rows.length, INTERACTIVE_HEADINGS.length);
  for (const [houseForm, banned] of INTERACTIVE_HEADINGS) {
    const row = rowFor(rows, houseForm);
    for (const variant of banned) {
      assert(
        row.banned.includes(variant),
        `${houseForm} does not ban "${variant}"`,
      );
    }
    assertHasRationale(row);
  }
});

Deno.test("the prompt-level scan section is protected from the rationale slot", async () => {
  const body = section(
    await readVocabulary(),
    "Shared headings — scan family",
  );

  assert(
    body.includes("## Why this scan exists"),
    "the document does not record that `## Why this scan exists` stays",
  );
});

// ---------------------------------------------------------------------------
// Families — the memberships the canon is scoped to
// ---------------------------------------------------------------------------

Deno.test("the families partition every prompt directory on disk", async () => {
  const body = section(await readVocabulary(), "Families");
  const cited = citedDirectories(body);

  assertEquals(
    cited,
    promptDirectories(),
    "every prompts/<type>/ directory must be classified into exactly one " +
      "family in docs/PROMPT-HOUSE-VOCABULARY.md",
  );
});

Deno.test("the scan-family rule selects the membership the document records", async () => {
  const body = section(await readVocabulary(), "Families");
  const recorded = /scan family is currently \*\*(\d+)\*\*/.exec(body)?.[1];
  assert(recorded, "the document records no scan-family size");

  const templates = await latestTemplates();
  const onDisk = [...templates.entries()]
    .filter(([, template]) => template.includes("Stable finding ID recipe"))
    .map(([name]) => name);

  assertEquals(
    onDisk.length,
    Number(recorded),
    `the scan family holds ${onDisk.length} directories on disk; ` +
      `docs/PROMPT-HOUSE-VOCABULARY.md records ${recorded}`,
  );
});

// ---------------------------------------------------------------------------
// Literals
// ---------------------------------------------------------------------------

Deno.test("the attribution footer is recorded with one citation", async () => {
  const body = section(await readVocabulary(), "Literals");

  assert(
    body.includes("from the Inputs section"),
    "the house citation of the attribution footer is not recorded",
  );
  for (const banned of ["from the end of this prompt", "Phase 4"]) {
    assert(body.includes(banned), `the "${banned}" citation is not banned`);
  }
});

Deno.test("the finding-id placeholder keeps its family prefix", async () => {
  const body = section(await readVocabulary(), "Literals");

  for (
    const form of [
      "<!-- finding-id: BP-… -->",
      "<!-- finding-id: SEC-… -->",
      "<!-- finding-id: <id> -->",
      "BP-0123456789ab",
    ]
  ) {
    assert(body.includes(form), `the ${form} form is not recorded`);
  }
});

// ---------------------------------------------------------------------------
// Suppression keywords — the canon must match the parser
// ---------------------------------------------------------------------------

/** Keyword → the finding family and id prefix the parser gives it. */
const SUPPRESSION_KEYWORDS: Array<[string, string, string]> = [
  ["security-scan-ignore", "security-scan", "SEC-0123456789ab"],
  ["best-practice-ignore", "best-practices", "BP-0123456789ab"],
  ["orphan-deps-ignore", "best-practices", "BP-0123456789ab"],
];

Deno.test("the suppression section names all three namespaced keywords", async () => {
  const body = section(await readVocabulary(), "Suppression keywords");

  for (const [keyword] of SUPPRESSION_KEYWORDS) {
    assert(body.includes(keyword), `the ${keyword} keyword is not recorded`);
  }
  assert(
    body.includes("shared suppression-comment grammar"),
    "the banned prose is not recorded",
  );
  assert(
    body.includes("worker/deno/lib/suppression_comments.ts"),
    "the document does not cite the parser the keywords match",
  );
});

Deno.test("each recorded keyword parses to the family the document claims", () => {
  for (const [keyword, family, id] of SUPPRESSION_KEYWORDS) {
    const records = findSuppressions(
      `// ${keyword}: ${id} — recorded canon check`,
      "ts",
    );

    assertEquals(records.length, 1, `${keyword} did not parse`);
    assertEquals(records[0]!.family, family);
    assertEquals(records[0]!.id, id);
  }
});

// ---------------------------------------------------------------------------
// Deliberate exceptions
// ---------------------------------------------------------------------------

Deno.test("the deliberate exceptions name the checklist's American spellings", async () => {
  const body = section(
    await readVocabulary(),
    "Recorded deliberate exceptions",
  );

  for (const spelling of ["Optimize", "Minimizing"]) {
    assert(
      body.includes(spelling),
      `the deliberate ${spelling} exception is not recorded`,
    );
  }
  assert(
    body.includes("docs/PROMPT-BEST-PRACTICES-CHECKLIST.md"),
    "the exception does not name the document it applies to",
  );
});

Deno.test("the recorded American spellings still exist in the checklist", async () => {
  const checklist = await Deno.readTextFile(
    `${repoRoot()}docs/PROMPT-BEST-PRACTICES-CHECKLIST.md`,
  );

  for (const spelling of ["Optimize", "Minimizing"]) {
    assert(
      checklist.includes(spelling),
      `the checklist no longer carries "${spelling}" — the recorded ` +
        "exception is stale",
    );
  }
});

Deno.test("Australian English is recorded as the rule everywhere else", async () => {
  const body = section(
    await readVocabulary(),
    "Recorded deliberate exceptions",
  );

  assert(
    /Australian English/.test(body),
    "the Australian English rule is not recorded beside the exceptions",
  );
});

// ---------------------------------------------------------------------------
// Pointers
// ---------------------------------------------------------------------------

Deno.test("the pointer documents link to the vocabulary", async () => {
  for (
    const pointer of [
      "docs/PROMPTS.md",
      "docs/PROMPT-BEST-PRACTICES-CHECKLIST.md",
    ]
  ) {
    const content = await Deno.readTextFile(`${repoRoot()}${pointer}`);
    assert(
      content.includes("PROMPT-HOUSE-VOCABULARY.md"),
      `${pointer} does not link ${VOCABULARY_PATH}`,
    );
  }
});
