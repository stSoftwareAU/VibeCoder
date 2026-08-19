/**
 * Tests for the docs prompt-version freshness check (Issue #2286).
 *
 * Covers:
 *   - clean repo (passes),
 *   - stale reference in DESIGN-PRINCIPLES.md / AGENTS.md / docs (fails),
 *   - "from vN" wording exempt,
 *   - "vN onward" / "vN onwards" wording exempt,
 *   - `<!-- pinned: ... -->` HTML marker exempt,
 *   - docs/archive/ subtree excluded outright,
 *   - latest version reference passes,
 *   - SKIPPED on a repo without docs or prompts,
 *   - the actual repository tree passes (regression guard).
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  collectDocsFiles,
  isMatchExempt,
  runDocsPromptVersionCheck,
  scanContent,
} from "../lib/docs_prompt_version_check.ts";

interface FixtureSpec {
  /** Map of relative path → file content. */
  files: Record<string, string>;
  /** Map of prompts/<type>/<file> → content. */
  prompts: Record<string, string>;
}

async function makeFixture(spec: FixtureSpec): Promise<string> {
  const dir = await Deno.makeTempDir({ prefix: "docs_prompt_version_" });
  for (const [relPath, content] of Object.entries(spec.files)) {
    const absPath = `${dir}/${relPath}`;
    const slash = absPath.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(absPath.slice(0, slash), { recursive: true });
    }
    await Deno.writeTextFile(absPath, content);
  }
  for (const [relPath, content] of Object.entries(spec.prompts)) {
    const absPath = `${dir}/prompts/${relPath}`;
    const slash = absPath.lastIndexOf("/");
    if (slash > 0) {
      await Deno.mkdir(absPath.slice(0, slash), { recursive: true });
    }
    await Deno.writeTextFile(absPath, content);
  }
  return dir;
}

// --- isMatchExempt ---

Deno.test("isMatchExempt - pinned HTML marker on line is exempt", () => {
  const line = "See `prompts/issue/v3.md` <!-- pinned: regression record -->";
  const matchIndex = line.indexOf("prompts/");
  const matchLength = "prompts/issue/v3.md".length;
  assertEquals(isMatchExempt(line, matchIndex, matchLength), true);
});

Deno.test("isMatchExempt - `from vN onward` wording is exempt", () => {
  const line = "From `prompts/coding_guidelines/v23.md` onward, behaviour X";
  const matchIndex = line.indexOf("prompts/");
  const matchLength = "prompts/coding_guidelines/v23.md".length;
  assertEquals(isMatchExempt(line, matchIndex, matchLength), true);
});

Deno.test("isMatchExempt - `onwards` (plural) wording is exempt", () => {
  const line = "from prompts/issue/v3 onwards the worker behaviour changed";
  const matchIndex = line.indexOf("prompts/");
  const matchLength = "prompts/issue/v3".length;
  assertEquals(isMatchExempt(line, matchIndex, matchLength), true);
});

Deno.test("isMatchExempt - bare reference is NOT exempt", () => {
  const line = "Edit prompts/issue/v3.md to update the prompt";
  const matchIndex = line.indexOf("prompts/");
  const matchLength = "prompts/issue/v3.md".length;
  assertEquals(isMatchExempt(line, matchIndex, matchLength), false);
});

Deno.test("isMatchExempt - 'from' keyword in unrelated position is NOT exempt", () => {
  // 'from' appears earlier but not immediately before the match.
  const line = "Use input from a file; see prompts/issue/v3.md for context";
  const matchIndex = line.indexOf("prompts/");
  const matchLength = "prompts/issue/v3.md".length;
  assertEquals(isMatchExempt(line, matchIndex, matchLength), false);
});

// --- collectDocsFiles ---

Deno.test("collectDocsFiles - finds root instruction docs, AGENTS.md, and docs/*.md", async () => {
  const dir = await makeFixture({
    files: {
      "DESIGN-PRINCIPLES.md": "# claude",
      "AGENTS.md": "# agents",
      "docs/foo.md": "# foo",
      "docs/sub/bar.md": "# bar",
      "docs/archive/pr-summaries/pr-summary-1.md": "# old",
      "docs/archive/pr-summaries/sub/pr-summary-2.md": "# old nested",
      "README.md": "# readme — not in scope",
      "docs/other.txt": "ignored",
    },
    prompts: { "issue/v1.md": "x" },
  });
  try {
    const files = await collectDocsFiles(dir);
    assertEquals(files, [
      "AGENTS.md",
      "DESIGN-PRINCIPLES.md",
      "docs/foo.md",
      "docs/sub/bar.md",
    ]);
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- runDocsPromptVersionCheck ---

Deno.test("runDocsPromptVersionCheck - clean docs pass", async () => {
  const dir = await makeFixture({
    files: {
      "DESIGN-PRINCIPLES.md": "See `prompts/issue/` for the latest version.\n",
      "AGENTS.md": "Documented in `prompts/coding_guidelines/`.\n",
      "docs/foo.md": "Use `prompts/issue/` here.\n",
    },
    prompts: {
      "issue/v1.md": "x",
      "issue/v2.md": "x",
      "coding_guidelines/v1.md": "x",
    },
  });
  try {
    const result = await runDocsPromptVersionCheck(dir);
    assertEquals(result.status, "PASSED");
    assertEquals(result.violations.length, 0);
    assertStringIncludes(result.output, "docs prompt versions: PASSED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDocsPromptVersionCheck - stale reference fails with clear message", async () => {
  const dir = await makeFixture({
    files: {
      "DESIGN-PRINCIPLES.md":
        "Edit `prompts/coding_guidelines/v1.md` for the rule.\n",
    },
    prompts: {
      "coding_guidelines/v1.md": "x",
      "coding_guidelines/v2.md": "x",
      "coding_guidelines/v3.md": "x",
    },
  });
  try {
    const result = await runDocsPromptVersionCheck(dir);
    assertEquals(result.status, "FAILED");
    assertEquals(result.violations.length, 1);
    const v = result.violations[0]!;
    assertEquals(v.file, "DESIGN-PRINCIPLES.md");
    assertEquals(v.line, 1);
    assertEquals(v.promptType, "coding_guidelines");
    assertEquals(v.referencedVersion, "v1");
    assertEquals(v.latestVersion, "v3");
    assertStringIncludes(result.output, "DESIGN-PRINCIPLES.md:1");
    assertStringIncludes(result.output, "latest is v3");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDocsPromptVersionCheck - latest version reference passes", async () => {
  const dir = await makeFixture({
    files: {
      "DESIGN-PRINCIPLES.md":
        "Edit `prompts/issue/v2.md` for the latest version.\n",
    },
    prompts: { "issue/v1.md": "x", "issue/v2.md": "x" },
  });
  try {
    const result = await runDocsPromptVersionCheck(dir);
    assertEquals(result.status, "PASSED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDocsPromptVersionCheck - 'from vN onward' wording exempts a stale match", async () => {
  const dir = await makeFixture({
    files: {
      "DESIGN-PRINCIPLES.md":
        "The coding-guidelines prompt (`prompts/coding_guidelines/`, from `v1.md` onward) warns Claude.\n" +
        "Behaviour introduced in `prompts/issue/v2` onwards is preserved.\n",
    },
    prompts: {
      "coding_guidelines/v1.md": "x",
      "coding_guidelines/v3.md": "x",
      "issue/v2.md": "x",
      "issue/v5.md": "x",
    },
  });
  try {
    const result = await runDocsPromptVersionCheck(dir);
    assertEquals(
      result.status,
      "PASSED",
      `expected pass but got: ${result.output}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDocsPromptVersionCheck - <!-- pinned: --> marker exempts a stale match", async () => {
  const dir = await makeFixture({
    files: {
      "docs/HISTORY.md": "The bug was introduced by `prompts/issue/v1.md` " +
        "<!-- pinned: historical reference for incident #42 -->\n",
    },
    prompts: { "issue/v1.md": "x", "issue/v2.md": "x", "issue/v3.md": "x" },
  });
  try {
    const result = await runDocsPromptVersionCheck(dir);
    assertEquals(
      result.status,
      "PASSED",
      `expected pass but got: ${result.output}`,
    );
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test(
  "runDocsPromptVersionCheck - docs/archive/ subtree is excluded",
  async () => {
    const dir = await makeFixture({
      files: {
        "docs/archive/pr-summaries/pr-summary-1.md":
          "Added `prompts/coding_guidelines/v1.md` for the original rule.\n",
        "docs/archive/pr-summaries/nested/pr-summary-2.md":
          "Bumped from `prompts/issue/v1.md` to v2.\n",
        "docs/archive/audits/some-audit.md":
          "**Modified:** `prompts/coding_guidelines/v1.md`\n",
        "DESIGN-PRINCIPLES.md":
          "Latest lives in `prompts/coding_guidelines/`.\n",
      },
      prompts: {
        "coding_guidelines/v1.md": "x",
        "coding_guidelines/v2.md": "x",
        "issue/v1.md": "x",
        "issue/v3.md": "x",
      },
    });
    try {
      const result = await runDocsPromptVersionCheck(dir);
      assertEquals(result.status, "PASSED");
      // archive files must not even appear in the scanned set.
      const files = await collectDocsFiles(dir);
      for (const f of files) {
        if (f.startsWith("docs/archive/")) {
          throw new Error(`archive file leaked into scan: ${f}`);
        }
      }
    } finally {
      await Deno.remove(dir, { recursive: true });
    }
  },
);

Deno.test("runDocsPromptVersionCheck - unknown prompt type is ignored", async () => {
  // A reference to a prompt type that does not exist on disk should not
  // produce a violation — typos and forward-references are out of scope.
  const dir = await makeFixture({
    files: {
      "DESIGN-PRINCIPLES.md":
        "Reference `prompts/no_such_prompt/v1.md` here.\n",
    },
    prompts: { "issue/v1.md": "x" },
  });
  try {
    const result = await runDocsPromptVersionCheck(dir);
    assertEquals(result.status, "PASSED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDocsPromptVersionCheck - SKIPPED when no docs present", async () => {
  const dir = await Deno.makeTempDir({ prefix: "docs_prompt_version_empty_" });
  try {
    const result = await runDocsPromptVersionCheck(dir);
    assertEquals(result.status, "SKIPPED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

Deno.test("runDocsPromptVersionCheck - SKIPPED when no prompts/ directory", async () => {
  const dir = await makeFixture({
    files: { "DESIGN-PRINCIPLES.md": "# claude\n" },
    prompts: {},
  });
  try {
    // Remove the (empty) prompts/ directory to simulate a non-VibeCoder repo.
    try {
      await Deno.remove(`${dir}/prompts`, { recursive: true });
    } catch { /* ignore */ }
    const result = await runDocsPromptVersionCheck(dir);
    assertEquals(result.status, "SKIPPED");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- scanContent (line-level matching) ---

Deno.test("scanContent - multiple matches on one line reported individually", async () => {
  const dir = await makeFixture({
    files: {},
    prompts: {
      "issue/v1.md": "x",
      "issue/v5.md": "x",
      "coding_guidelines/v1.md": "x",
      "coding_guidelines/v3.md": "x",
    },
  });
  try {
    const content =
      "Edit `prompts/issue/v1.md` and `prompts/coding_guidelines/v1.md` both.\n";
    const { violations, references } = await scanContent(
      "DESIGN-PRINCIPLES.md",
      content,
      `${dir}/prompts`,
    );
    assertEquals(references, 2);
    assertEquals(violations.length, 2);
    assertEquals(violations[0]!.promptType, "issue");
    assertEquals(violations[1]!.promptType, "coding_guidelines");
  } finally {
    await Deno.remove(dir, { recursive: true });
  }
});

// --- Regression guard against the actual repository ---

Deno.test("runDocsPromptVersionCheck - actual repo tree has no stale references", async () => {
  // Resolve the repo root by walking up from this test file until we
  // find the `prompts/` directory + `DESIGN-PRINCIPLES.md` — the same layout the
  // check expects to find at runtime.
  const moduleDir = new URL(".", import.meta.url).pathname.replace(/\/$/, "");
  // tests/ → worker/deno/ → worker/ → repo root
  const repoRoot = `${moduleDir}/../../..`;
  const result = await runDocsPromptVersionCheck(repoRoot);
  if (result.status === "FAILED") {
    throw new Error(
      `Stale prompt-version references detected in the live repo:\n${result.output}`,
    );
  }
  // PASSED or SKIPPED both acceptable — SKIPPED only when the test is
  // run outside the VibeCoder tree (no docs/prompts).
  assertEquals(
    result.status === "PASSED" || result.status === "SKIPPED",
    true,
    `unexpected status: ${result.status} — ${result.output}`,
  );
});
