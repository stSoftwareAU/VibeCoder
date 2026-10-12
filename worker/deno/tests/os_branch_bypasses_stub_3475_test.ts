/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3475 — a macOS-only branch in a script under test bypassed a stubbed
 * tool. One script prepended the Homebrew prefix to `PATH`, so it ran the
 * host's real binary instead of the stub; a disk library swapped in the free
 * space AppleScript reported, so it read the host's disk instead of the faked
 * `df`. Both were green on Linux CI and red in quality.sh on macOS hosts.
 * CODING-STANDARDS.md must tell authors to read the script for OS-specific
 * branches and neutralise each one in the test, and the issue prompt's PR
 * Raising Requirements must require the stub to be reached on every platform.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertPins, readRepoDoc, section } from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS.md host-state section covers OS-specific branches that bypass a stub (Issue #3475)", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Never let a unit test inherit the host's state",
    ),
    [
      "the script and everything it sources for OS-specific branches",
      "pin the override the code provides",
      "the real tool and the stub give the same result",
      "CI never exercises a branch only macOS takes",
      "`osascript`",
    ],
  );
});

Deno.test("issue prompt PR Raising Requirements require the stub to be reached on every platform (Issue #3475)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
    [
      "reaches the stub on every platform the fleet runs",
      "read the script and everything it sources for OS-specific branches",
      "pin the override the code provides or set the test up",
      "Never let a unit test inherit the host's state",
    ],
  );
});
