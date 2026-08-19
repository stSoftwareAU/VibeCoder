/**
 * Tests for the setup-time gitignore + gitattributes sync module
 * (Issues #1774, #2340).
 *
 * Covers the three branches of `syncGitignoreForAllRepos`:
 *   1. Repo not cloned yet → counted as `skipped`, no error.
 *   2. Repo already cloned → both enforcers run, patterns applied.
 *   3. Already-protected repo → re-running is a no-op for both files.
 *   4. Repo with custom `.gitattributes` → merge behaviour: existing
 *      lines survive verbatim and the canonical block is appended.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";
import { syncGitignoreForAllRepos } from "../setup/gitignore_sync.ts";
import {
  REQUIRED_GITATTRIBUTES_LINES,
  REQUIRED_GITIGNORE_PATTERNS,
  VIBE_CODER_BLOCK_END_MARKER,
  VIBE_CODER_BLOCK_MARKER,
  VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER,
  VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER,
} from "../lib/gitignore_enforcer.ts";

Deno.test("syncGitignoreForAllRepos - skips repos that have not been cloned", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "gitignore_sync_skip_" });
  try {
    const summary = await syncGitignoreForAllRepos(["org/missing"], workDir);
    assertEquals(summary.total, 1);
    assertEquals(summary.applied, 0);
    assertEquals(summary.skipped, 1);
    assertEquals(summary.failed, 0);
    assert(summary.results[0]!.skippedReason);
    // The new gitattributes arrays exist and are empty for skipped repos.
    assertEquals(summary.results[0]!.gitattributesAdded, []);
    assertEquals(summary.results[0]!.gitattributesExisted, []);
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("syncGitignoreForAllRepos - applies patterns to a cloned repo", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "gitignore_sync_apply_" });
  try {
    await Deno.mkdir(`${workDir}/repo`);
    const summary = await syncGitignoreForAllRepos(["org/repo"], workDir);
    assertEquals(summary.applied, 1);
    assertEquals(summary.skipped, 0);
    assertEquals(summary.failed, 0);
    assertEquals(
      summary.results[0]!.added.length,
      REQUIRED_GITIGNORE_PATTERNS.length,
    );
    const gitignore = await Deno.readTextFile(`${workDir}/repo/.gitignore`);
    assert(gitignore.includes(VIBE_CODER_BLOCK_MARKER));
    assert(gitignore.includes(VIBE_CODER_BLOCK_END_MARKER));

    // `.gitattributes` is also created and contains the canonical block.
    assertEquals(
      summary.results[0]!.gitattributesAdded.length,
      REQUIRED_GITATTRIBUTES_LINES.length,
    );
    const gitattributes = await Deno.readTextFile(
      `${workDir}/repo/.gitattributes`,
    );
    assert(gitattributes.includes(VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER));
    assert(gitattributes.includes(VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER));
    // Every canonical line must be present.
    for (const line of REQUIRED_GITATTRIBUTES_LINES) {
      assert(
        gitattributes.includes(line),
        `expected canonical line "${line}" in .gitattributes`,
      );
    }
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("syncGitignoreForAllRepos - second run is a no-op on a protected repo", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "gitignore_sync_idempotent_",
  });
  try {
    await Deno.mkdir(`${workDir}/repo`);
    await syncGitignoreForAllRepos(["org/repo"], workDir);
    const gitignoreBefore = await Deno.readTextFile(
      `${workDir}/repo/.gitignore`,
    );
    const gitattributesBefore = await Deno.readTextFile(
      `${workDir}/repo/.gitattributes`,
    );

    const summary = await syncGitignoreForAllRepos(["org/repo"], workDir);
    assertEquals(summary.applied, 1);
    assertEquals(summary.results[0]!.added.length, 0);
    assertEquals(
      summary.results[0]!.existed.length,
      REQUIRED_GITIGNORE_PATTERNS.length,
    );
    assertEquals(summary.results[0]!.gitattributesAdded.length, 0);
    assertEquals(
      summary.results[0]!.gitattributesExisted.length,
      REQUIRED_GITATTRIBUTES_LINES.length,
    );

    const gitignoreAfter = await Deno.readTextFile(
      `${workDir}/repo/.gitignore`,
    );
    const gitattributesAfter = await Deno.readTextFile(
      `${workDir}/repo/.gitattributes`,
    );
    assertEquals(
      gitignoreBefore,
      gitignoreAfter,
      "second run must not modify .gitignore",
    );
    assertEquals(
      gitattributesBefore,
      gitattributesAfter,
      "second run must not modify .gitattributes",
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("syncGitignoreForAllRepos - mixed cloned and missing repos", async () => {
  const workDir = await Deno.makeTempDir({ prefix: "gitignore_sync_mixed_" });
  try {
    await Deno.mkdir(`${workDir}/cloned`);
    const summary = await syncGitignoreForAllRepos(
      ["org/cloned", "org/missing"],
      workDir,
    );
    assertEquals(summary.total, 2);
    assertEquals(summary.applied, 1);
    assertEquals(summary.skipped, 1);
    assertEquals(summary.failed, 0);
    // The applied repo also has `.gitattributes`.
    const appliedResult = summary.results.find((r) => r.repo === "org/cloned")!;
    assertEquals(
      appliedResult.gitattributesAdded.length,
      REQUIRED_GITATTRIBUTES_LINES.length,
    );
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});

Deno.test("syncGitignoreForAllRepos - merges with a pre-existing custom .gitattributes", async () => {
  const workDir = await Deno.makeTempDir({
    prefix: "gitignore_sync_merge_",
  });
  try {
    await Deno.mkdir(`${workDir}/repo`);
    // Pre-existing custom rules a repo maintainer might have authored.
    const customContent = [
      "# Project-specific attributes (do not clobber)",
      "*.md text eol=lf",
      "*.rs text=auto",
      "",
    ].join("\n");
    await Deno.writeTextFile(
      `${workDir}/repo/.gitattributes`,
      customContent,
    );

    const summary = await syncGitignoreForAllRepos(["org/repo"], workDir);
    assertEquals(summary.applied, 1);
    assertEquals(summary.failed, 0);
    // The canonical lines are appended in the marker block; the custom
    // `*.rs text=auto` line is a literal canonical line minus prefix, but
    // `* text=auto` itself is not present in the custom content, so all
    // canonical lines should be added.
    assert(summary.results[0]!.gitattributesAdded.length > 0);

    const after = await Deno.readTextFile(`${workDir}/repo/.gitattributes`);
    // Custom rules survive verbatim.
    assert(
      after.includes("# Project-specific attributes (do not clobber)"),
      "custom comment must survive merge",
    );
    assert(
      after.includes("*.md text eol=lf"),
      "custom *.md rule must survive merge",
    );
    assert(
      after.includes("*.rs text=auto"),
      "custom *.rs rule must survive merge",
    );
    // Canonical block is appended below.
    assert(after.includes(VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER));
    assert(after.includes(VIBE_CODER_GITATTRIBUTES_BLOCK_END_MARKER));
    // The custom content must precede the canonical block (append, not
    // prepend, to preserve user precedence in git-attributes evaluation
    // order).
    const customIdx = after.indexOf("# Project-specific attributes");
    const markerIdx = after.indexOf(VIBE_CODER_GITATTRIBUTES_BLOCK_MARKER);
    assert(
      customIdx < markerIdx,
      "custom content must precede the canonical block",
    );

    // Re-running is a no-op — confirms the merge is idempotent at the
    // sync layer (not just the enforcer).
    const summary2 = await syncGitignoreForAllRepos(["org/repo"], workDir);
    assertEquals(summary2.results[0]!.gitattributesAdded.length, 0);
    const afterSecond = await Deno.readTextFile(
      `${workDir}/repo/.gitattributes`,
    );
    assertEquals(after, afterSecond, "second run must not modify the file");
  } finally {
    await Deno.remove(workDir, { recursive: true });
  }
});
