/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3675 — the coding guidelines pointed agents at a `check_dependencies()`
 * helper that sets `$TIMEOUT_CMD`, but no such helper exists anywhere in the
 * repo. Scripts that followed the guidance hit an unbound variable under
 * `set -u`. The guidelines must tell authors to pick the bounding command
 * themselves (`timeout`, else `gtimeout`, else run unbounded), and the
 * Streaming Reads and Test Timeout Protection examples must not assume a
 * pre-set `$TIMEOUT_CMD`.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assertFalse } from "@std/assert";
import {
  assertPins,
  flat,
  flatWholeFile,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";

const CODING_GUIDELINES = "prompts/coding_guidelines/prompt.md";

Deno.test("coding guidelines timeout bullet tells scripts to pick the bounding command themselves (Issue #3675)", async () => {
  const doc = await readRepoDoc(CODING_GUIDELINES);
  const sec = section(doc, "Cross-Platform Bash Compatibility");
  assertPins(sec, [
    "Do not rely on an inherited `$TIMEOUT_CMD` or a shared helper to choose one",
    "`timeout`, else `gtimeout`, else run the command unbounded",
    "for candidate in timeout gtimeout; do",
  ]);
  assertFalse(flat(sec).includes("check_dependencies"));
});

Deno.test("coding guidelines never name the non-existent check_dependencies() helper (Issue #3675)", async () => {
  const doc = await readRepoDoc(CODING_GUIDELINES);
  assertFalse(flatWholeFile(doc).includes("check_dependencies"));
});

Deno.test("Streaming Reads and Test Timeout Protection examples do not assume a pre-set $TIMEOUT_CMD (Issue #3675)", async () => {
  const doc = await readRepoDoc(CODING_GUIDELINES);

  const streaming = section(doc, "Streaming Reads");
  assertPins(streaming, [
    "timeout 30 tail -f /tmp/run.log | head -50",
    "Nothing sets a `$TIMEOUT_CMD` variable for you",
  ]);
  assertFalse(flat(streaming).includes("$TIMEOUT_CMD 30"));

  const timeouts = section(doc, "Test Timeout Protection");
  assertPins(timeouts, [
    "timeout 900 npx cypress run",
    "pick the bounding command as the **`timeout` command** bullet",
  ]);
  assertFalse(flat(timeouts).includes("$TIMEOUT_CMD 900"));
});
