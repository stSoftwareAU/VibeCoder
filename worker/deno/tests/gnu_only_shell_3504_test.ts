/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3504 — fleet shell code assumed a GNU/Linux userland and paths. One
 * test compared a `mktemp -d` path with one resolved by `pwd -P`; another ran a
 * script that timed itself with GNU `date +%N`. Both were green on Linux CI and
 * red in quality.sh on macOS hosts. CODING-STANDARDS.md must tell authors to
 * avoid GNU-only forms (or give each a portable fallback), resolve both sides
 * of a path comparison the same way and check before raising the PR; the issue
 * prompt's PR Raising Requirements and the coding guidelines' cross-platform
 * section must carry the same rule.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS.md has a macOS portability section for shell code a test runs (Issue #3504)", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Shell code a test runs must behave the same on macOS",
    ),
    [
      "Linux CI does not prove the quality gate passes",
      "temp directories under `/var/folders`",
      "`date +%N`",
      "`stat -c`",
      "`declare -A`",
      "Resolve both sides of a path comparison the same way",
      "check every external command it runs against BSD behaviour",
    ],
  );
});

Deno.test("issue prompt PR Raising Requirements require portable shell code before the PR (Issue #3504)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
    [
      "Shell code a test runs must also behave the same under macOS's BSD userland and bash 3.2",
      "give each a portable fallback",
      "Shell code a test runs must behave the same on macOS** in `CODING-STANDARDS.md`",
    ],
  );
});

Deno.test("coding guidelines GNU vs BSD bullet requires a portable fallback in shell code a test runs (Issue #3504)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/coding_guidelines/prompt.md"),
      "Cross-Platform Bash Compatibility",
    ),
    [
      "give any GNU-only form in shell code a test runs a portable fallback",
      "fleet hosts run the quality gate on macOS too",
    ],
  );
});
