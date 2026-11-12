/**
 * Documentation regression checks. Issue #5019 replaces routine mutation-proof
 * requirements with current-change coverage review and deterministic regressions.
 * These cases retain the relevant rule, scope and twin-document guarantees.
 * Behavioural tests in this file remain unchanged.
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  assertPins,
  DRIFT_PINS_TASK,
  pinsAlreadyInSection,
  pinsAlreadyOnBase,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";
import {
  commitFile,
  gitOk,
  setupGitRepoFixture,
} from "./support/git_repo_fixture.ts";

const BASE_DOC = [
  "# Page",
  "",
  "## Escalation",
  "",
  "Escalate with the needs-human",
  "label when the fix fails.",
  "",
  "## Other",
  "",
  "Add the label with --add-label needs-human here.",
  "",
].join("\n");

Deno.test("pinsAlreadyInSection - lists only the phrases the base section already held", () => {
  assertEquals(
    pinsAlreadyInSection(BASE_DOC, "Escalation", [
      "needs-human label",
      "--add-label needs-human",
    ]),
    ["needs-human label"],
  );
});

Deno.test("pinsAlreadyInSection - a phrase held only in another section is not on base", () => {
  // `--add-label needs-human` sits under "Other", not "Escalation".
  assertEquals(
    pinsAlreadyInSection(BASE_DOC, "Escalation", ["--add-label needs-human"]),
    [],
  );
});

Deno.test("pinsAlreadyInSection - a section or doc absent on base holds no pins", () => {
  assertEquals(pinsAlreadyInSection(BASE_DOC, "Brand new section", ["x"]), []);
  assertEquals(pinsAlreadyInSection(undefined, "Escalation", ["x"]), []);
});

Deno.test("pinsAlreadyOnBase - reads the doc at the base ref, not the work tree", async () => {
  const fixture = await setupGitRepoFixture("issue-3193-");
  try {
    const { clone } = fixture;
    await gitOk(["checkout", "-q", "-b", "base"], clone);
    await commitFile(clone, "doc.md", BASE_DOC, "base doc");
    await gitOk(["checkout", "-q", "-b", "feature"], clone);
    await commitFile(
      clone,
      "doc.md",
      BASE_DOC.replace(
        "label when the fix fails.",
        "label when the fix fails. Run gh with --add-label needs-human.",
      ),
      "add rule",
    );
    await commitFile(clone, "new.md", BASE_DOC, "new doc");

    assertEquals(
      await pinsAlreadyOnBase({
        doc: "doc.md",
        title: "Escalation",
        phrases: ["needs-human label", "--add-label needs-human"],
        baseRef: "base",
        repo: clone,
      }),
      ["needs-human label"],
    );
    // A doc the base ref never had is reported as not on base.
    assertEquals(
      await pinsAlreadyOnBase({
        doc: "new.md",
        title: "Escalation",
        phrases: ["needs-human label"],
        baseRef: "base",
        repo: clone,
      }),
      undefined,
    );
    // A base ref that does not resolve is an error, not an empty answer.
    await assertRejects(() =>
      pinsAlreadyOnBase({
        doc: "doc.md",
        title: "Escalation",
        phrases: ["needs-human label"],
        baseRef: "no-such-ref",
        repo: clone,
      })
    );
  } finally {
    await fixture.cleanup();
  }
});

// Documentation-drift tests (CODING-STANDARDS.md § Documentation-drift tests):
// the per-phrase rule itself, in the standard and in each prompt that restates
// it. The task name is imported, and the task must exist in deno.json.

Deno.test("deno.json - the per-phrase check is a runnable task", async () => {
  const config = JSON.parse(await readRepoDoc("worker/deno/deno.json"));
  assertStringIncludes(
    config.tasks[DRIFT_PINS_TASK],
    "tests/support/markdown_docs.ts",
  );
});

Deno.test("standards make per-phrase baseline comparison a diagnostic aid", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Documentation-drift tests",
    ),
    [
      "Every pinned phrase identifies the intended rule",
      "optional `deno task drift-pins-on-base`",
      "do not require a baseline run or proof log for every phrase",
    ],
  );
});

Deno.test("guidelines defer to scoped documentation rules", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Test Coverage Expectations",
    ),
    [
      "section-scoping and live-value rules",
      "Documentation-drift tests",
    ],
  );
});

Deno.test("issue prompt reviews pin relevance without proof campaigns", async () => {
  assertPins(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
    [
      "per-phrase relevance rules",
      "Do not require deliberate code breaks",
    ],
  );
});

Deno.test("feedback reviews canonical documentation scope", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
    [
      "section-scoping and live-source rules",
    ],
  );
});
