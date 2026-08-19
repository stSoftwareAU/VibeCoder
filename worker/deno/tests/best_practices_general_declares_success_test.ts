/**
 * Tests for the "declares success" check added to the `general`
 * best-practices bucket guide (Issue #3608 — hardcoded success returns
 * and mock fixtures in production code paths).
 *
 * Deliberately narrow, in the shape Issue #3115 sanctioned: the guide is
 * prose the LLM reads, so pinning its wording would repeat the
 * source-grep anti-pattern. What is load-bearing — and what these tests
 * assert — is that the check cannot silently lose a limb on a reword:
 *
 *   - every flagged shape is named, so a stub shape cannot disappear;
 *   - the exclusions are stated, or the scan flags every test fixture
 *     and factory helper in the fleet;
 *   - the check stays static-evidence only, consistent with the bucket;
 *   - both severity tiers and the fail-loud fix are stated;
 *   - the whole guide, new section included, still reaches the wrapper
 *     body through the real consumer path.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertStringIncludes } from "@std/assert";

import { assembleBestPracticesPrompt } from "../lib/idle_task_templates/best_practices_template.ts";

const PROMPTS_DIR = new URL("../../../prompts", import.meta.url).pathname;

function readGeneralBucket(): Promise<string> {
  return Deno.readTextFile(`${PROMPTS_DIR}/best_practices/buckets/general.md`);
}

/** The stub shapes the check must name so each is actually reviewed. */
const FLAGGED_SHAPES: readonly string[] = [
  "{ ok: true }",
  '"status": "ok"',
  "todo",
  "fixme",
  "for now",
  "catch",
];

/** Contexts the check must exclude, or the scan drowns in false positives. */
const EXCLUSIONS: readonly string[] = [
  "test",
  "fixture",
  "example",
  "demo",
  "factory",
  "builder",
];

Deno.test(
  "buckets/general.md - names every hardcoded-success shape it flags",
  async () => {
    const body = (await readGeneralBucket()).toLowerCase();
    const missing = FLAGGED_SHAPES.filter((s) => !body.includes(s));
    assert(
      missing.length === 0,
      `general bucket guide is missing flagged shapes: ${missing.join(", ")}`,
    );
  },
);

Deno.test(
  "buckets/general.md - excludes canned-data contexts from the check",
  async () => {
    const body = (await readGeneralBucket()).toLowerCase();
    const missing = EXCLUSIONS.filter((e) => !body.includes(e));
    assert(
      missing.length === 0,
      `general bucket guide is missing exclusions: ${missing.join(", ")}`,
    );
    // A documented default is contract, not a finding.
    assert(
      /documented default/i.test(body),
      "general bucket guide must exempt a documented default",
    );
  },
);

Deno.test(
  "buckets/general.md - declares-success check stays static-evidence only",
  async () => {
    const body = await readGeneralBucket();
    assert(
      /read the source/i.test(body),
      "the check must instruct the scan to read the source",
    );
    assert(
      /do not run the code|never run the code/i.test(body),
      "the check must forbid running the code",
    );
  },
);

Deno.test(
  "buckets/general.md - states both severity tiers and the fail-loud fix",
  async () => {
    const body = await readGeneralBucket();
    // High when the result gates a decision; medium otherwise.
    assert(
      /severity:high[\s\S]{0,400}gates a decision/i.test(body),
      "the check must promote to severity:high when the result gates a decision",
    );
    assert(
      /severity:medium/.test(body),
      "the check must state the medium default tier",
    );
    // The fix is fail-loud (Issue #3234), never a plausible success.
    const lower = body.toLowerCase();
    for (const needle of ["throw", "exit non-zero", "failure marker"]) {
      assert(
        lower.includes(needle),
        `the fail-loud fix must name '${needle}'`,
      );
    }
    assert(
      /never[\s\S]{0,60}return[\s\S]{0,40}success/i.test(body),
      "the check must forbid returning a plausible success",
    );
  },
);

Deno.test(
  "buckets/general.md - declares-success section reaches the assembled wrapper body",
  async () => {
    const guide = await readGeneralBucket();
    const out = assembleBestPracticesPrompt("Review {{BUCKET}}.", guide, {
      bucket: "general",
      suppressedIds: [],
      knownOpenFindingIds: [],
    });

    assertStringIncludes(out, "## Bucket Guide — `general` (inlined)");
    assertStringIncludes(out, guide.trim());
    assertStringIncludes(out, "Hardcoded success");
  },
);
