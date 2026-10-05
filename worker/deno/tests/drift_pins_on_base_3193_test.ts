/**
 * Issue #3193 — a documentation-drift test that pins a phrase its section
 * already held on the base branch can never fail. Checking "the test goes red
 * against main" is not enough when one test pins several phrases: one new pin
 * turns it red and hides the vacuous pin beside it (stSoftwareAU/VibeCoder#3156).
 *
 * `pinsAlreadyOnBase` does the check per phrase: it reads the doc at the base
 * ref, narrows it with the same `section()` title, and lists every pinned
 * phrase the base section already held.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertEquals, assertRejects, assertStringIncludes } from "@std/assert";
import {
  DRIFT_PINS_TASK,
  flat,
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

Deno.test("CODING-STANDARDS - condition 4 checks each pinned phrase, not each test", async () => {
  const text = flat(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Documentation-drift tests",
    ),
  );
  assertStringIncludes(text, "per pinned phrase, not per test");
  assertStringIncludes(text, "hides a vacuous pin");
  assertStringIncludes(text, `deno task ${DRIFT_PINS_TASK}`);
});

Deno.test("coding guidelines - a drift test's red run is checked per pinned phrase", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Test Coverage Expectations",
    ),
  );
  assertStringIncludes(text, "per pinned phrase, not per test");
  assertStringIncludes(text, `deno task ${DRIFT_PINS_TASK}`);
  assertStringIncludes(
    text,
    "each pinned phrase is absent from the base section",
  );
});

Deno.test("issue prompt - the Test Plan records each pinned phrase absent on base", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );
  assertStringIncludes(text, "per pinned phrase, not per test");
  assertStringIncludes(text, `deno task ${DRIFT_PINS_TASK}`);
  assertStringIncludes(
    text,
    "each pinned phrase is absent from the base section",
  );
});

Deno.test("pr_feedback prompt - the Test Plan records each pinned phrase absent on base", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );
  assertStringIncludes(text, "each pinned phrase on its own");
  assertStringIncludes(text, `deno task ${DRIFT_PINS_TASK}`);
  assertStringIncludes(
    text,
    "each pinned phrase is absent from the base section",
  );
});
