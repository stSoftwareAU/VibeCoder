/**
 * Regression tests for Issue #3468 — the per-sink secret-redaction standard
 * must be captured in the prose docs, not only in code comments and PR
 * summaries.
 *
 * The durable standard is: there is no global redaction chokepoint; every
 * public/permanent outbound sink must independently call `redactSecrets()`
 * from `secret_redaction.ts`, and new credential shapes must be added as
 * redaction rules. Before this fix a grep of `SECURITY.md`,
 * `CODING-STANDARDS.md`, and `docs/**` (excluding the pr-summaries archive)
 * for `redactSecrets`/`secret_redaction` returned nothing — so each new sink
 * re-learnt the rule by leaking first.
 *
 * These tests assert the standard now lives in the prose docs and that the
 * cross-link between them resolves. They fail against the pre-fix docs and
 * pass once the standard lands.
 *
 * Australian English spelling used throughout (behaviour, normalise, etc.).
 */

import { assert } from "@std/assert";
import { anchorSet } from "../lib/markdown_anchors.ts";

// tests/ → worker/deno/ → worker/ → repo root
const REPO_ROOT = new URL("../../../", import.meta.url);

async function read(relative: string): Promise<string> {
  return await Deno.readTextFile(new URL(relative, REPO_ROOT));
}

/** The anchor slug the SECURITY.md standard heading must expose. */
const STANDARD_ANCHOR = "-secret-redaction--every-outbound-sink";

Deno.test("SECURITY.md documents the per-sink redaction standard", async () => {
  const security = await read("SECURITY.md");

  assert(
    anchorSet(security).has(STANDARD_ANCHOR),
    `SECURITY.md must have a heading resolving to #${STANDARD_ANCHOR}`,
  );
  // The core rule: no global chokepoint, redaction is per-sink.
  assert(
    /no\s+(?:single\s+)?global\s+(?:redaction\s+)?chokepoint/i.test(security),
    "SECURITY.md must state there is no global redaction chokepoint",
  );
  // The obligation names redactSecrets() and its module.
  assert(
    security.includes("redactSecrets()"),
    "SECURITY.md must reference redactSecrets()",
  );
  assert(
    security.includes("secret_redaction.ts"),
    "SECURITY.md must reference secret_redaction.ts",
  );
  // New credential shapes must be added as redaction rules.
  assert(
    /new\s+credential\s+shape/i.test(security),
    "SECURITY.md must state new credential shapes become new redaction rules",
  );
});

Deno.test("SECURITY.md lists the sinks already wired to redactSecrets", async () => {
  const security = await read("SECURITY.md");
  for (
    const sink of [
      "logger.ts",
      "answer_sanitiser.ts",
      "label_failure.ts",
      "crash_notification.ts",
      // Issue #3636 — the no-changes phase publishes the tail of Claude's
      // stdout to a public issue comment on both of its branches.
      "handle_no_changes_phase.ts",
    ]
  ) {
    assert(
      security.includes(sink),
      `SECURITY.md must list the ${sink} sink as already wired`,
    );
  }
});

Deno.test("CODING-STANDARDS.md cross-links the standard in SECURITY.md", async () => {
  const [standards, security] = await Promise.all([
    read("CODING-STANDARDS.md"),
    read("SECURITY.md"),
  ]);

  const link = `SECURITY.md#${STANDARD_ANCHOR}`;
  assert(
    standards.includes(link),
    `CODING-STANDARDS.md must cross-link ${link}`,
  );
  // The cross-link target must resolve to a real heading in SECURITY.md.
  assert(
    anchorSet(security).has(STANDARD_ANCHOR),
    `SECURITY.md must expose the #${STANDARD_ANCHOR} anchor the cross-link targets`,
  );
  // The standard is summarised in CODING-STANDARDS.md, not only linked.
  assert(
    standards.includes("redactSecrets()"),
    "CODING-STANDARDS.md must reference redactSecrets()",
  );
});
