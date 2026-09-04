/**
 * The prompt house vocabulary, pinned across every template (Issue #840).
 *
 * Thirty-three prompt directories each named the same concepts
 * independently, so the product picked up two names in prose, the Deno
 * harness two, "Worked Examples" five, and the scan family's shared section
 * headings anywhere between two and five spellings apiece — the drift the
 * cross-prompt audit catalogued (Issue #794) and the sweeps of #835–#839
 * fixed. Fixing the wording was the cheap half. Without a gate the list
 * regrows one prompt bump at a time, which is how it grew the first time.
 *
 * `docs/PROMPT-HOUSE-VOCABULARY.md` (Issue #834) is the canon: one house form
 * per term and per shared section heading, with the evidence for why each
 * form won. That document is the source of truth and this file is its
 * enforcement — every rule below is a row of it, and a row changes there
 * first.
 *
 * Three properties keep the gate honest as the prompt set changes:
 *
 *   - **Every directory, always.** The template set is read off disk through
 *     the real `loadPrompt()`, so a new prompt directory is governed the day
 *     it lands. Issue #844 removed the `vN.md` scheme, so "the latest
 *     template" is that directory's one `prompt.md` — there is no version to
 *     hard-code and none is written here.
 *   - **Families computed, not listed.** The scan family is every template
 *     carrying a `Stable finding ID recipe` section; the interactive family
 *     is every non-scan template that carries placeholders of its own and
 *     opens at H2. Both are cross-checked against the canon's Families
 *     table, so a directory that escapes both fails loudly instead of
 *     silently losing its heading rules.
 *   - **No waiver list.** There is no allowlist of "not yet swept" files. If
 *     a sweep has not landed, this test fails — that is the signal.
 *
 * Every failure names the file, the line and the house form to use, because
 * the person who hits it is bumping one template at 2am and should not have
 * to read #794 to fix it.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt, PROMPT_FILENAME } from "../lib/prompt_manager.ts";
import { findSuppressions } from "../lib/suppression_comments.ts";
// Importing this pins prompt resolution to *this* checkout (Issue #844), so a
// worker host's PROMPTS_DIR cannot point the gate at another tree. REPO_ROOT
// is the decoded form of `new URL("../../../", import.meta.url).pathname`.
import { REPO_ROOT } from "./support/repo_prompts.ts";
import {
  fencedBlocks,
  flattenProse,
  type Heading,
  headings,
  hitsIn,
} from "./support/prompt_prose.ts";

const PROMPTS_DIR = `${REPO_ROOT}prompts`;
const VOCABULARY_PATH = `${REPO_ROOT}docs/PROMPT-HOUSE-VOCABULARY.md`;

// ---------------------------------------------------------------------------
// Reading the templates
// ---------------------------------------------------------------------------

/** Every prompt directory that ships a template, in name order. */
async function promptDirectories(): Promise<string[]> {
  const names: string[] = [];
  for await (const entry of Deno.readDir(PROMPTS_DIR)) {
    if (!entry.isDirectory) continue;
    const template = `${PROMPTS_DIR}/${entry.name}/${PROMPT_FILENAME}`;
    try {
      await Deno.stat(template);
      names.push(entry.name);
    } catch (error) {
      // A directory with no template is not a prompt type, and nothing to
      // govern. Anything else — a permissions or I/O fault — would silently
      // drop a directory out of a gate whose whole property is that it
      // covers every one of them, so it is raised rather than swallowed.
      if (!(error instanceof Deno.errors.NotFound)) {
        throw new Error(`cannot read ${template}: ${String(error)}`);
      }
    }
  }
  return names.sort();
}

let cache: Map<string, string> | null = null;

/**
 * Each directory's shipped template, keyed by directory name and read through
 * the real `loadPrompt()`.
 *
 * @returns Directory name to template text
 */
async function templates(): Promise<Map<string, string>> {
  if (cache) return cache;
  const loaded = new Map<string, string>();
  for (const name of await promptDirectories()) {
    const result = await loadPrompt(name, PROMPTS_DIR);
    assert(result.ok, `prompts/${name}/${PROMPT_FILENAME} failed to load`);
    loaded.set(name, result.value);
  }
  cache = loaded;
  return loaded;
}

/** How a violation cites the template it lives in. */
function fileOf(name: string): string {
  return `prompts/${name}/${PROMPT_FILENAME}`;
}

// ---------------------------------------------------------------------------
// Families — computed from what a template is
// ---------------------------------------------------------------------------

/**
 * A scan sweeps a repository, dedupes findings against filed issues and files
 * one issue per surviving finding — and every one of them carries the recipe
 * that makes a finding's id stable across runs. That section is the
 * membership rule the canon records, so a sixteenth scan is in the family the
 * day its template lands.
 */
function isScan(text: string): boolean {
  return text.includes("Stable finding ID recipe");
}

/**
 * An injected fragment is substituted into another template rather than run
 * on its own, so it is never rendered with inputs of its own and carries no
 * `{{PLACEHOLDER}}`.
 */
function isFragment(text: string): boolean {
  return !/\{\{[A-Z_]+\}\}/.test(text);
}

/** The level of the template's first heading, or 0 if it has none. */
function openingLevel(text: string): number {
  const first = /^\s*(#{1,6})\s+\S/m.exec(text);
  return first ? first[1]!.length : 0;
}

/**
 * An interactive prompt drives one worker turn against one named target — an
 * issue, a PR, a repository set-up task — rather than sweeping for findings.
 * It is not a scan, it renders inputs of its own (so it is not a fragment),
 * and it opens with a mode heading at H2 rather than an audit title at H1,
 * which is what separates it from the lightweight audits.
 */
function isInteractive(text: string): boolean {
  return !isScan(text) && !isFragment(text) && openingLevel(text) === 2;
}

/** The directories whose template satisfies `predicate`, in name order. */
async function family(
  predicate: (text: string) => boolean,
): Promise<string[]> {
  const members: string[] = [];
  for (const [name, text] of await templates()) {
    if (predicate(text)) members.push(name);
  }
  return members.sort();
}

/** The `prompts/<name>/` directories a slab of the canon cites, deduped. */
function citedDirectories(markdown: string): string[] {
  const names = new Set<string>();
  for (const match of markdown.matchAll(/`prompts\/([a-z0-9_-]+)\/`/gi)) {
    names.add(match[1]!);
  }
  return [...names].sort();
}

// ---------------------------------------------------------------------------
// Rules
// ---------------------------------------------------------------------------

/**
 * One shared section, as the canon records it.
 *
 * `claims` decides which headings *are* this section — house form and every
 * drifted spelling alike — so a variant nobody has invented yet is caught
 * too, not just the ones already listed in the canon. `exempt` carves out a
 * heading that matches `claims` but is a different section entirely; each
 * carve-out has a case below proving it neither fires nor widens.
 */
interface SectionRule {
  /** The section's name in the canon, for the failure message. */
  section: string;
  /** Any heading whose title matches this is this section. */
  claims: RegExp;
  /** Headings that match `claims` but are another section. */
  exempt?: (heading: Heading) => boolean;
  /** The exact heading, hashes included, the canon prescribes. */
  house: string;
}

/** The scan family's shared sections (canon: "Shared headings — scan family"). */
const SCAN_SECTIONS: readonly SectionRule[] = [
  {
    section: "Hard constraints",
    claims: /^Hard\s+[Cc]onstraints\b/,
    house: "## Hard Constraints (apply to every phase)",
  },
  {
    section: "Finding ID recipe",
    claims: /^Stable\s+finding\s+ID\s+recipe$/i,
    house: "## Stable finding ID recipe",
  },
  {
    section: "Per-finding filing sub-heading",
    claims: /^(For\s+each\s+surviving\s+finding|Filing\s+the\s+finding)\b/i,
    house: "### For each surviving finding (skip silently if its id is in " +
      "the suppressed or known-open list)",
  },
  {
    section: "Issue-body fix slot",
    claims: /^Suggested\b/i,
    house: "## Suggested fix",
  },
  {
    section: "Issue-body rationale slot",
    claims: /^Why\b/i,
    // `## Why this scan exists` is a prompt-level section — it tells the run
    // what the scan is for. It is not a variant of the rationale slot in a
    // filed issue body, and the canon protects it explicitly.
    exempt: (heading) => /^Why\s+this\s+scan\s+exists$/i.test(heading.title),
    house: "## Why this matters",
  },
] as const;

/**
 * The interactive family's shared sections (canon: "Shared headings —
 * interactive family").
 */
const INTERACTIVE_SECTIONS: readonly SectionRule[] = [
  {
    section: "Repo-standards section",
    claims: /Guidelines$/i,
    // A *qualified* heading below H2 names a section local to its template —
    // `### Planning Guidelines` is guidance on how to plan, `### Grill-me
    // guidelines` is that template's own rules — not a pointer at the
    // repository's standards, so it stays. A bare `### Guidelines` is not
    // qualified: it is the repo-standards section written at the wrong
    // depth, and the canon bans it.
    exempt: (heading) =>
      heading.level >= 3 && !/^Guidelines$/i.test(heading.title),
    house: "## Project Guidelines",
  },
  {
    section: "Worked examples",
    claims: /^(Worked\b.*|Examples)$/i,
    house: "### Worked Examples",
  },
] as const;

/**
 * Every heading in `text` that claims `rule`'s section but is not written the
 * house way, rendered with the file, the line and the form to use.
 *
 * @param name - The prompt directory the template belongs to
 * @param text - The template's full text
 * @param rule - The section being enforced
 * @returns One message per drifted heading
 */
function sectionViolations(
  name: string,
  text: string,
  rule: SectionRule,
): string[] {
  return headings(text)
    .filter((heading: Heading) => rule.claims.test(heading.title))
    .filter((heading) => !rule.exempt?.(heading))
    .filter((heading) => heading.written !== rule.house)
    .map((heading) =>
      `${fileOf(name)}:${heading.line} — ${rule.section} is written ` +
      `"${heading.written}"; the house form is "${rule.house}"`
    );
}

/**
 * Every prose hit for `pattern` across `set`, prefixed with its file.
 *
 * @param set - Directory name to template text
 * @param pattern - A global pattern, inner whitespace spelled `\s+`
 * @returns One `prompts/x/prompt.md line N: phrase` entry per hit
 */
function proseHits(
  set: Map<string, string>,
  pattern: RegExp,
): string[] {
  const hits: string[] = [];
  for (const [name, text] of set) {
    // Non-vacuity, per template rather than per rule: every prose rule below
    // asserts an absence, so a projection that returned little or nothing for
    // one template would report green over text it never read. The shipped
    // set retains 69% of its bytes at worst — fenced examples are the rest —
    // so half is a floor no healthy template approaches, and one that does
    // has lost its prose to a segmentation fault rather than to fences.
    try {
      const { flat } = flattenProse(text);
      assert(
        flat.length * 2 > text.length,
        `the prose projection kept only ${flat.length} of ${text.length} ` +
          "bytes; the rules here would pass over a template they never read",
      );
      for (const hit of hitsIn(text, pattern)) {
        hits.push(`${fileOf(name)} ${hit}`);
      }
    } catch (error) {
      // Re-raised with the file, because the projection raises without one and
      // "unbalanced fences on line 154" of an unnamed template is not enough
      // to act on at 2am.
      throw new Error(`${fileOf(name)} — ${String(error)}`, { cause: error });
    }
  }
  return hits;
}

/** The templates of the directories named in `names`. */
async function subset(names: string[]): Promise<Map<string, string>> {
  const all = await templates();
  return new Map(names.map((name) => [name, all.get(name)!]));
}

// ---------------------------------------------------------------------------
// Discovery
// ---------------------------------------------------------------------------

Deno.test("house vocabulary - every prompt directory is read and classified (Issue #840)", async () => {
  const all = await templates();
  const canon = await Deno.readTextFile(VOCABULARY_PATH);

  // Non-vacuity: a discovery bug that returned nothing would turn every
  // "assert no violations" test below green while checking nothing.
  assert(
    all.size >= 33,
    `only ${all.size} prompt templates were read; the audit of #794 covered ` +
      "33 — the discovery in this file has gone stale",
  );

  const scan = await family(isScan);
  const interactive = await family(isInteractive);
  const fragments = await family(isFragment);
  assert(scan.length >= 15, `scan family shrank to ${scan.length}`);
  assert(
    interactive.length >= 12,
    `interactive family shrank to ${interactive.length}`,
  );

  // The canon lists each family's membership; this file computes it from the
  // template text. They must agree — a directory that escaped both would
  // silently lose its heading rules, and a canon row left stale would send
  // the next sweep at the wrong set.
  const familiesSection = canon.split(/^## /m).find((s) =>
    s.startsWith("Families")
  );
  assert(familiesSection, "the canon has no Families section");
  const rows = familiesSection.split("\n").filter((line) =>
    line.trim().startsWith("|")
  );
  const rowFor = (label: string) => {
    const row = rows.find((line) => line.includes(`**${label}**`));
    assert(row, `the canon's Families table has no ${label} row`);
    return citedDirectories(row);
  };

  assertEquals(
    scan,
    rowFor("Scan"),
    "the scan family computed from the templates (every template carrying a " +
      "`Stable finding ID recipe` section) differs from the Scan row of " +
      "docs/PROMPT-HOUSE-VOCABULARY.md",
  );
  assertEquals(
    interactive,
    rowFor("Interactive"),
    "the interactive family computed from the templates (non-scan, carries " +
      "its own placeholders, opens at H2) differs from the Interactive row " +
      "of docs/PROMPT-HOUSE-VOCABULARY.md",
  );
  assertEquals(
    fragments,
    rowFor("Injected fragment"),
    "the injected fragments computed from the templates (no placeholder of " +
      "their own) differ from the Injected fragment row of " +
      "docs/PROMPT-HOUSE-VOCABULARY.md",
  );
  assertEquals(
    [...all.keys()].filter((name) =>
      !scan.includes(name) && !interactive.includes(name) &&
      !fragments.includes(name)
    ).sort(),
    rowFor("Lightweight audit"),
    "a prompt directory falls into none of the three computed families, so " +
      "it must be a lightweight audit — and the canon must say so",
  );
});

// ---------------------------------------------------------------------------
// Banned literals — every directory
// ---------------------------------------------------------------------------

Deno.test("house vocabulary - the product is Vibe Coder in prose (Issue #840)", async () => {
  // Exempt by construction: the repo slug `stSoftwareAU/VibeCoder`, and
  // `VibeCoder` inside a URL or a filesystem path, are identifiers rather
  // than prose — the lookaround is what spares them, so a `/` on either side
  // means no hit. Code spans and fenced blocks are already out of the prose
  // projection.
  const banned = /(?<![\w/])VibeCoder(?![\w/])/g;
  assertEquals(
    hitsIn(
      [
        "The repo is stSoftwareAU/VibeCoder and lives at",
        "https://github.com/stSoftwareAU/VibeCoder, cloned to",
        "VibeCoder/worker/deno.",
      ].join("\n"),
      banned,
    ),
    [],
    "the repo slug, the URL and the path must all be exempt",
  );
  assertEquals(
    hitsIn("VibeCoder runs unattended.", banned),
    ["line 1: VibeCoder"],
    "one-word prose use must be caught",
  );

  const hits = proseHits(await templates(), banned);
  assertEquals(
    hits,
    [],
    "the house form is `Vibe Coder` with a space in prose (the repo slug, " +
      "URLs and paths keep the one word):\n" + hits.join("\n"),
  );
});

Deno.test("house vocabulary - the Deno harness is the worker (Issue #840)", async () => {
  // Scoped to the harness noun. "executor" is a legitimate finding-class word
  // (a thread-pool executor, a statement executor), so only the definite
  // article form is governed.
  const hits = proseHits(await templates(), /\b[Tt]he\s+executors?\b/g);
  assertEquals(
    hits,
    [],
    "the house noun for the Deno harness is `the worker`:\n" + hits.join("\n"),
  );
});

Deno.test("house vocabulary - the quality gate is run as ./quality.sh (Issue #840)", async () => {
  // The exemption is the runnable form itself: `./quality.sh` must never be
  // flagged, and naming the script as a file — `quality.sh:41`, "the repo has
  // no `quality.sh`" — is a filename reference in a code span, which the
  // prose projection already drops.
  const banned = /(?<![./\w])quality\.sh/g;
  assertEquals(
    hitsIn(
      "Run ./quality.sh once, and `quality.sh:41` shows the gate.",
      banned,
    ),
    [],
    "`./quality.sh` and a code-span filename reference must both be exempt",
  );
  assertEquals(
    hitsIn("Run quality.sh before the PR.", banned),
    ["line 1: quality.sh"],
    "the bare command form must be caught",
  );

  const hits = proseHits(await templates(), banned);
  assertEquals(
    hits,
    [],
    "the house form of the command is `./quality.sh`:\n" + hits.join("\n"),
  );
});

Deno.test("house vocabulary - the scheduled-scan concept is idle-task (Issue #840)", async () => {
  const hits = proseHits(await templates(), /\bidle\s+task\b/gi);
  assertEquals(
    hits,
    [],
    "the house form is `idle-task`, hyphenated, matching the label the " +
      "worker reads:\n" + hits.join("\n"),
  );
});

Deno.test("house vocabulary - the markup language is Markdown in prose (Issue #840)", async () => {
  // Lowercase stays where it is a token rather than prose: a fence
  // infostring, a code span, a filename. The projection drops fences and code
  // spans, and the trailing `\b` spares `markdownlint` in bare prose.
  const banned = /(?<![\w-])markdown\b/g;
  assertEquals(
    hitsIn(
      [
        "Bodies are `markdown` in this shape:",
        "",
        "```markdown",
        "## Suggested fix",
        "```",
        "",
        "The markdownlint config lives beside it.",
      ].join("\n"),
      banned,
    ),
    [],
    "a code span, a fence infostring and `markdownlint` must all be exempt",
  );
  assertEquals(
    hitsIn("The body is markdown.", banned),
    ["line 1: markdown"],
    "lowercase prose use must be caught",
  );

  const hits = proseHits(await templates(), banned);
  assertEquals(
    hits,
    [],
    "the house form is `Markdown` in prose:\n" + hits.join("\n"),
  );
});

Deno.test("house vocabulary - the finding-id placeholder keeps its family prefix (Issue #840)", async () => {
  // The generic form invites an id with no family prefix, which the
  // suppression parser will not match — so a filed waiver would never
  // silence the finding it names.
  const offenders: string[] = [];
  for (const [name, text] of await templates()) {
    text.split("\n").forEach((line, index) => {
      if (line.includes("<!-- finding-id: <id> -->")) {
        offenders.push(
          `${fileOf(name)}:${index + 1} — the house forms are ` +
            "`<!-- finding-id: BP-… -->` and `<!-- finding-id: SEC-… -->`",
        );
      }
    });
  }
  assertEquals(offenders, [], offenders.join("\n"));

  // Non-vacuity: the family-prefixed form is what the templates actually use.
  const prefixed =
    (await family((text) => /<!--\s*finding-id:\s*(BP|SEC)-/.test(text)))
      .length;
  assert(
    prefixed >= 15,
    `only ${prefixed} templates carry a family-prefixed finding-id ` +
      "placeholder — the matcher above has gone stale",
  );
});

// ---------------------------------------------------------------------------
// One heading per shared section — scan family
// ---------------------------------------------------------------------------

Deno.test("house vocabulary - the scan family writes each shared heading one way (Issue #840)", async () => {
  const scan = await subset(await family(isScan));
  const violations: string[] = [];
  for (const [name, text] of scan) {
    for (const rule of SCAN_SECTIONS) {
      violations.push(...sectionViolations(name, text, rule));
    }
  }
  assertEquals(violations, [], violations.join("\n"));
});

Deno.test("house vocabulary - the scan family's banned heading variants are absent everywhere (Issue #840)", async () => {
  // The variants the canon names, asserted zero across *every* directory —
  // not just the family that owns the section — so a scan heading cannot be
  // reintroduced by copying it into a template of another family.
  const BANNED = [
    "## Hard Constraints (apply throughout)",
    "### Stable finding ID recipe",
    "### For each surviving finding",
    "### Filing the finding",
    "## Suggested action",
    "## Suggested replacement",
    "## Why this is a candidate",
    "## Why this is flagged",
    "## Why it is safe to remove",
    "## Why it is a bug",
  ];
  // Matched case-insensitively, with the house spellings exempted first, so
  // `## Hard constraints (apply to every phase)` — the canon's own lower-case
  // row — is banned by the same entry that permits the house form, and no
  // re-cased variant of a house heading slips past the list.
  const fold = (heading: string) => heading.toLowerCase();
  const house = new Set(
    [...SCAN_SECTIONS, ...INTERACTIVE_SECTIONS].map((rule) => rule.house),
  );
  const banned = new Set([...BANNED, ...house].map(fold));

  const violations: string[] = [];
  for (const [name, text] of await templates()) {
    for (const heading of headings(text)) {
      if (house.has(heading.written)) continue;
      if (banned.has(fold(heading.written))) {
        violations.push(
          `${fileOf(name)}:${heading.line} — "${heading.written}" is a ` +
            "banned variant; see docs/PROMPT-HOUSE-VOCABULARY.md",
        );
      }
    }
  }
  assertEquals(violations, [], violations.join("\n"));

  // The rule is proved on both edges: a re-cased house heading is caught, the
  // house spelling itself is not.
  assert(
    banned.has(fold("## Hard constraints (apply to every phase)")) &&
      !house.has("## Hard constraints (apply to every phase)"),
    "a re-cased house heading must be banned",
  );
  assert(house.has("## Hard Constraints (apply to every phase)"));
});

Deno.test("house vocabulary - `## Why this scan exists` is not treated as the rationale slot (Issue #840)", async () => {
  // The exemption, proved rather than asserted: the prompt-level section
  // passes and a real variant of the slot does not.
  const rule = SCAN_SECTIONS.find((r) =>
    r.section === "Issue-body rationale slot"
  )!;
  assertEquals(
    sectionViolations("bash_script_refs", "## Why this scan exists\n", rule),
    [],
    "the prompt-level section must not be flagged as the rationale slot",
  );
  assertEquals(
    sectionViolations("dead_code", "## Why it is safe to remove\n", rule)
      .length,
    1,
    "a real variant of the rationale slot must still be flagged",
  );

  // And it is a live section, not a hypothetical: at least one template
  // carries it, so the exemption is exercised against the shipped set.
  const carriers = await family((text) =>
    headings(text).some((h) => h.written === "## Why this scan exists")
  );
  assert(
    carriers.length > 0,
    "no template carries `## Why this scan exists` — the exemption above is " +
      "no longer exercised by the shipped templates",
  );
});

Deno.test("house vocabulary - every scan template carries the sections it owns (Issue #840)", async () => {
  const missing: string[] = [];
  for (const [name, text] of await subset(await family(isScan))) {
    const written = new Set(headings(text).map((h) => h.written));
    const require = (heading: string, why: string) => {
      if (!written.has(heading)) {
        missing.push(`${fileOf(name)} — no "${heading}" (${why})`);
      }
    };

    require(
      "## Hard Constraints (apply to every phase)",
      "every scan states which phases its constraints bind",
    );
    require(
      "## Stable finding ID recipe",
      "at H2 — it is a peer of the phase sections, not a subsection",
    );

    // A scan that files one issue per finding owns the filing sub-heading's
    // parenthetical: without it the heading does not say that a suppressed
    // finding is dropped without comment. The precondition is the filing
    // phase the template itself declares, so a scan that files a single
    // issue (`retro`) is outside the rule by its own content, never by a
    // waiver.
    if (/^\s*## Phase \d+ — File[^\n]*finding/m.test(text)) {
      const bare = [
        ...text.matchAll(
          /For\s+each\s+surviving\s+finding(?!\s*\(skip\s+silently)/g,
        ),
      ];
      if (bare.length > 0) {
        missing.push(
          `${fileOf(name)} — "For each surviving finding" appears without ` +
            "the `(skip silently if its id is in the suppressed or " +
            "known-open list)` parenthetical, which is the suppression " +
            "contract",
        );
      }
      if (!/For\s+each\s+surviving\s+finding/.test(text)) {
        missing.push(
          `${fileOf(name)} — files one issue per finding but never names ` +
            "the per-finding filing step",
        );
      }
    }

    // A scan that shows the issue body it files owns the fix slot: a reader
    // scanning filed issues across scans should not have to know which scan
    // wrote the body.
    if (showsIssueBody(text)) {
      require(
        "## Suggested fix",
        "the filed body's fix slot is the same in every scan",
      );
    }
  }
  assertEquals(missing, [], missing.join("\n"));
});

Deno.test("house vocabulary - the rationale slot is present in the scan family (Issue #840)", async () => {
  // Which scans carry a rationale slot at all is a *presence* question, and
  // the canon puts presence gaps out of scope (Issue #841): two scans lead
  // their body with domain evidence instead. What is governed here is the
  // name — enforced above for every scan — plus the fact that the house form
  // is live in the family, so the rule is not being kept green by deletion.
  const carriers = await family((text) =>
    isScan(text) &&
    headings(text).some((h) => h.written === "## Why this matters")
  );
  assert(
    carriers.length > 0,
    "no scan template carries `## Why this matters`; the rationale slot has " +
      "been renamed or deleted rather than kept",
  );
});

Deno.test("house vocabulary - the filing phase keeps its outcome-only suffix (Issue #840)", async () => {
  // The suffix is the verbosity contract for the phase: it tells the run to
  // emit outcomes rather than narrate the filing.
  const violations: string[] = [];
  for (const [name, text] of await subset(await family(isScan))) {
    for (const heading of headings(text)) {
      if (!/^Phase\s+\d+\s+—\s+File\b/.test(heading.title)) continue;
      if (heading.title.endsWith("(outcome-only)")) continue;
      violations.push(
        `${fileOf(name)}:${heading.line} — "${heading.written}" drops the ` +
          "`(outcome-only)` suffix the filing phase is contracted to carry",
      );
    }
  }
  assertEquals(violations, [], violations.join("\n"));
});

/** Whether the template shows the body of the issue it files, as a fenced example. */
function showsIssueBody(text: string): boolean {
  return fencedBlocks(text).some((block) => block.includes("<!-- finding-id:"));
}

// ---------------------------------------------------------------------------
// One heading per shared section — interactive family
// ---------------------------------------------------------------------------

Deno.test("house vocabulary - every interactive template opens with its mode heading (Issue #840)", async () => {
  // The opening H2 is what tells a run in one line which workflow it is in;
  // a template that opens with prose makes the run infer it.
  const violations: string[] = [];
  for (const [name, text] of await subset(await family(isInteractive))) {
    const opening = headings(text)[0];
    if (!opening || !/^.+\sMode(\s—\s.+)?$/.test(opening.title)) {
      violations.push(
        `${fileOf(name)}:${opening?.line ?? 1} — opens with ` +
          `"${opening?.written ?? "(no heading)"}"; the house form is ` +
          "`## <X> Mode`, optionally with a ` — <subtitle>` tail",
      );
    }
  }
  assertEquals(violations, [], violations.join("\n"));
});

Deno.test("house vocabulary - the interactive family writes each shared heading one way (Issue #840)", async () => {
  // Scoped to the family that owns these headings, as the canon's table is:
  // `prompts/bash_script_refs/` is a lightweight audit whose own
  // `## Worked examples — …` section is outside the interactive table. The
  // injected fragments are included because they render *inside* an
  // interactive prompt, so their headings land in the same rendered text.
  const governed = await subset(
    [...await family(isInteractive), ...await family(isFragment)].sort(),
  );
  const violations: string[] = [];
  for (const [name, text] of governed) {
    for (const rule of INTERACTIVE_SECTIONS) {
      violations.push(...sectionViolations(name, text, rule));
    }
  }
  assertEquals(violations, [], violations.join("\n"));

  // Both house headings are live in the family, so the rule above is not
  // being kept green by deletion.
  for (const heading of ["## Project Guidelines", "### Worked Examples"]) {
    const carriers = [...governed.values()].filter((text) =>
      headings(text).some((h) => h.written === heading)
    );
    assert(
      carriers.length > 0,
      `no interactive template carries "${heading}"`,
    );
  }
});

Deno.test("house vocabulary - `### Planning Guidelines` is not the repo-standards section (Issue #840)", async () => {
  // The exemption, proved: planning guidance passes, a drifted repo-standards
  // heading does not.
  const rule = INTERACTIVE_SECTIONS.find((r) =>
    r.section === "Repo-standards section"
  )!;
  assertEquals(
    sectionViolations(
      "planning",
      "### Planning Guidelines\n\n### Grill-me guidelines\n",
      rule,
    ),
    [],
    "a qualified sub-heading names a section local to its template and stays",
  );
  // The carve-out is depth *plus* qualification, so it cannot be widened into
  // "any H3 passes": a bare `### Guidelines` is the repo-standards section at
  // the wrong depth and is still caught.
  for (
    const drifted of ["## Coding Guidelines", "## Guidelines", "### Guidelines"]
  ) {
    assertEquals(
      sectionViolations("issue", `${drifted}\n`, rule).length,
      1,
      `${drifted} must still be flagged`,
    );
  }

  // And it is a live section, so the exemption is exercised by the shipped
  // templates rather than only by the case above.
  const carriers = await family((text) =>
    headings(text).some((h) => h.written === "### Planning Guidelines")
  );
  assert(
    carriers.length > 0,
    "no template carries `### Planning Guidelines` — the exemption above is " +
      "no longer exercised by the shipped templates",
  );
});

// ---------------------------------------------------------------------------
// Suppression prose
// ---------------------------------------------------------------------------

Deno.test("house vocabulary - no template calls the suppression grammar shared (Issue #840)", async () => {
  // Three namespaced keywords exist and each scan honours one, so a
  // maintainer reading "the shared suppression-comment grammar" cannot tell
  // which keyword their scan actually reads.
  const hits = proseHits(
    await templates(),
    /shared\s+suppression-comment\s+grammar/gi,
  );
  assertEquals(
    hits,
    [],
    "each template names its own keyword; the grammar is not shared:\n" +
      hits.join("\n"),
  );
});

/** A suppression marker a template spells out, with the keyword it names. */
interface MarkerLiteral {
  file: string;
  line: number;
  keyword: string;
  /** The marker, with the id normalised to a parseable one. */
  probe: string;
  /** The family the id's prefix claims. */
  family: "best-practices" | "security-scan";
}

/** Every suppression marker literal the templates spell out. */
async function markerLiterals(): Promise<MarkerLiteral[]> {
  const found: MarkerLiteral[] = [];
  const pattern =
    /(#|\/\/|\/\*)\s*([a-z][a-z0-9-]*)\s*:\s*(BP|SEC)-(?:[A-Za-z0-9-]+|…)/g;
  for (const [name, text] of await templates()) {
    text.split("\n").forEach((line, index) => {
      for (const match of line.matchAll(pattern)) {
        const prefix = match[3]!;
        found.push({
          file: fileOf(name),
          line: index + 1,
          keyword: match[2]!,
          // The templates write the placeholder id (`BP-…`) and, in worked
          // examples, a twelve-hex-digit one. Normalise to the parseable
          // form so what is under test is the *keyword*, not the id.
          probe: `${match[1]} ${match[2]}: ${prefix}-0123456789ab ` +
            "author=maintainer expires=2999-01-01 reason",
          family: prefix === "SEC" ? "security-scan" : "best-practices",
        });
      }
    });
  }
  return found;
}

Deno.test("house vocabulary - every suppression keyword a template names is one the code implements (Issue #840)", async () => {
  const literals = await markerLiterals();
  assert(
    literals.length > 0,
    "no suppression marker literal was found in any template — the matcher " +
      "has gone stale and this cross-check is vacuous",
  );

  const violations: string[] = [];
  for (const literal of literals) {
    const language = literal.probe.startsWith("#") ? "py" : "ts";
    const parsed = findSuppressions(literal.probe, language);
    const match = parsed.find((record) => record.family === literal.family);
    if (!match) {
      violations.push(
        `${literal.file}:${literal.line} — the template advertises the ` +
          `\`${literal.keyword}\` keyword for a ${literal.family} finding, ` +
          "but worker/deno/lib/suppression_comments.ts does not parse it, " +
          "so a waiver written that way would never suppress anything",
      );
    }
  }
  assertEquals(violations, [], violations.join("\n"));

  // The keywords the templates actually name today, so a keyword quietly
  // disappearing from the prompt set is visible here too.
  const named = new Set(literals.map((literal) => literal.keyword));
  for (const keyword of ["best-practice-ignore", "security-scan-ignore"]) {
    assert(
      named.has(keyword),
      `no template names the \`${keyword}\` keyword any more`,
    );
  }
});

// ---------------------------------------------------------------------------
// Attribution footer
// ---------------------------------------------------------------------------

Deno.test("house vocabulary - the attribution footer is cited from the Inputs section (Issue #840)", async () => {
  // The worker substitutes `{{ATTRIBUTION_FOOTER}}` wherever it sits, so the
  // citation is only true if the placement matches it. A template that cites
  // a *different* source — the end of the prompt, a marker, an XML tag — sends
  // the run looking somewhere the footer may not be.
  //
  // The `from` clause can sit a clause away from the words "attribution
  // footer" — "end every body with the attribution footer as its final line —
  // preceded by a blank line and reproduced **verbatim** from …" — so the
  // window runs to the end of the sentence rather than a couple of words.
  // A tight window silently passed that phrasing while reporting green.
  const citation =
    /attribution\s+footer[^.]{0,140}?\bfrom\s+\S+(?:\s+\S+){0,3}/gi;
  const house = /from\s+the\s+\*{0,2}Inputs\*{0,2}\s+section/i;

  // Non-vacuity: the rule is only worth anything if the matcher sees the
  // citation in most of the templates that carry the placeholder. A window
  // that stopped matching would otherwise report green over an unchecked set.
  let carriers = 0;
  const violations: string[] = [];
  const cited = new Set<string>();
  for (const [name, text] of await templates()) {
    if (!text.includes("{{ATTRIBUTION_FOOTER}}")) continue;
    carriers++;
    // Searched with the code kept, because most scans state the citation
    // *inside* the fenced issue body they file — `<the attribution footer
    // line from the Inputs section, verbatim>`. Read as prose only, those
    // templates cite the footer in a place the rule never looked.
    for (const hit of hitsIn(text, citation, true)) {
      if (house.test(hit)) {
        cited.add(name);
        continue;
      }
      violations.push(
        `${fileOf(name)} ${hit} — the house citation is ` +
          '"from the Inputs section"',
      );
    }
  }
  assertEquals(violations, [], violations.join("\n"));
  // Two of every three carriers must be seen citing the footer. The rest are
  // the lightweight audits that name no source at all — a presence gap the
  // canon puts out of scope (Issue #841), not a variant — so the floor is set
  // where they sit today rather than by listing them, and a matcher that
  // stopped reading the fenced bodies would drop straight through it.
  assert(
    cited.size * 3 >= carriers * 2,
    `only ${cited.size} of the ${carriers} templates carrying ` +
      "`{{ATTRIBUTION_FOOTER}}` were seen citing it; the matcher has gone " +
      "stale and this rule is passing over templates it never read",
  );

  // The phrasing the canon names outright, asserted absent across the set.
  const stale = proseHits(
    await templates(),
    /from\s+the\s+end\s+of\s+this\s+prompt/gi,
  );
  assertEquals(
    stale,
    [],
    "`from the end of this prompt` describes yesterday's placement:\n" +
      stale.join("\n"),
  );
});
