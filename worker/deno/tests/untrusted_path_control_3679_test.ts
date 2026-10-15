/**
 * Documentation-drift test (CODING-STANDARDS.md § Documentation-drift tests):
 * Issue #3679 — fleet PRs VibeCoder#3533, VibeCoder#3584 and VibeCoder#3676
 * added a new path for untrusted input that skipped the trust-boundary control
 * a sibling path applied: the built command env, the nonce fence, the
 * content-integrity snapshot. CODING-STANDARDS.md and the coding_guidelines
 * prompt must both carry the same "a new path for untrusted input keeps its
 * sibling's trust-boundary control" rule, word for word once wrapping is
 * ignored, and the rule must name the controls under the names they actually
 * have; the issue prompt's PR Summary File step and the pr_feedback prompt
 * must both require the control.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals } from "@std/assert";
import {
  type DocSection,
  excerpt,
  flat,
  readRepoDoc,
  section,
} from "./support/markdown_docs.ts";
import {
  buildBoundaryIntegrityInstruction,
  fenceUntrustedIssueText,
  scrubUntrustedText,
} from "../lib/prompt_delimiter.ts";
import { buildUntrustedCommandEnv } from "../lib/untrusted_command_env.ts";
import { untrustedQualityCommandEnv } from "../lib/quality_gate_phase.ts";
import { verifyPickupContentIntegrity } from "../lib/pickup_content_integrity.ts";
import { redactSecrets } from "../lib/secret_redaction.ts";

const PARAGRAPH_START =
  "**A new path for untrusted input keeps its sibling's trust-boundary control.**";

function untrustedPathParagraph(sectionText: DocSection, what: string): string {
  const start = sectionText.indexOf(PARAGRAPH_START);
  assert(
    start >= 0,
    `could not locate the untrusted-path control rule in ${what}`,
  );
  const end = sectionText.indexOf("\n\n", start);
  const paragraph = excerpt(sectionText, start, end >= 0 ? end : undefined);
  return flat(paragraph).trim();
}

const KEY_PHRASES = [
  "puts issue, PR, comment or other untrusted text into a prompt",
  "spawns a command the repository controls",
  "fleet-authored artefact the fleet later trusts",
  "publishes to an outbound sink",
  "grep for the control it calls",
  "never the worker's inherited environment",
  "never text fetched again afterwards",
  "List each control kept in the PR summary",
  "remove the control call and confirm the test goes red",
  "A new path that skips a control its sibling applies",
];

const CONTROLS: [string, unknown][] = [
  ["fenceUntrustedIssueText", fenceUntrustedIssueText],
  ["scrubUntrustedText", scrubUntrustedText],
  ["buildBoundaryIntegrityInstruction", buildBoundaryIntegrityInstruction],
  ["buildUntrustedCommandEnv", buildUntrustedCommandEnv],
  ["untrustedQualityCommandEnv", untrustedQualityCommandEnv],
  ["verifyPickupContentIntegrity", verifyPickupContentIntegrity],
  ["redactSecrets", redactSecrets],
];

const THREAT_MODEL_ROWS = [
  "| **C4** |",
  "| **C5** |",
  "| **C10** |",
  "| **C23** |",
  "| **C24** |",
  "| **AP-7** |",
];

Deno.test("both surfaces carry the untrusted-path control rule (Issue #3679)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const guidelines = section(
    await readRepoDoc("prompts/coding_guidelines/prompt.md"),
    "Test Coverage Expectations",
  );

  for (
    const [surface, text] of [
      ["CODING-STANDARDS.md", standards],
      ["coding_guidelines", guidelines],
    ] as const
  ) {
    const paragraph = untrustedPathParagraph(text, surface);
    for (const phrase of KEY_PHRASES) {
      assert(
        paragraph.includes(phrase),
        `${surface} is missing "${phrase}" from the untrusted-path control rule: ${paragraph}`,
      );
    }
  }

  assertEquals(
    untrustedPathParagraph(standards, "CODING-STANDARDS.md"),
    untrustedPathParagraph(guidelines, "coding_guidelines"),
    "the untrusted-path control rule must be identical on both surfaces",
  );
});

Deno.test("the rule names controls that exist under those names (Issue #3679)", async () => {
  const standards = section(
    await readRepoDoc("CODING-STANDARDS.md"),
    "Test coverage expectations",
  );
  const paragraph = untrustedPathParagraph(standards, "CODING-STANDARDS.md");

  for (const [name, fn] of CONTROLS) {
    assertEquals(typeof fn, "function", `${name} is not an exported function`);
    assert(
      paragraph.includes("`" + name),
      `the untrusted-path control rule does not name \`${name}\`: ${paragraph}`,
    );
  }

  const threatModel = await readRepoDoc("docs/THREAT-MODEL.md");
  for (const row of THREAT_MODEL_ROWS) {
    assert(
      threatModel.includes(row),
      `docs/THREAT-MODEL.md is missing the control row ${row}`,
    );
  }
});

Deno.test("issue prompt Test Plan step requires the untrusted-path control (Issue #3679)", async () => {
  const text = flat(
    section(await readRepoDoc("prompts/issue/prompt.md"), "PR Summary File"),
  );

  assert(
    text.includes(
      "A new path for untrusted input keeps its sibling's trust-boundary control",
    ),
    `PR Summary File section is missing the untrusted-path control requirement: ${text}`,
  );
  assert(
    text.includes(
      "a new path that skips a control its sibling applies with no stated reason is a blocking self-review finding",
    ),
    `PR Summary File section is missing the skipped-control finding: ${text}`,
  );
});

Deno.test("PR-feedback prompt points at the untrusted-path control rule (Issue #3679)", async () => {
  const text = flat(
    section(
      await readRepoDoc("prompts/pr_feedback/prompt.md"),
      "Making Changes",
    ),
  );

  assert(
    text.includes(
      "A new path for untrusted input keeps its sibling's trust-boundary control",
    ),
    `Making Changes section is missing the untrusted-path control reference: ${text}`,
  );
  assert(
    text.includes("goes red when the control call is removed"),
    `Making Changes section is missing the red-run requirement: ${text}`,
  );
});
