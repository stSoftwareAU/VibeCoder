/**
 * Tests for the idle-task template registry (Issues #1960, #2077).
 *
 * Covers:
 *  - registration of a new template
 *  - lookup by name
 *  - unknown name returns undefined
 *  - name validation rejects invalid slugs
 *  - the built-in security-scan template is registered at module load
 *  - security-scan files a human-style wrapper (`Run a security scan`)
 *    with the substituted prompt as the body (Issue #2077)
 */

import {
  assert,
  assertEquals,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  getTemplate,
  type IdleTaskTemplate,
  listTemplates,
  registerTemplate,
} from "../lib/idle_task_template.ts";

// Import the security-scan template module for its registration side-effect.
import "../lib/idle_task_templates/security_scan_template.ts";
import { pinPromptsToThisCheckout } from "./support/repo_prompts.ts";

// Prompts resolve against this checkout, never the worker host's (Issue #844).
pinPromptsToThisCheckout();

function makeTemplate(name: string): IdleTaskTemplate {
  return {
    name,
    description: `Test template ${name}`,
    buildIssueTitle: (repo) => `Run ${name} on ${repo}`,
    buildIssueBody: (opts) =>
      [
        `Template: ${name}`,
        `Repo: ${opts.repo}`,
        `Picked at: ${opts.pickedAt}`,
        `Worker: ${opts.workerUser}`,
        `Description: Test template ${name}`,
      ].join("\n"),
    runTask: () => Promise.resolve({ ok: true, summary: `${name} ran` }),
  };
}

Deno.test("idle_task_template - security-scan template registered at module load", () => {
  const tpl = getTemplate("security-scan");
  assert(tpl !== undefined, "security-scan template should be registered");
  assertEquals(tpl!.name, "security-scan");
  assert(tpl!.description.length > 0, "description should be non-empty");
});

Deno.test(
  "idle_task_template - security-scan template opts out of per-template milestone (Issue #2067)",
  () => {
    const tpl = getTemplate("security-scan");
    assert(tpl !== undefined, "security-scan template should be registered");
    assertEquals(
      tpl!.skipMilestone,
      true,
      "security-scan must opt out of the per-template milestone — its " +
        "findings are filed as standalone issues, so grouping the wrapper " +
        "issue under `idle-task: security-scan` would trigger the " +
        "milestone-completion → merge-PR flow (see #2062)",
    );
  },
);

Deno.test(
  "idle_task_template - skipMilestone field round-trips through register/get (Issue #2067)",
  () => {
    const tpl: IdleTaskTemplate = {
      ...makeTemplate("skip-milestone-roundtrip"),
      skipMilestone: true,
    };
    registerTemplate(tpl);
    const fetched = getTemplate("skip-milestone-roundtrip");
    assert(fetched !== undefined);
    assertEquals(fetched!.skipMilestone, true);
  },
);

Deno.test(
  "idle_task_template - skipMilestone defaults to undefined when not set (Issue #2067)",
  () => {
    const tpl = makeTemplate("skip-milestone-default");
    registerTemplate(tpl);
    const fetched = getTemplate("skip-milestone-default");
    assert(fetched !== undefined);
    assertEquals(fetched!.skipMilestone, undefined);
  },
);

Deno.test("idle_task_template - listTemplates includes security-scan", () => {
  const names = listTemplates().map((t) => t.name);
  assert(names.includes("security-scan"));
});

Deno.test("idle_task_template - registerTemplate then getTemplate roundtrip", () => {
  const tpl = makeTemplate("roundtrip-test");
  registerTemplate(tpl);
  const fetched = getTemplate("roundtrip-test");
  assertEquals(fetched, tpl);
});

Deno.test("idle_task_template - getTemplate returns undefined for unknown name", () => {
  assertEquals(getTemplate("does-not-exist-xyz"), undefined);
});

Deno.test("idle_task_template - registerTemplate rejects invalid slug (uppercase)", () => {
  assertThrows(
    () => registerTemplate(makeTemplate("Bad-Name")),
    Error,
    "invalid",
  );
});

Deno.test("idle_task_template - registerTemplate rejects invalid slug (leading hyphen)", () => {
  assertThrows(
    () => registerTemplate(makeTemplate("-leading")),
    Error,
    "invalid",
  );
});

Deno.test("idle_task_template - registerTemplate rejects invalid slug (trailing hyphen)", () => {
  assertThrows(
    () => registerTemplate(makeTemplate("trailing-")),
    Error,
    "invalid",
  );
});

Deno.test("idle_task_template - registerTemplate rejects invalid slug (underscore)", () => {
  assertThrows(
    () => registerTemplate(makeTemplate("under_score")),
    Error,
    "invalid",
  );
});

Deno.test("idle_task_template - registerTemplate rejects invalid slug (empty)", () => {
  assertThrows(
    () => registerTemplate(makeTemplate("")),
    Error,
    "invalid",
  );
});

Deno.test("idle_task_template - registerTemplate accepts numeric segments", () => {
  const tpl = makeTemplate("scan-v2");
  registerTemplate(tpl);
  assertEquals(getTemplate("scan-v2"), tpl);
});

Deno.test(
  "idle_task_template - security-scan title is the literal 'Run a security scan' regardless of repo (Issue #2077)",
  () => {
    const tpl = getTemplate("security-scan");
    assert(tpl !== undefined);
    assertEquals(tpl!.buildIssueTitle("acme/widget"), "Run a security scan");
    assertEquals(tpl!.buildIssueTitle("other/project"), "Run a security scan");
  },
);

Deno.test(
  "idle_task_template - security-scan body is the substituted prompt verbatim (Issue #2077)",
  async () => {
    const tpl = getTemplate("security-scan");
    assert(tpl !== undefined);
    const body = await Promise.resolve(tpl!.buildIssueBody({
      repo: "acme/widget",
      pickedAt: "2026-05-13T10:20:30.000Z",
      workerUser: "vibe-coder-bot",
    }));
    // No hidden idle-task marker is embedded.
    assert(
      !body.includes("<!-- idle-task:"),
      "human-style wrapper must not embed the idle-task marker",
    );
    // The substituted prompt body must carry the canonical heading.
    assertStringIncludes(
      body,
      "MythOS-style Security Audit",
    );
    // No raw `{{...}}` placeholders survive the substitution.
    // Issue #2135 (v6): the repo placeholder is gone — the worker's
    // cwd already points at the cloned repo.
    assert(
      !/\{\{[A-Z_]+\}\}/.test(body),
      "all prompt placeholders must be substituted at file time",
    );
  },
);
