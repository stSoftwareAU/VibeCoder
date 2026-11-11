/**
 * Tests for pr_summary_loader.ts — PR summary file loading with precedence.
 *
 * Issue #1186: Load PR summary content from file system during completion phase.
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  loadCommittedPrSummary,
  loadPrSummary,
} from "../lib/pr_summary_loader.ts";
import { normaliseSummaryVersionBumps } from "../lib/pr_summary_loader.ts";
import { runGitCommand } from "../lib/git_timeout.ts";

// ---------------------------------------------------------------------------
// Helpers
// ---------------------------------------------------------------------------

async function createTempDir(): Promise<string> {
  return await Deno.makeTempDir({ prefix: "pr-summary-test-" });
}

async function writeFile(
  dir: string,
  relativePath: string,
  content: string,
): Promise<void> {
  const fullPath = `${dir}/${relativePath}`;
  const parentDir = fullPath.substring(0, fullPath.lastIndexOf("/"));
  await Deno.mkdir(parentDir, { recursive: true });
  await Deno.writeTextFile(fullPath, content);
}

async function cleanupDir(dir: string): Promise<void> {
  try {
    await Deno.remove(dir, { recursive: true });
  } catch {
    // Best-effort cleanup
  }
}

/** Run real git in `dir` with a fixed identity and return trimmed stdout. */
async function git(dir: string, ...args: string[]): Promise<string> {
  const output = await new Deno.Command("git", {
    args: [
      "-c",
      "user.name=Test",
      "-c",
      "user.email=test@example.invalid",
      "-c",
      "commit.gpgsign=false",
      ...args,
    ],
    cwd: dir,
    stdin: "null",
    stdout: "piped",
    stderr: "piped",
  }).output();
  if (output.code !== 0) {
    throw new Error(
      `git ${args.join(" ")} failed: ${
        new TextDecoder().decode(output.stderr)
      }`,
    );
  }
  return new TextDecoder().decode(output.stdout).trim();
}

async function initRepo(dir: string): Promise<void> {
  await git(dir, "init", "-q");
}

/** Stage everything, commit, and return the new HEAD sha. */
async function commitAll(dir: string, message: string): Promise<string> {
  await git(dir, "add", "-A");
  await git(dir, "commit", "-q", "-m", message);
  return await git(dir, "rev-parse", "HEAD");
}

// ---------------------------------------------------------------------------
// Tests — file loading precedence
// ---------------------------------------------------------------------------

Deno.test("loadPrSummary - loads from docs/archive/pr-summaries/ (canonical, Issue #2173)", async () => {
  const dir = await createTempDir();
  try {
    const content = "## Summary\nArchive location content.";
    await writeFile(dir, "docs/archive/pr-summaries/pr-summary-42.md", content);

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, content);
      assertEquals(
        result.value.source,
        "docs/archive/pr-summaries/pr-summary-42.md",
      );
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - falls back to legacy docs/pr-summary-{N}.md", async () => {
  const dir = await createTempDir();
  try {
    const content = "## Summary\nLegacy loose-docs location content.";
    await writeFile(dir, "docs/pr-summary-42.md", content);

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, content);
      assertEquals(result.value.source, "docs/pr-summary-42.md");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - falls back to .pr_summary (legacy)", async () => {
  const dir = await createTempDir();
  try {
    const content = "Legacy PR summary content.";
    await writeFile(dir, ".pr_summary", content);

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, content);
      assertEquals(result.value.source, ".pr_summary");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - canonical archive takes precedence over legacy loose docs/ (Issue #2173)", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(dir, "docs/pr-summary-42.md", "Legacy loose content.");
    await writeFile(
      dir,
      "docs/archive/pr-summaries/pr-summary-42.md",
      "Archive content.",
    );
    await writeFile(dir, ".pr_summary", "Root legacy content.");

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "Archive content.");
      assertEquals(
        result.value.source,
        "docs/archive/pr-summaries/pr-summary-42.md",
      );
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - loose docs/ takes precedence over .pr_summary root legacy", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(dir, "docs/pr-summary-42.md", "Loose docs content.");
    await writeFile(dir, ".pr_summary", "Root legacy content.");

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "Loose docs content.");
      assertEquals(result.value.source, "docs/pr-summary-42.md");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - returns not_found when no summary file exists", async () => {
  const dir = await createTempDir();
  try {
    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "");
      assertEquals(result.value.source, "not_found");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - skips empty files", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(dir, "docs/archive/pr-summaries/pr-summary-42.md", "");
    await writeFile(dir, "docs/pr-summary-42.md", "Loose content.");

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "Loose content.");
      assertEquals(result.value.source, "docs/pr-summary-42.md");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - skips whitespace-only files", async () => {
  const dir = await createTempDir();
  try {
    await writeFile(
      dir,
      "docs/archive/pr-summaries/pr-summary-42.md",
      "   \n  \n  ",
    );
    await writeFile(dir, "docs/pr-summary-42.md", "   \n  \n  ");
    await writeFile(dir, ".pr_summary", "Legacy content.");

    const result = await loadPrSummary(dir, 42);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "Legacy content.");
      assertEquals(result.value.source, ".pr_summary");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - project bump statements are omitted across later workflow bumps, author wording kept (Issue #3954, Issue #4972)", async () => {
  const dir = await createTempDir();
  const path = "docs/archive/pr-summaries/pr-summary-42.md";
  try {
    const durable =
      "## Summary\n\nVersion bump: `VERSION` updated for this change; the merged commit records the final version.\n";
    for (const pair of ["1.2.3 → 1.2.4", "1.2.4 → 1.2.5", "1.2.3 → 1.3.0"]) {
      await writeFile(
        dir,
        path,
        `## Summary\n\nVersion bump: \`VERSION\` ${pair}\n`,
      );
      const result = await loadPrSummary(dir, 42);
      assertEquals(result.ok, true);
      if (result.ok) assertEquals(result.value.content, "## Summary\n\n");
    }
    await writeFile(dir, path, durable);
    const repeat = await loadPrSummary(dir, 42);
    assertEquals(repeat.ok && repeat.value.content, durable);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadPrSummary - meaningful exact versions and non-bump prose survive (Issue #3954)", async () => {
  const dir = await createTempDir();
  try {
    const content = [
      "## Summary",
      "",
      "Dependency pin: `zod` 3.0.0 → 4.0.0",
      "",
      "Version bump: `zod` 3.0.0 → 4.0.0",
      "",
      "No automatic bump: VERSION remains 1.2.3.",
      "",
      "```md",
      "Version bump: `VERSION` 1.2.3 → 1.2.4",
      "```",
      "",
      "``Wrapped example",
      "Version bump: `VERSION` 1.2.3 → 1.2.4",
      "end``",
      "",
      "## Evidence",
      "",
      "Release evidence: version 1.2.4 at commit abc123.",
      "Version bump: `VERSION` 1.2.3 → 1.2.4 (release abc123).",
      "",
      "## Changelog",
      "",
      "Version bump: `VERSION` 1.2.3 → 1.2.4",
      "",
      "## Migration",
      "",
      "Migrate from 1.2.3 to 2.0.0.",
      "",
    ].join("\n");
    await writeFile(dir, "docs/archive/pr-summaries/pr-summary-42.md", content);
    const result = await loadPrSummary(dir, 42);
    assertEquals(result.ok && result.value.content, content);
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("version normalisation preserves scope and layout across manifest and policy shapes (Issue #3954, Issue #4972)", () => {
  // Each bump line is omitted; the blank line after it is also omitted when it
  // sat between two blank lines, so every expected value is the header as written.
  for (
    const [header, line, expected] of [
      ["", "Version bump: `Cargo.toml` 1.2.3 → 1.3.0", ""],
      [
        "## Test Plan\n\n",
        "- **Version bump:** `package.json` `1.2.3` -> `2.0.0`.",
        "## Test Plan\n\n",
      ],
      [
        "## Summary\r\n\r\n",
        "Version bump: `deno.jsonc` v1.2.3 → v1.2.4",
        "## Summary\r\n\r\n",
      ],
      [
        "    literal example\n---\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "    literal example\n---\n\n",
      ],
      [
        "> ## Evidence\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "> ## Evidence\n\n",
      ],
      [
        "## Summary\n\nPreface\n\n---\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "## Summary\n\nPreface\n\n---\n\n",
      ],
      [
        "## Summary\n\nPreface\n***\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "## Summary\n\nPreface\n***\n\n",
      ],
      [
        "Summary\n=======\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "Summary\n=======\n\n",
      ],
      [
        "## Summary ##\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "## Summary ##\n\n",
      ],
      [
        "# PR Summary\n## Summary\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "# PR Summary\n## Summary\n\n",
      ],
      [
        "## Evidence\n\nRelease evidence: abc123.\n\n## Summary\n\n",
        "Version bump: `VERSION` 1.2.3 → 1.2.4",
        "## Evidence\n\nRelease evidence: abc123.\n\n## Summary\n\n",
      ],
    ] as const
  ) {
    const content = header + line + "\r\n";
    const result = normaliseSummaryVersionBumps(content);
    assertEquals(result, expected);
    assertEquals(normaliseSummaryVersionBumps(result), result);
  }
});

// ---------------------------------------------------------------------------
// Tests — stale literal bump lines are omitted, never replaced (Issue #4972)
// ---------------------------------------------------------------------------

Deno.test("version normalisation omits a stale literal bump for every manifest name and keeps surrounding prose (Issue #4972)", async () => {
  // Deploy owns versioning in this repository, so the PR changes no version file.
  const dir = await createTempDir();
  const path = "docs/archive/pr-summaries/pr-summary-42.md";
  const expected = [
    "## Summary",
    "",
    "Deploy owns versioning; this PR changes no version file.",
    "",
    "Dependency pin: `zod` 3.0.0 → 4.0.0",
    "",
    "## Evidence",
    "",
    "Release evidence: version 1.2.4 at commit abc123.",
    "",
  ].join("\n");
  try {
    for (
      const name of [
        "VERSION",
        "Cargo.toml",
        "package.json",
        "deno.json",
        "deno.jsonc",
      ]
    ) {
      await writeFile(
        dir,
        path,
        [
          "## Summary",
          "",
          "Deploy owns versioning; this PR changes no version file.",
          "",
          `Version bump: \`${name}\` 1.2.3 → 1.2.4`,
          "",
          "Dependency pin: `zod` 3.0.0 → 4.0.0",
          "",
          "## Evidence",
          "",
          "Release evidence: version 1.2.4 at commit abc123.",
          "",
        ].join("\n"),
      );
      const result = await loadPrSummary(dir, 42);
      assertEquals(result.ok, true);
      if (result.ok) {
        assertEquals(
          result.value.content.includes("updated for this change"),
          false,
        );
        assertEquals(result.value.content.includes("Version bump:"), false);
        assertEquals(result.value.content, expected);
      }
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("version normalisation removes a middle-of-document bump line leaving one blank line (Issue #4972)", () => {
  assertEquals(
    normaliseSummaryVersionBumps(
      "## Summary\n\nPara one.\n\nVersion bump: `VERSION` 1.2.3 → 1.2.4\n\nPara two.\n",
    ),
    "## Summary\n\nPara one.\n\nPara two.\n",
  );
  assertEquals(
    normaliseSummaryVersionBumps(
      "## Summary\r\n\r\nPara one.\r\n\r\nVersion bump: `VERSION` 1.2.3 → 1.2.4\r\n\r\nPara two.\r\n",
    ),
    "## Summary\r\n\r\nPara one.\r\n\r\nPara two.\r\n",
  );
});

Deno.test("version normalisation removes a list-item bump line between two items (Issue #4972)", () => {
  assertEquals(
    normaliseSummaryVersionBumps(
      "## Summary\n\n- one\n- **Version bump:** `package.json` `1.2.3` -> `2.0.0`.\n- two\n",
    ),
    "## Summary\n\n- one\n- two\n",
  );
});

Deno.test("version normalisation keeps the blank line after a bump list item that follows another item (Issue #4972)", () => {
  assertEquals(
    normaliseSummaryVersionBumps(
      "## Summary\n\n- one\n- **Version bump:** `package.json` `1.2.3` -> `2.0.0`.\n\nAfter.\n",
    ),
    "## Summary\n\n- one\n\nAfter.\n",
  );
});

Deno.test("version normalisation keeps the next line after a bump list item that follows a blank line (Issue #4972)", () => {
  assertEquals(
    normaliseSummaryVersionBumps(
      "## Summary\n\n- **Version bump:** `package.json` `1.2.3` -> `2.0.0`.\n- two\n",
    ),
    "## Summary\n\n- two\n",
  );
});

Deno.test("version normalisation removes a final bump line with no trailing newline (Issue #4972)", () => {
  assertEquals(
    normaliseSummaryVersionBumps(
      "## Summary\n\nVersion bump: `VERSION` 1.2.3 → 1.2.4",
    ),
    "## Summary\n\n",
  );
});

Deno.test("version normalisation returns a hostile over-long bump line unchanged (Issue #4972)", () => {
  const hostile = `## Summary\n\nVersion bump: ${" ".repeat(50_000)}x\n`;
  assertEquals(normaliseSummaryVersionBumps(hostile), hostile);
});

Deno.test("version normalisation preserves ambiguous ownership and release continuations (Issue #3954)", async () => {
  const dir = await createTempDir();
  const path = "docs/archive/pr-summaries/pr-summary-42.md";
  const pair = "Version bump: `VERSION` 1.2.3 → 1.2.4";
  try {
    for (
      const content of [
        `## Changelog\n### Summary\n${pair}\n`,
        `## Evidence\n### Summary\n${pair}\n`,
        `## PR Summary\n\n${pair}\n`,
        `## Summary###\n\n${pair}\n`,
        `# Historical reproduction\n## Summary\n${pair}\n`,
        `Historical reproduction\n-----------------------\n${pair}\n`,
        `## Summary\n\n    ${pair}\n`,
        `## Summary\n\n\t${pair}\n`,
        `## Summary\n\n${pair}\n(release abc123).\n`,
        "## Summary\n\nVersion bump: `vendor/sdk/package.json` 1.2.3 → 2.0.0\n",
      ]
    ) {
      await writeFile(dir, path, content);
      const result = await loadPrSummary(dir, 42);
      assertEquals(result.ok && result.value.content, content);
    }
  } finally {
    await cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Tests — committed PR summary (Issue #4712)
// ---------------------------------------------------------------------------

Deno.test("loadCommittedPrSummary - returns the committed summary, ignoring uncommitted working-tree edits (Issue #4712)", async () => {
  const dir = await createTempDir();
  const path = "docs/archive/pr-summaries/pr-summary-42.md";
  try {
    await initRepo(dir);
    const committed = "## Summary\nCommitted archive content.\n";
    await writeFile(dir, path, committed);
    const sha = await commitAll(dir, "add summary");
    await writeFile(
      dir,
      path,
      "## Summary\nUNCOMMITTED-MARKER edit that must not ship.\n",
    );

    const result = await loadCommittedPrSummary(dir, 42, sha, runGitCommand);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, committed);
      assertEquals(result.value.content.includes("UNCOMMITTED-MARKER"), false);
      assertEquals(result.value.source, path);
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadCommittedPrSummary - ignores a summary that exists only in the working tree (Issue #4712)", async () => {
  const dir = await createTempDir();
  try {
    await initRepo(dir);
    await writeFile(dir, "README.md", "Readme.\n");
    const sha = await commitAll(dir, "base");
    await writeFile(
      dir,
      "docs/archive/pr-summaries/pr-summary-42.md",
      "## Summary\nWorking tree only.\n",
    );

    const result = await loadCommittedPrSummary(dir, 42, sha, runGitCommand);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, "");
      assertEquals(result.value.source, "not_found");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadCommittedPrSummary - canonical archive wins at a commit, legacy falls back where archive is absent (Issue #4712)", async () => {
  const dir = await createTempDir();
  const legacy = "Legacy loose content.\n";
  try {
    await initRepo(dir);
    await writeFile(dir, "docs/pr-summary-42.md", legacy);
    const legacyOnly = await commitAll(dir, "legacy only");
    await writeFile(
      dir,
      "docs/archive/pr-summaries/pr-summary-42.md",
      "Archive content.\n",
    );
    const both = await commitAll(dir, "archive added");

    const archiveWins = await loadCommittedPrSummary(
      dir,
      42,
      both,
      runGitCommand,
    );
    assertEquals(archiveWins.ok, true);
    if (archiveWins.ok) {
      assertEquals(archiveWins.value.content, "Archive content.\n");
      assertEquals(
        archiveWins.value.source,
        "docs/archive/pr-summaries/pr-summary-42.md",
      );
    }

    const legacyFallback = await loadCommittedPrSummary(
      dir,
      42,
      legacyOnly,
      runGitCommand,
    );
    assertEquals(legacyFallback.ok, true);
    if (legacyFallback.ok) {
      assertEquals(legacyFallback.value.content, legacy);
      assertEquals(legacyFallback.value.source, "docs/pr-summary-42.md");
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadCommittedPrSummary - returns the committed summary when the working-tree file was deleted (Issue #4712)", async () => {
  const dir = await createTempDir();
  const path = "docs/archive/pr-summaries/pr-summary-42.md";
  try {
    await initRepo(dir);
    const committed = "## Summary\nCommitted then deleted locally.\n";
    await writeFile(dir, path, committed);
    const sha = await commitAll(dir, "add summary");
    await Deno.remove(`${dir}/${path}`);

    const result = await loadCommittedPrSummary(dir, 42, sha, runGitCommand);

    assertEquals(result.ok, true);
    if (result.ok) {
      assertEquals(result.value.content, committed);
      assertEquals(result.value.source, path);
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadCommittedPrSummary - an unknown well-formed sha is an error, not not_found (Issue #4712)", async () => {
  const dir = await createTempDir();
  const sha = "0123456789abcdef0123456789abcdef01234567";
  try {
    await initRepo(dir);
    await writeFile(dir, "README.md", "Readme.\n");
    await commitAll(dir, "base");

    const result = await loadCommittedPrSummary(dir, 42, sha, runGitCommand);

    assertEquals(result.ok, false);
    if (!result.ok) {
      assertEquals(
        result.error.message.includes(
          "docs/archive/pr-summaries/pr-summary-42.md",
        ),
        true,
      );
      assertEquals(result.error.message.includes(sha), true);
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadCommittedPrSummary - rejects a malformed sha before it reaches git (Issue #4712)", async () => {
  const dir = await createTempDir();
  try {
    await initRepo(dir);
    for (
      const sha of [
        "HEAD",
        "abc; rm -rf",
        "0123456789abcdef0123456789abcdef0123456",
      ]
    ) {
      const result = await loadCommittedPrSummary(dir, 42, sha, runGitCommand);
      assertEquals(result.ok, false);
      if (!result.ok) {
        assertEquals(result.error.message.includes("invalid commit sha"), true);
      }
    }
  } finally {
    await cleanupDir(dir);
  }
});

Deno.test("loadCommittedPrSummary - applies version-bump normalisation (Issue #4712)", async () => {
  const dir = await createTempDir();
  const path = "docs/archive/pr-summaries/pr-summary-42.md";
  try {
    await initRepo(dir);
    await writeFile(
      dir,
      path,
      "## Summary\n\nVersion bump: `VERSION` 1.2.3 → 1.2.4\n",
    );
    const sha = await commitAll(dir, "add summary");

    const result = await loadCommittedPrSummary(dir, 42, sha, runGitCommand);

    assertEquals(result.ok && result.value.content, "## Summary\n\n");
  } finally {
    await cleanupDir(dir);
  }
});

// ---------------------------------------------------------------------------
// Tests — committed read failures reach the caller as errors (Issue #4712)
// ---------------------------------------------------------------------------

const STUB_SHA = "a".repeat(40);

/** A git runner that answers `ls-tree` with `listed` and `show` with `shown`. */
function stubGit(
  listed: Awaited<ReturnType<typeof runGitCommand>>,
  shown: Awaited<ReturnType<typeof runGitCommand>>,
): typeof runGitCommand {
  return (args) => Promise.resolve(args[0] === "ls-tree" ? listed : shown);
}

const LISTED_OK = {
  ok: true,
  value: { code: 0, stdout: "path\0", stderr: "" },
} as const;

Deno.test("loadCommittedPrSummary - a failed ls-tree run is an error naming the cause (Issue #4712)", async () => {
  const result = await loadCommittedPrSummary(
    "/unused",
    42,
    STUB_SHA,
    stubGit({ ok: false, error: new Error("spawn blew up") }, LISTED_OK),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message,
      `Failed to read PR summary at docs/archive/pr-summaries/pr-summary-42.md in commit ${STUB_SHA}: spawn blew up`,
    );
  }
});

Deno.test("loadCommittedPrSummary - a non-zero ls-tree exit is an error with the first stderr line (Issue #4712)", async () => {
  const result = await loadCommittedPrSummary(
    "/unused",
    42,
    STUB_SHA,
    stubGit(
      {
        ok: true,
        value: { code: 128, stdout: "", stderr: "fatal: bad\nmore" },
      },
      LISTED_OK,
    ),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.endsWith(": fatal: bad"), true);
  }
});

Deno.test("loadCommittedPrSummary - a failed git show run is an error, not not_found (Issue #4712)", async () => {
  const result = await loadCommittedPrSummary(
    "/unused",
    42,
    STUB_SHA,
    stubGit(LISTED_OK, { ok: false, error: new Error("show spawn failed") }),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(
      result.error.message,
      `Failed to read PR summary at docs/archive/pr-summaries/pr-summary-42.md in commit ${STUB_SHA}: show spawn failed`,
    );
  }
});

Deno.test("loadCommittedPrSummary - a non-zero git show exit is an error even when stdout carries content (Issue #4712)", async () => {
  const result = await loadCommittedPrSummary(
    "/unused",
    42,
    STUB_SHA,
    stubGit(LISTED_OK, {
      ok: true,
      value: { code: 1, stdout: "## Summary\nPartial.\n", stderr: "" },
    }),
  );

  assertEquals(result.ok, false);
  if (!result.ok) {
    assertEquals(result.error.message.endsWith(": git exited 1"), true);
  }
});
