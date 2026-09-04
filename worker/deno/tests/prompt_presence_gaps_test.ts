/**
 * Tests for the two prompt **presence** gaps settled by Issue #841.
 *
 * `docs/PROMPT-BEST-PRACTICES-CHECKLIST.md` scores row 5 ("Give Claude a
 * role") and the scan family shares a `### Verification before exit`
 * closing check. Before #841 the checklist claimed both standards while a
 * subset of templates silently failed them: four surfaces opened with no
 * persona, and most of the scan family carried the closing check as an
 * unheaded tail paragraph at the end of its filing phase.
 *
 * The decision #841 recorded is split by surface kind, and these tests pin
 * both halves so the checklist and the templates cannot drift apart again:
 *
 *   - **Raise the templates** where a model reads them. Every scan-family
 *     template opens with a persona, no two scans open as the same thing,
 *     and every scan carries the closing check under its house heading.
 *   - **Narrow the claim** where no model reads them. The four native
 *     scans render their `prompt.md` as the filed wrapper issue body and
 *     never send it to a model, so the checklist records them as a third
 *     surface kind whose model-behaviour rows are `n/a`. That claim is
 *     verified here by calling the registered template's `buildIssueBody`
 *     and comparing the result to the file on disk.
 *
 * Family membership is derived from the template text (the scan family is
 * the set carrying a `Stable finding ID recipe`), never hard-coded, so a
 * sixteenth scan joins these checks the day its template lands.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { loadPrompt, PROMPT_FILENAME } from "../lib/prompt_manager.ts";
import { getTemplate } from "../lib/idle_task_template.ts";
import "../lib/idle_task_templates/alert_feed_template.ts";
import "../lib/idle_task_templates/bash_script_refs_template.ts";
import "../lib/idle_task_templates/bash_syntax_audit_template.ts";
import "../lib/idle_task_templates/workflow_annotation_scan_template.ts";
// Every read of a template below names this directory explicitly, so it is
// pinned to this checkout (Issue #844) by the parameter rather than by
// clearing a worker host's `PROMPTS_DIR`. The constant comes from the
// side-effect-free module so this suite stays in the gate's parallel pass
// (Issues #880, #940).
import { REPO_ROOT } from "./support/repo_root.ts";

const PROMPTS_DIR = `${REPO_ROOT}prompts`;
const CHECKLIST_PATH = "docs/PROMPT-BEST-PRACTICES-CHECKLIST.md";
const VOCABULARY_PATH = "docs/PROMPT-HOUSE-VOCABULARY.md";

/** The house heading for a scan's closing self-check. */
const VERIFICATION_HEADING = "### Verification before exit";

/** The scan-family membership rule, applied to the template text. */
const SCAN_FAMILY_MARKER = "Stable finding ID recipe";

/**
 * How far into a template the opening persona may sit. Generous enough for
 * an H1 and a blank line, tight enough that a `You are ` sentence buried in
 * the body cannot stand in for one.
 */
const PERSONA_OPENING_LINES = 8;

/**
 * The four surfaces no model ever reads: their `prompt.md` is rendered as
 * the filed wrapper issue body by a native template. Each entry pairs the
 * prompt directory with the idle-task template slug that renders it, so the
 * exemption is checked against real code rather than asserted.
 */
const WRAPPER_ISSUE_BODIES: Array<[string, string]> = [
  ["alert_feed", "alert-feed"],
  ["bash_script_refs", "bash-script-refs"],
  ["bash_syntax_audit", "bash-syntax-audit"],
  ["workflow_annotation_scan", "workflow-annotation-scan"],
];

/** Every prompt directory on disk, sorted. */
function promptDirectories(): string[] {
  const names: string[] = [];
  for (const entry of Deno.readDirSync(PROMPTS_DIR)) {
    if (entry.isDirectory) names.push(entry.name);
  }
  return names.sort();
}

/** The template text of every prompt directory, keyed by directory. */
async function templates(): Promise<Map<string, string>> {
  const loaded = new Map<string, string>();
  for (const name of promptDirectories()) {
    const template = await loadPrompt(name, PROMPTS_DIR);
    if (!template.ok) {
      throw new Error(`could not load prompts/${name}/${PROMPT_FILENAME}`);
    }
    loaded.set(name, template.value);
  }
  return loaded;
}

/** The scan family: every directory whose template carries the recipe. */
async function scanFamily(): Promise<Map<string, string>> {
  const scans = new Map<string, string>();
  for (const [name, text] of await templates()) {
    if (text.includes(SCAN_FAMILY_MARKER)) scans.set(name, text);
  }
  return scans;
}

/**
 * The opening persona paragraph of a template — the block starting at the
 * `You are ` line that opens the prompt and running to the next blank line,
 * whitespace collapsed onto one line. Returns `undefined` when the template
 * does not open on one: a `You are ` sentence further down the body is part
 * of the task text, not the role, so it does not count.
 */
function personaParagraph(text: string): string | undefined {
  const lines = text.split("\n");
  const start = lines
    .slice(0, PERSONA_OPENING_LINES)
    .findIndex((line) => line.startsWith("You are "));
  if (start < 0) return undefined;
  const paragraph: string[] = [];
  for (const line of lines.slice(start)) {
    if (line.trim() === "") break;
    paragraph.push(line.trim());
  }
  return paragraph.join(" ").replace(/\s+/g, " ");
}

/**
 * What a persona identifies itself as: the role noun between `You are a/an`
 * and the `performing` that starts its stance clause, or — for a persona
 * that opens on a stance rather than a role noun — its whole first sentence.
 * Never `undefined`, so no template drops out of the distinctness check
 * unscored.
 */
function personaIdentity(paragraph: string): string {
  const role = /^You are an? ([^,.;:]+?) performing\b/.exec(paragraph)?.[1];
  return (role ?? paragraph.split(/(?<=\.)\s/)[0] ?? paragraph).toLowerCase();
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

/** Parse every Markdown table row into trimmed cell arrays. */
function tableRows(markdown: string): string[][] {
  return markdown
    .split("\n")
    .map((line) => line.trim())
    .filter((line) => line.startsWith("|") && line.endsWith("|"))
    .map((line) => line.slice(1, -1).split("|").map((cell) => cell.trim()))
    .filter((cells) => !cells.every((cell) => /^:?-{2,}:?$/.test(cell)));
}

async function readChecklist(): Promise<string> {
  return await Deno.readTextFile(`${REPO_ROOT}${CHECKLIST_PATH}`);
}

// ---------------------------------------------------------------------------
// Persona — raised where a model reads the surface
// ---------------------------------------------------------------------------

Deno.test("every scan-family template opens with a persona", async () => {
  for (const [name, text] of await scanFamily()) {
    assert(
      personaParagraph(text) !== undefined,
      `prompts/${name}/${PROMPT_FILENAME} opens with no persona line, ` +
        "which row 5 of the best-practices checklist scores",
    );
  }
});

Deno.test("no two scans share a persona", async () => {
  const byIdentity = new Map<string, string[]>();
  for (const [name, text] of await scanFamily()) {
    const paragraph = personaParagraph(text);
    // A template with no opening persona is a failure of the check above,
    // not a template to drop silently from this one.
    assert(paragraph, `prompts/${name}/${PROMPT_FILENAME} opens with none`);
    const identity = personaIdentity(paragraph);
    byIdentity.set(identity, [...(byIdentity.get(identity) ?? []), name]);
  }

  const shared = [...byIdentity.entries()].filter(([, n]) => n.length > 1);
  assertEquals(
    shared,
    [],
    "each scan must name a role its readers cannot confuse with another " +
      "scan's; these share one",
  );
});

// ---------------------------------------------------------------------------
// Closing self-check — raised across the whole scan family
// ---------------------------------------------------------------------------

Deno.test("every scan carries the verification-before-exit section", async () => {
  for (const [name, text] of await scanFamily()) {
    assertEquals(
      text.split("\n").filter((line) => line.trim() === VERIFICATION_HEADING)
        .length,
      1,
      `prompts/${name}/${PROMPT_FILENAME} must carry exactly one ` +
        `"${VERIFICATION_HEADING}" heading`,
    );
  }
});

Deno.test("each verification section names the filed issues it re-reads", async () => {
  for (const [name, text] of await scanFamily()) {
    const lines = text.split("\n");
    const start = lines.findIndex((line) =>
      line.trim() === VERIFICATION_HEADING
    );
    assert(start >= 0, `prompts/${name} has no ${VERIFICATION_HEADING}`);
    const rest = lines.slice(start + 1);
    const end = rest.findIndex((line) => line.startsWith("#"));
    const body = (end < 0 ? rest : rest.slice(0, end)).join("\n");

    assert(
      /before exit/i.test(body),
      `prompts/${name}: the verification section does not say it runs ` +
        "before the run exits",
    );
    // What it re-reads is the run's own filed issues, and the way it fixes
    // a deviation is `gh issue edit` — a section naming neither is a
    // checklist with no subject.
    assert(
      /\bfiled\b/i.test(body),
      `prompts/${name}: the verification section does not name the filed ` +
        "issues it re-reads",
    );
    assert(
      body.includes("gh issue edit"),
      `prompts/${name}: the verification section does not say how to fix a ` +
        "deviation it finds",
    );
  }
});

// ---------------------------------------------------------------------------
// Narrowed claim — the surfaces no model reads
// ---------------------------------------------------------------------------

Deno.test("the checklist records the wrapper-issue-body surface kind", async () => {
  const body = section(await readChecklist(), "Applicability");

  assert(
    body.includes("Wrapper issue body"),
    "the checklist does not record the third surface kind",
  );
  for (const [directory] of WRAPPER_ISSUE_BODIES) {
    assert(
      body.includes(`prompts/${directory}/`),
      `the wrapper-issue-body kind does not cite prompts/${directory}/`,
    );
  }
});

Deno.test("row 5 exempts the surfaces no model reads", async () => {
  const rows = tableRows(section(await readChecklist(), "Checklist"));
  const row = rows.find((cells) => cells[0] === "5");
  assert(row, "the checklist has no row 5");

  const notApplicable = row[4] ?? "";
  assert(
    /wrapper issue body/i.test(notApplicable),
    "row 5 still scores a persona on a surface no model reads; its n/a " +
      "definition does not name the wrapper-issue-body kind",
  );
});

Deno.test("the exempt prompts really are rendered as the filed issue body", async () => {
  for (const [directory, slug] of WRAPPER_ISSUE_BODIES) {
    const template = getTemplate(slug);
    assert(template, `no idle-task template is registered as "${slug}"`);

    // The registered template loads through `getPromptsDir()`, so the
    // comparison side resolves the same way — the contract under test is
    // "the body IS the template's own prompt.md", and reading the two through
    // different resolutions would test the environment instead. The other
    // tests in this file pin `prompts/` to this checkout by parameter.
    const loaded = await loadPrompt(directory);
    assert(loaded.ok, `could not load prompts/${directory}/${PROMPT_FILENAME}`);
    const [head, tail] = loaded.value.split("{{ATTRIBUTION_FOOTER}}");
    assert(
      tail !== undefined,
      `prompts/${directory}/${PROMPT_FILENAME} carries no attribution footer`,
    );

    const body = await template.buildIssueBody({
      repo: "stSoftwareAU/VibeCoder",
      pickedAt: "2026-01-01T00:00:00Z",
      workerUser: "vibe-coder",
    });

    assert(
      body.startsWith(head!) && body.endsWith(tail!),
      `${template.name} does not render prompts/${directory}/` +
        `${PROMPT_FILENAME} as the filed issue body, so the ` +
        "wrapper-issue-body exemption is stale",
    );
  }
});

Deno.test("the vocabulary points at the settled presence decision", async () => {
  const vocabulary = await Deno.readTextFile(`${REPO_ROOT}${VOCABULARY_PATH}`);
  const body = section(vocabulary, "Out of scope");

  assert(
    body.includes("841"),
    `${VOCABULARY_PATH} does not record where the presence-gap decision landed`,
  );
  assert(
    body.includes(CHECKLIST_PATH),
    `${VOCABULARY_PATH} does not point at the checklist the decision is ` +
      "recorded in",
  );
  assert(
    /wrapper issue bod/i.test(body),
    `${VOCABULARY_PATH} does not record which way the persona gap went`,
  );
  assert(
    body.includes(VERIFICATION_HEADING),
    `${VOCABULARY_PATH} does not record which way the closing-check gap went`,
  );
});
