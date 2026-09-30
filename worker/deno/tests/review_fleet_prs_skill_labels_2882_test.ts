/**
 * The review-fleet-prs skill files a self-improvement issue and must label
 * it `idle-task`, never a reserved triage label such as `work-on` (Issue
 * #2882): the reviewer App is in `authorized_commenters`, so the worker
 * trusts only its `idle-task` add, and reserved labels are for humans.
 */
import { assert, assertEquals } from "@std/assert";

const fromFileUrl = (u: URL) => decodeURIComponent(u.pathname);

const SKILL = fromFileUrl(
  new URL(
    "../../../.claude/skills/review-fleet-prs/SKILL.md",
    import.meta.url,
  ),
);

const RESERVED_LABELS = ["work-on", "top-priority", "low-priority", "planning"];

// Finds every "apply `label`[, `label` ...]" instruction: a case-insensitive
// match on "apply" followed immediately by a comma/and/or-joined run of
// backticked labels, so prose like "never `work-on`" (not preceded by
// "apply") is not mistaken for an instruction to apply that label.
function labelsToApply(markdown: string): string[] {
  const labels: string[] = [];
  const instruction = /apply\s+((?:`[^`]+`(?:\s*(?:,|and|or)\s*)?)+)/gi;
  for (const match of markdown.matchAll(instruction)) {
    for (const label of (match[1] ?? "").matchAll(/`([^`]+)`/g)) {
      labels.push(label[1] ?? "");
    }
  }
  return labels;
}

Deno.test("labelsToApply detects a guarded label, proving the regex bites (Issue #2882)", () => {
  assertEquals(
    labelsToApply("Apply `work-on` when that label exists and so on."),
    ["work-on"],
  );
});

Deno.test("review-fleet-prs SKILL.md files self-improvement issues with idle-task, never a reserved label (Issue #2882)", async () => {
  const markdown = await Deno.readTextFile(SKILL);
  const labels = labelsToApply(markdown);

  assert(
    labels.includes("idle-task"),
    `expected SKILL.md to instruct applying idle-task, found: ${
      labels.join(", ")
    }`,
  );
  for (const reserved of RESERVED_LABELS) {
    assert(
      !labels.includes(reserved),
      `SKILL.md must not instruct applying the reserved label ${reserved}`,
    );
  }
});
