/**
 * Regression test — deprecated `awaiting-author` label must not be
 * reintroduced (Issue #1697, parent #1696, decision #1677).
 *
 * Background:
 *   The `awaiting-author` label was previously proposed as the "your
 *   turn" indicator, but #1677 chose to reuse the existing
 *   `needs-human` label instead. PR #1696 audited the codebase and
 *   confirmed no `awaiting-author` references remain. This test locks
 *   that decision in: any future PR that reintroduces the literal
 *   strings `awaiting-author` or `awaitingAuthor` into a tracked file
 *   fails the quality gate.
 *
 * Behaviour:
 *   - Enumerates tracked files via `git ls-files` (so untracked work
 *     trees, build artefacts, and `.git/`/`node_modules/` are
 *     automatically skipped).
 *   - Skips this test file itself so the literal pattern strings used
 *     here do not match.
 *   - Skips the PR-summary files for the parent and this issue so the
 *     historical context describing the cleanup does not match.
 *
 * Australian English spelling throughout (behaviour, colour,
 * organisation, favour, centre).
 */

import { assert, assertEquals } from "@std/assert";

/** Resolve the repository root (two levels up from worker/deno/tests). */
function repoRoot(): string {
  const thisDir = new URL(".", import.meta.url).pathname;
  // thisDir = ".../worker/deno/tests/" — strip the suffix.
  return thisDir.replace(/\/worker\/deno\/tests\/$/, "");
}

/** Path of this test file, relative to the repo root. */
function thisTestRelPath(): string {
  const filePath = new URL(import.meta.url).pathname;
  const root = repoRoot();
  return filePath.startsWith(`${root}/`)
    ? filePath.slice(root.length + 1)
    : filePath;
}

/**
 * Forbidden literal strings. Assembled from fragments via `join("")` so
 * that the tokens do not appear verbatim as a single substring in this
 * source file — but the self-exclusion based on file path is what the
 * issue mandates.
 */
const FORBIDDEN_TOKENS: readonly string[] = [
  ["awaiting", "-author"].join(""),
  ["awaiting", "Author"].join(""),
];

/**
 * Files that legitimately discuss the deprecated label for historical
 * context (PR summaries describing the cleanup). Paths are relative to
 * the repository root.
 */
const HISTORICAL_EXEMPTIONS: readonly string[] = [
  "docs/pr-summary-1693.md",
  "docs/pr-summary-1696.md",
  "docs/pr-summary-1697.md",
  // PR-summary archive paths — files are moved here under the standard
  // documentation cleanup pattern (see Issue #1747).
  "docs/archive/pr-summaries/pr-summary-1693.md",
  "docs/archive/pr-summaries/pr-summary-1696.md",
  "docs/archive/pr-summaries/pr-summary-1697.md",
  // PR #1747 summary describes the exemption-list update and legitimately
  // names the deprecated label for historical context.
  "docs/pr-summary-1747.md",
  "docs/archive/pr-summaries/pr-summary-1747.md",
];

/** Run a subprocess and return stdout/exit code. */
async function runCommand(
  cmd: string[],
  cwd: string,
): Promise<{ exitCode: number; stdout: string; stderr: string }> {
  const command = new Deno.Command(cmd[0]!, {
    args: cmd.slice(1),
    cwd,
    stdout: "piped",
    stderr: "piped",
  });
  const result = await command.output();
  return {
    exitCode: result.code,
    stdout: new TextDecoder().decode(result.stdout),
    stderr: new TextDecoder().decode(result.stderr),
  };
}

/** Enumerate tracked files via `git ls-files`. */
async function listTrackedFiles(root: string): Promise<string[]> {
  const result = await runCommand(["git", "ls-files"], root);
  if (result.exitCode !== 0) {
    throw new Error(
      `git ls-files failed (exit ${result.exitCode}): ${result.stderr.trim()}`,
    );
  }
  return result.stdout
    .split("\n")
    .map((s) => s.trim())
    .filter((s) => s.length > 0);
}

interface Offence {
  file: string;
  token: string;
  line: number;
}

/** Scan a single file for forbidden tokens and return any offences. */
export function findForbiddenTokensInContent(
  relPath: string,
  content: string,
  forbidden: readonly string[] = FORBIDDEN_TOKENS,
): Offence[] {
  const offences: Offence[] = [];
  const lines = content.split("\n");
  for (const token of forbidden) {
    for (let i = 0; i < lines.length; i++) {
      if (lines[i]!.includes(token)) {
        offences.push({ file: relPath, token, line: i + 1 });
      }
    }
  }
  return offences;
}

/** Decide whether a tracked file should be scanned. */
export function shouldScanFile(
  relPath: string,
  selfExempt: string,
  historicalExemptions: readonly string[] = HISTORICAL_EXEMPTIONS,
): boolean {
  if (relPath === selfExempt) return false;
  if (historicalExemptions.includes(relPath)) return false;
  return true;
}

/** Scan the entire repository for offences. */
async function scanRepository(): Promise<Offence[]> {
  const root = repoRoot();
  const selfExempt = thisTestRelPath();
  const tracked = await listTrackedFiles(root);
  const offences: Offence[] = [];

  for (const relPath of tracked) {
    if (!shouldScanFile(relPath, selfExempt)) continue;

    let content: string;
    try {
      content = await Deno.readTextFile(`${root}/${relPath}`);
    } catch {
      // Binary file or symlink — skip silently. `git ls-files` lists
      // every tracked path, including binaries; reading them as text
      // can throw.
      continue;
    }
    offences.push(...findForbiddenTokensInContent(relPath, content));
  }
  return offences;
}

// ============================================================================
// Tests
// ============================================================================

Deno.test(
  "awaiting-author regression - tracked files contain no deprecated label references",
  async () => {
    const offences = await scanRepository();
    assertEquals(
      offences,
      [],
      `Found references to the deprecated 'awaiting-author' label.\n` +
        `Per Issue #1677 the canonical "your turn" indicator is the existing ` +
        `'needs-human' label. Use that label instead.\n` +
        `Offending locations:\n` +
        offences
          .map((o) => `  ${o.file}:${o.line}  (${o.token})`)
          .join("\n"),
    );
  },
);

Deno.test(
  "awaiting-author regression - findForbiddenTokensInContent flags both tokens",
  () => {
    const sample = [
      "first line is fine",
      `uses the ${["awaiting", "-author"].join("")} label`,
      `and also ${["awaiting", "Author"].join("")} in code`,
      "trailing line",
    ].join("\n");
    const offences = findForbiddenTokensInContent("sample.md", sample);
    assertEquals(offences.length, 2);
    const tokens = offences.map((o) => o.token).sort();
    assertEquals(
      tokens,
      [["awaiting", "-author"].join(""), ["awaiting", "Author"].join("")]
        .sort(),
    );
    const dashOffence = offences.find((o) => o.token.includes("-"))!;
    assertEquals(dashOffence.line, 2);
    const camelOffence = offences.find((o) => !o.token.includes("-"))!;
    assertEquals(camelOffence.line, 3);
  },
);

Deno.test(
  "awaiting-author regression - findForbiddenTokensInContent returns [] for clean content",
  () => {
    const sample =
      "needs-human is the canonical label.\nNo deprecated tokens here.";
    assertEquals(findForbiddenTokensInContent("clean.md", sample), []);
  },
);

Deno.test(
  "awaiting-author regression - shouldScanFile exempts self",
  () => {
    const self = "worker/deno/tests/awaiting_author_regression_test.ts";
    assert(!shouldScanFile(self, self), "test file must exempt itself");
  },
);

Deno.test(
  "awaiting-author regression - shouldScanFile exempts historical PR summaries",
  () => {
    const self = "worker/deno/tests/awaiting_author_regression_test.ts";
    assert(!shouldScanFile("docs/pr-summary-1696.md", self));
    assert(!shouldScanFile("docs/pr-summary-1697.md", self));
    // Archive paths are also exempt (Issue #1747 cleanup).
    assert(
      !shouldScanFile("docs/archive/pr-summaries/pr-summary-1697.md", self),
    );
    assert(
      !shouldScanFile("docs/archive/pr-summaries/pr-summary-1693.md", self),
    );
  },
);

Deno.test(
  "awaiting-author regression - shouldScanFile scans ordinary tracked files",
  () => {
    const self = "worker/deno/tests/awaiting_author_regression_test.ts";
    assert(shouldScanFile("worker/deno/lib/label_manager.ts", self));
    assert(shouldScanFile("README.md", self));
    assert(shouldScanFile("docs/CONFIGURATION.md", self));
  },
);
