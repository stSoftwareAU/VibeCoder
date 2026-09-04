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
 *  - `idleTaskPromptsDir` maps a body build's root directory to the prompts
 *    directory it reads from, and a named root really does decide which tree
 *    a wrapper body is built out of (Issue #1024)
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import {
  assert,
  assertEquals,
  assertRejects,
  assertStringIncludes,
  assertThrows,
} from "@std/assert";
import {
  getTemplate,
  idleTaskPromptsDir,
  type IdleTaskTemplate,
  listTemplates,
  registerTemplate,
} from "../lib/idle_task_template.ts";

// Import the built-in template modules for their registration side-effect.
import "../lib/idle_task_templates/security_scan_template.ts";
import "../lib/idle_task_templates/dead_code_template.ts";
import { REPO_ROOT } from "./support/repo_root.ts";

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
      rootDir: REPO_ROOT,
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

// ---------------------------------------------------------------------------
// The root-directory seam (Issue #1024)
// ---------------------------------------------------------------------------

Deno.test("idleTaskPromptsDir - an unnamed root leaves resolution to production", () => {
  assertEquals(idleTaskPromptsDir({}), undefined);
  assertEquals(idleTaskPromptsDir({ rootDir: undefined }), undefined);
  // An empty string is not a directory — treat it as "unnamed" rather than
  // resolving to the process's root.
  assertEquals(idleTaskPromptsDir({ rootDir: "" }), undefined);
});

Deno.test("idleTaskPromptsDir - a named root resolves to its prompts directory", () => {
  assertEquals(
    idleTaskPromptsDir({ rootDir: "/srv/vibe" }),
    "/srv/vibe/prompts",
  );
  // REPO_ROOT carries a trailing slash; a doubled separator must not survive.
  assertEquals(
    idleTaskPromptsDir({ rootDir: "/srv/vibe/" }),
    "/srv/vibe/prompts",
  );
  assertEquals(
    idleTaskPromptsDir({ rootDir: "/srv/vibe///" }),
    "/srv/vibe/prompts",
  );
});

Deno.test(
  "idle_task_template - a named root decides which tree the body is built from",
  async () => {
    const tpl = getTemplate("dead-code");
    assert(tpl !== undefined);

    // Give the root a prompts tree of its own, carrying a line this checkout's
    // copy does not. The built body must show that line, which it can only do
    // if the named root — not this checkout, not `PROMPTS_DIR`, not the
    // working directory — is what was read.
    const marker = "Seam marker for Issue #1024.";
    const root = await Deno.makeTempDir({ prefix: "idle_task_root_" });
    try {
      const promptDir = `${root}/prompts/dead_code`;
      await Deno.mkdir(promptDir, { recursive: true });
      const canonical = await Deno.readTextFile(
        `${REPO_ROOT}prompts/dead_code/prompt.md`,
      );
      await Deno.writeTextFile(
        `${promptDir}/prompt.md`,
        `${canonical}\n\n${marker}\n`,
      );

      const fromTemp = await Promise.resolve(tpl!.buildIssueBody({
        repo: "acme/widget",
        pickedAt: "2026-05-13T10:20:30.000Z",
        workerUser: "vibe-coder-bot",
        rootDir: root,
      }));
      assertStringIncludes(fromTemp, marker);

      // The same build against this checkout has no such line — proof the
      // marker came from the named root rather than from the prompt itself.
      const fromCheckout = await Promise.resolve(tpl!.buildIssueBody({
        repo: "acme/widget",
        pickedAt: "2026-05-13T10:20:30.000Z",
        workerUser: "vibe-coder-bot",
        rootDir: REPO_ROOT,
      }));
      assert(
        !fromCheckout.includes(marker),
        "this checkout's prompt must not carry the seam marker",
      );
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);

Deno.test(
  "idle_task_template - a root with no prompts tree fails loud naming it",
  async () => {
    const tpl = getTemplate("security-scan");
    assert(tpl !== undefined);

    const root = await Deno.makeTempDir({ prefix: "idle_task_empty_root_" });
    try {
      const err = await assertRejects(
        () =>
          Promise.resolve(tpl!.buildIssueBody({
            repo: "acme/widget",
            pickedAt: "2026-05-13T10:20:30.000Z",
            workerUser: "vibe-coder-bot",
            rootDir: root,
          })),
        Error,
      );
      // The named root is what was searched — not PROMPTS_DIR, not this
      // checkout, not the working directory.
      assertStringIncludes(err.message, `${root}/prompts/security_scan`);
    } finally {
      await Deno.remove(root, { recursive: true });
    }
  },
);
