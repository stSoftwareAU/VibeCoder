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
const ACCOUNTABILITY_DOC = "docs/AGENT-ACCOUNTABILITY.md";

// tests/ → worker/deno/ → worker/ → repo root
function repoPath(relative: string): URL {
  return new URL(`../../../${relative}`, import.meta.url);
}

function read(relative: string): string {
  return Deno.readTextFileSync(repoPath(relative));
}

function exists(relative: string): boolean {
  try {
    return Deno.statSync(repoPath(relative)).isFile;
  } catch {
    return false;
  }
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

// Test names below say "measure" rather than the b-word: the quality gate's
// benchmark audit (Issue #583) rejects any `Deno.test` name containing it,
// and these are documentation-drift tests, not measurements.
Deno.test("negative-result lesson - LESSONS-LEARNT states measure before and after", () => {
  const paragraph = negativeResultParagraph();
  assert(
    /before/i.test(paragraph) && /after/i.test(paragraph),
    `${LESSONS_DOC} must say performance work is measured before *and* ` +
      `after the change`,
  );
});

Deno.test("negative-result lesson - LESSONS-LEARNT forbids a PR without a demonstrated gain", () => {
  const paragraph = negativeResultParagraph();
  assert(
    /no PR|not raise a PR|never raise a PR|no pull request/i.test(paragraph),
    `${LESSONS_DOC} must state that no PR is raised without a demonstrated ` +
      `gain`,
  );
});

Deno.test("negative-result lesson - LESSONS-LEARNT says the result is recorded, not re-attempted", () => {
  const paragraph = negativeResultParagraph();
  assert(
    /re-?attempt|repeat/i.test(paragraph),
    `${LESSONS_DOC} must explain why the negative result is recorded — so ` +
      `the same optimisation is not re-attempted`,
  );
});

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

Deno.test("negative-result lesson - the page cross-links the accountability doc", () => {
  assert(
    read(LESSONS_DOC).includes(`(AGENT-ACCOUNTABILITY.md`),
    `${LESSONS_DOC} must link ${ACCOUNTABILITY_DOC}`,
  );
  assert(exists(ACCOUNTABILITY_DOC), `${ACCOUNTABILITY_DOC} must exist`);
  assert(
    /\|\s*Performance close-out\s*\|[^|]*`negative-result`/.test(
      read(ACCOUNTABILITY_DOC),
    ),
    `${ACCOUNTABILITY_DOC} must keep the performance close-out row that ` +
      `authorises the label`,
  );
});

// ---------------------------------------------------------------------------
// Nothing was dropped by pruning the absorbed PR summaries
// ---------------------------------------------------------------------------

/**
 * Each pruned PR-summary cluster and the living document that absorbed it.
 * The summary file may be deleted; the learning may not.
 */
const ABSORBED_CLUSTERS: Array<{
  issues: number[];
  doc: string;
  marker: RegExp;
}> = [
  {
    issues: [177, 1428],
    doc: LESSONS_DOC,
    marker: /negative result/i,
  },
  {
    issues: [2473],
    doc: "DESIGN-PRINCIPLES.md",
    marker: /### Per-handler dispatch watchdog/,
  },
  {
    issues: [3138, 3150, 3151],
    doc: "DESIGN-PRINCIPLES.md",
    marker: /### One PR per issue across the fleet/,
  },
  {
    issues: [3138],
    doc: "docs/DUPLICATE-PR-ROOT-CAUSE-3138.md",
    marker: /fleet open-PR guard/i,
  },
  {
    issues: [2905],
    doc: "docs/ORPHAN-DEPS-SCAN.md",
    marker: /orphan/i,
  },
  {
    issues: [3311],
    doc: "SECURITY.md",
    marker: /write-repo allowlist/i,
  },
  {
    issues: [3312],
    doc: "SECURITY.md",
    marker: /issue body\/title|body and title/i,
  },
  {
    issues: [3313],
    doc: "docs/GITHUB-ACTIONS-AUDIT-SCAN.md",
    marker: /GitLost/,
  },
];

for (const cluster of ABSORBED_CLUSTERS) {
  const label = cluster.issues.map((n) => `#${n}`).join("/");
  Deno.test(
    `negative-result lesson - ${label} learning survives in ${cluster.doc}`,
    () => {
      assert(exists(cluster.doc), `${cluster.doc} must exist`);
      assert(
        cluster.marker.test(read(cluster.doc)),
        `${cluster.doc} must still carry the learning absorbed from the ` +
          `${label} PR summaries (looking for ${cluster.marker})`,
      );
    },
  );
}
