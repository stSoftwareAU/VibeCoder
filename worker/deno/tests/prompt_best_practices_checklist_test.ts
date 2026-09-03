/**
 * Tests for the prompt best-practices checklist.
 *
 * `docs/PROMPT-BEST-PRACTICES-CHECKLIST.md` is the shared rubric the audit
 * sub-issues of score their prompt surfaces against. These tests assert
 * the invariants that make it usable as a rubric: every technique heading in
 * Anthropic's prompting best-practices guide is either a numbered checklist row
 * with pass / gap / n-a definitions, or is named in the out-of-scope table with
 * a reason; and the copy-paste templates the audits depend on are present.
 *
 * Australian English is used throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

/** Resolve the repository root (three levels up from worker/deno/tests/). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  return thisDir.replace(/worker\/deno\/tests\/$/, "");
}

const CHECKLIST_PATH = "docs/PROMPT-BEST-PRACTICES-CHECKLIST.md";

/**
 * Technique headings from the guide that must appear as numbered checklist
 * rows, in guide order.
 */
const IN_SCOPE_TECHNIQUES = [
  // General principles
  "Be clear and direct",
  "Add context to improve performance",
  "Use examples effectively",
  "Structure prompts with XML tags",
  "Give Claude a role",
  "Long context prompting",
  // Output and formatting
  "Communication style and verbosity",
  "Control the format of responses",
  "Migrating away from prefilled responses",
  // Tool use
  "Tool usage",
  "Optimize parallel tool calling",
  // Thinking and reasoning
  "Overthinking and excessive thoroughness",
  "Leverage thinking & interleaved thinking capabilities",
  // Agentic systems
  "Long-horizon reasoning and state tracking",
  "Balancing autonomy and safety",
  "Research and information gathering",
  "Subagent orchestration",
  "Chain complex prompts",
  "Reduce file creation in agentic coding",
  "Overeagerness",
  "Avoid focusing on passing tests and hardcoding",
  "Minimizing hallucinations in agentic coding",
];

/**
 * Guide headings that must be named in the out-of-scope table with a reason.
 *
 * The guide replaced its four per-model headings (`Claude Fable 5`,
 * `Claude Sonnet 5`, `Prompting Claude Opus 5`, `Prompting Claude Opus 4.8`)
 * with a single `Model-specific guidance` section listing one prompting page
 * per model, so the table names that section instead (Issue #747).
 */
const OUT_OF_SCOPE_HEADINGS = [
  "Model-specific guidance",
  "Model self-knowledge",
  "LaTeX output",
  "Document creation",
  "Capability-specific tips",
  "Improved vision capabilities",
  "Frontend design",
  "Migration considerations",
  "Migrating to Claude Sonnet 5 from Claude Sonnet 4.5 or earlier",
  "Next steps",
];

async function readChecklist(): Promise<string> {
  return await Deno.readTextFile(`${repoRoot()}${CHECKLIST_PATH}`);
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

/** Extract the body of the `## ` section whose heading starts with `title`. */
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

/** Strip Markdown emphasis and code ticks from a table cell. */
function plain(cell: string): string {
  return cell.replaceAll("*", "").replaceAll("`", "").trim();
}

interface ChecklistRow {
  number: number;
  technique: string;
  pass: string;
  gap: string;
  notApplicable: string;
}

/** Checklist rows: `# | Technique | Pass | Gap | n/a`. */
function checklistRows(markdown: string): ChecklistRow[] {
  return tableRows(section(markdown, "Checklist"))
    .filter((cells) => cells.length === 5 && /^\d+$/.test(cells[0] ?? ""))
    .map((cells) => ({
      number: Number(cells[0]),
      technique: plain(cells[1] ?? ""),
      pass: cells[2] ?? "",
      gap: cells[3] ?? "",
      notApplicable: cells[4] ?? "",
    }));
}

/** House-addition techniques, in the order the rubric lists them. */
const HOUSE_TECHNIQUES = ["Positive framing", "No-ops", "Leading words"];

interface HouseRow {
  id: string;
  technique: string;
  pass: string;
  gap: string;
  notApplicable: string;
}

/** House-addition rows: `H<n> | Technique | Pass | Gap | n/a`. */
function houseRows(markdown: string): HouseRow[] {
  return tableRows(section(markdown, "House additions"))
    .filter((cells) => cells.length === 5 && cells[0] !== "#")
    .map((cells) => ({
      id: plain(cells[0] ?? ""),
      technique: plain(cells[1] ?? ""),
      pass: cells[2] ?? "",
      gap: cells[3] ?? "",
      notApplicable: cells[4] ?? "",
    }));
}

Deno.test("checklist scores every in-scope guide technique", async () => {
  const markdown = await readChecklist();
  const techniques = checklistRows(markdown).map((row) => row.technique);

  assertEquals(techniques, IN_SCOPE_TECHNIQUES);
});

Deno.test("each checklist row defines pass, gap and n/a", async () => {
  const markdown = await readChecklist();

  for (const row of checklistRows(markdown)) {
    for (
      const [label, text] of [
        ["pass", row.pass],
        ["gap", row.gap],
        ["n/a", row.notApplicable],
      ] as const
    ) {
      assert(
        text.length >= 20,
        `row ${row.number} (${row.technique}) has no ${label} definition`,
      );
    }
  }
});

Deno.test("checklist rows are numbered contiguously from 1", async () => {
  const markdown = await readChecklist();
  const numbers = checklistRows(markdown).map((row) => row.number);

  assertEquals(
    numbers,
    numbers.map((_, index) => index + 1),
  );
});

Deno.test("house additions score the three house techniques", async () => {
  const markdown = await readChecklist();
  const techniques = houseRows(markdown).map((row) => row.technique);

  assertEquals(techniques, HOUSE_TECHNIQUES);
});

Deno.test("house rows are numbered outside the guide's 1-22 range", async () => {
  const markdown = await readChecklist();
  const rows = houseRows(markdown);

  assert(rows.length > 0, "no house rows found");
  for (const row of rows) {
    assert(
      /^H\d+$/.test(row.id),
      `house row "${row.id}" is not numbered outside the 1-22 range`,
    );
  }
  assertEquals(
    rows.map((row) => row.id),
    rows.map((_, index) => `H${index + 1}`),
  );
});

Deno.test("each house row defines pass, gap and n/a", async () => {
  const markdown = await readChecklist();

  for (const row of houseRows(markdown)) {
    for (
      const [label, text] of [
        ["pass", row.pass],
        ["gap", row.gap],
        ["n/a", row.notApplicable],
      ] as const
    ) {
      assert(
        text.length >= 20,
        `house row ${row.id} (${row.technique}) has no ${label} definition`,
      );
    }
  }
});

Deno.test("house additions leave the guide rows untouched", async () => {
  const markdown = await readChecklist();
  const guideRows = checklistRows(markdown);

  assertEquals(guideRows.length, IN_SCOPE_TECHNIQUES.length);
  for (const row of guideRows) {
    assert(
      !HOUSE_TECHNIQUES.includes(row.technique),
      `house technique "${row.technique}" interleaved into the guide rows`,
    );
  }
});

Deno.test("house additions settle the model-relative and guardrail rules", async () => {
  const body = section(await readChecklist(), "House additions");

  assert(
    /candidate/i.test(body),
    "no candidate rule for the model-relative no-op test",
  );
  assert(/guardrail/i.test(body), "no hard-guardrail carve-out");
  assert(
    body.includes("docs/audits/"),
    "no statement on how existing audits are treated",
  );
});

Deno.test("verdict table template carries the house rows", async () => {
  const markdown = await readChecklist();
  const body = section(markdown, "Verdict table template");
  const fenced = /```markdown\n([\s\S]*?)```/.exec(body)?.[1];
  assert(fenced, "verdict table template is not in a fenced block");

  const ids = tableRows(fenced)
    .filter((cells) => /^H\d+$/.test(plain(cells[0] ?? "")))
    .map((cells) => `${plain(cells[0] ?? "")} ${plain(cells[1] ?? "")}`);

  assertEquals(
    ids,
    houseRows(markdown).map((row) => `${row.id} ${row.technique}`),
  );
});

Deno.test("out-of-scope table names every excluded guide heading", async () => {
  const markdown = await readChecklist();
  const reasons = new Map(
    tableRows(section(markdown, "out of scope"))
      .filter((cells) => cells.length === 2)
      .map((cells) => [plain(cells[0] ?? ""), cells[1] ?? ""]),
  );

  for (const heading of OUT_OF_SCOPE_HEADINGS) {
    const reason = reasons.get(heading);
    assert(reason !== undefined, `out-of-scope table is missing "${heading}"`);
    assert(
      reason.length >= 20,
      `out-of-scope entry "${heading}" gives no reason`,
    );
  }
});

Deno.test("applicability note covers both surface kinds", async () => {
  const body = section(await readChecklist(), "Applicability");

  assert(
    body.includes("prompts/<name>/prompt.md"),
    "static template kind missing",
  );
  assert(
    body.includes("worker/deno/lib/prompt_builder.ts"),
    "code-assembled kind missing",
  );
});

Deno.test("verdict table template is copy-pasteable and evidence-bearing", async () => {
  const body = section(await readChecklist(), "Verdict table template");
  const fenced = /```markdown\n([\s\S]*?)```/.exec(body)?.[1];
  assert(fenced, "verdict table template is not in a fenced block");

  const header = tableRows(fenced)[0];
  assert(header, "verdict table template has no header row");
  for (const column of ["Checklist item", "Evidence"]) {
    assert(
      header.some((cell) => cell.includes(column)),
      `verdict table template has no "${column}" column`,
    );
  }
  assert(fenced.includes("file:line"), "no file:line evidence requirement");
});

Deno.test("gap-issue template fixes title, labels and milestone", async () => {
  const body = section(await readChecklist(), "Gap-issue template");

  assert(
    body.includes("prompt(<surface>): N Claude best-practice gaps"),
    "gap-issue title form missing",
  );
  for (const label of ["enhancement", "best-practices"]) {
    assert(body.includes(label), `gap-issue label "${label}" missing`);
  }
  assert(body.includes(""), "gap-issue milestone missing");
  assert(body.includes("file:line"), "gap-issue evidence requirement missing");
});

Deno.test("checklist is linked from the documentation index", async () => {
  const readme = await Deno.readTextFile(`${repoRoot()}README.md`);

  assert(
    readme.includes(CHECKLIST_PATH),
    `README.md does not link ${CHECKLIST_PATH}`,
  );
});
