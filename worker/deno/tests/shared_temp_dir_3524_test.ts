/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3524 — fleet tests treated the shared system temp directory as their
 * own. One shell test sent stderr to a fixed file directly in `/tmp` that
 * another OS user already owned, so the redirect failed before the command
 * under test ran; one unit test listed the shared `TMPDIR` before and after a
 * call and reported a leak whenever a parallel test created a directory in
 * between. CODING-STANDARDS.md must treat the shared temp directory as host
 * state and tell authors to keep every path inside a directory the test made,
 * and the issue prompt's PR Raising Requirements must ask about it before the
 * PR is raised. Issue #5071 reworded the `/tmp` exemption so a placeholder
 * that the change makes live is a hit.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertFalse } from "@std/assert";
import {
  assertPins,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

Deno.test("CODING-STANDARDS.md host-state section treats the shared temp directory as host state (Issue #3524)", async () => {
  assertPins(
    section(
      await readRepoDoc("CODING-STANDARDS.md"),
      "Never let a unit test inherit the host's state",
    ),
    [
      "`/tmp` and `$TMPDIR` are shared host state",
      "Never use a fixed name directly under `/tmp` or `$TMPDIR`",
      "never assert on what the shared temp directory contains",
      "give the code a temp-root parameter that production leaves unset",
      "grep new or edited test files for a literal `/tmp/`",
      "A `/tmp/...` string that never touches the filesystem",
    ],
  );
});

Deno.test("CODING-STANDARDS.md temp-path exemption is judged against the code at the head, not a config placeholder (Issue #5071)", async () => {
  const text = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Never let a unit test inherit the host's state",
  );
  assertPins(text, [
    "never touches the filesystem once your change is in",
    "Judge it against the code at the head, not the base",
  ]);
  assertFalse(
    flat(text).includes("a config placeholder"),
    "the /tmp exemption must not list a config placeholder as exempt — a placeholder the change makes live is a hit",
  );
});

Deno.test("issue prompt PR Raising Requirements ask about fixed shared temp paths before the PR (Issue #3524)", async () => {
  assertPins(
    section(
      await readRepoDoc("prompts/issue/prompt.md"),
      "PR Raising Requirements",
    ),
    [
      "uses a fixed path under `/tmp` or `$TMPDIR`, or reads that directory's listing",
      "inside a directory it created itself",
      "prove cleanup through a temp-root parameter pointed at that directory",
    ],
  );
});
