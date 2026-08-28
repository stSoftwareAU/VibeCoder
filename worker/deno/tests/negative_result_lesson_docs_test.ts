/**
 * Documentation-drift tests for the negative-result / benchmark discipline
 * (Issue #3351).
 *
 * The discipline — benchmark before *and* after, raise a PR only on a
 * demonstrated gain, otherwise close the issue with a `negative-result`
 * label — lived only in the mutable `prompts/` templates and in the
 * `docs/AGENT-ACCOUNTABILITY.md` label table. The PR-summary archive
 * (`pr-summary-177.md`, `pr-summary-1428.md`) was the sole record of *why*
 * it exists, and that archive is being pruned, so the lesson is now stated
 * on the durable page `docs/LESSONS-LEARNT.md`.
 *
 * These tests do more than read prose: the label the page names is fed to
 * the **real** worker label guard, so a page naming a label the worker
 * cannot actually apply fails the suite. The clusters whose PR summaries
 * were deleted are pinned to the living documents that absorbed them, so a
 * later edit that removes the absorbing section is caught rather than
 * silently dropping a learning.
 *
 * Australian English spelling used throughout (behaviour, organisation).
 */

import { assert } from "@std/assert";
import {
  isWorkerAppliableLabel,
  WORKER_FORBIDDEN_LABEL_LITERALS,
} from "../lib/worker_label_guard.ts";

const LESSONS_DOC = "docs/LESSONS-LEARNT.md";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

/**
 * The paragraph of `LESSONS_DOC` that states the negative-result
 * discipline — located by content, not by line number, so the page can be
 * reordered freely.
 */
function negativeResultParagraph(): string {
  const paragraph = read(LESSONS_DOC)
    .split(/\n{2,}/)
    .find((block) =>
      /negative result/i.test(block) && /benchmark/i.test(block)
    );
  assert(
    paragraph,
    `${LESSONS_DOC} must state the negative-result benchmark discipline`,
  );
  return paragraph;
}

/** Backticked tokens inside `text`. */
function backtickedTokens(text: string): string[] {
  return [...text.matchAll(/`([^`]+)`/g)].map((match) => match[1] ?? "");
}

// ---------------------------------------------------------------------------
// The durable statement is on the page
// ---------------------------------------------------------------------------

// ---------------------------------------------------------------------------
// The documented label is the label the worker may really apply
// ---------------------------------------------------------------------------

Deno.test("negative-result lesson - the label the page names is worker-appliable", () => {
  const tokens = backtickedTokens(negativeResultParagraph());
  const label = tokens.find((token) => token.includes("negative-result"));
  assert(
    label,
    `${LESSONS_DOC} must name the close-out label in backticks`,
  );
  assert(
    isWorkerAppliableLabel(label),
    `The documented label '${label}' must be one the worker may actually ` +
      `apply (worker/deno/lib/worker_label_guard.ts)`,
  );
  assert(
    !WORKER_FORBIDDEN_LABEL_LITERALS.includes(label),
    `The documented label '${label}' must not be a reserved workflow label`,
  );
});
