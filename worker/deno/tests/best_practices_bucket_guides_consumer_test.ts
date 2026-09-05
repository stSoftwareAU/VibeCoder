/**
 * Behaviour tests for the best-practices bucket-guide *consumer*
 * (Issue #3115).
 *
 * Replaces six prose-grep test files
 * (`best_practices_{general,typescript,terraform,dead_deps,deprecated_config,
 * html}_bucket_test.ts`) that read each `prompts/best_practices/buckets/<b>.md`
 * guide and asserted on its human-facing prose — a WHAT-vs-HOW anti-pattern-2
 * source-text grep. Those ~107 `.includes(...)` assertions pinned exact
 * wording, so any reword of a guide broke the suite even though the prompt's
 * effect on the worker was unchanged.
 *
 * Instead we exercise the genuinely load-bearing, machine-consumed invariants
 * of the bucket-guide loading + assembly path:
 *
 *   - `bucketGuidePath(bucket)` maps a bucket name to the correct relative
 *     guide path the template reads at file time.
 *   - Every guide that path names actually exists and is non-empty (a guide
 *     accidentally deleted or emptied would break the scan). This is the one
 *     presence check per bucket the issue sanctions keeping.
 *   - `assembleBestPracticesPrompt` inlines the loaded guide into the wrapper
 *     under the `## Bucket Guide — \`<bucket>\` (inlined)` heading, emits the
 *     `**Bucket:** \`<bucket>\`` line, and substitutes the `{{BUCKET}}`
 *     placeholder — the observable output a human pastes into a fresh issue.
 *
 * None of these assert on guide prose, so a guide may be reworded freely
 * without breaking the suite. The placeholder-substitution and id-list
 * behaviour of `assembleBestPracticesPrompt` itself is covered separately in
 * `best_practices_template_test.ts`.
 *
 * Australian English spelling used throughout.
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";

import {
  assembleBestPracticesPrompt,
  bucketGuideFilePath,
  bucketGuidePath,
  readBucketGuide,
} from "../lib/idle_task_templates/best_practices_template.ts";
import { emptyEnv } from "./support/env_lookup.ts";

/** Repo root, derived from this test file's location. */
const REPO_ROOT = new URL("../../../", import.meta.url).pathname;

/**
 * Every bucket the template can target: the seven language buckets plus the
 * two language-agnostic runs (`general`, `design`). Each must have a guide
 * on disk.
 */
const BUCKETS = [
  "general",
  "design",
  "rust",
  "typescript",
  "react",
  "java",
  "html",
  "aws-cloudformation",
  "terraform",
] as const;

/** Load a real guide via the path the consumer computes. */
function readGuide(bucket: string): Promise<string> {
  return Deno.readTextFile(`${REPO_ROOT}${bucketGuidePath(bucket)}`);
}

/**
 * Is `path` anchored rather than resolved against the working directory?
 *
 * POSIX and the `/C:/…` shape `new URL(…).pathname` yields on Windows both
 * start with a slash; a bare drive-letter path is accepted too.
 */
function isAnchored(path: string): boolean {
  return path.startsWith("/") || /^[A-Za-z]:[\\/]/.test(path);
}

Deno.test("readBucketGuide - resolves the guide without depending on the CWD", async () => {
  // The default reader used to be `Deno.readTextFile(bucketGuidePath(b))`,
  // which resolves against the process's working directory — so building a
  // best-practices body threw `No such file or directory` whenever the worker
  // was not started from the repository root (the quality gate runs the suite
  // from `worker/deno`).
  //
  // This used to be proved by moving the process cwd into a temp directory and
  // reading from there — the only `Deno.chdir` in the whole parallel-unsafe
  // manifest, and a mutation shared with every other worker under
  // `deno test --parallel` (Issues #880, #944, #969). The property is now
  // asserted directly on the resolved path instead: a path that is anchored
  // cannot depend on where the process happens to be. The environment is
  // declared empty, so no `PROMPTS_DIR` or `VIBE_BASE_DIR` on the host running
  // the suite can answer for the production default either.
  const resolved = bucketGuideFilePath(
    bucketGuidePath("general"),
    undefined,
    emptyEnv,
  );
  assert(
    isAnchored(resolved),
    `bucket guides must resolve to an anchored path, got ${resolved}`,
  );

  // And the read that path drives returns the guide, whatever the cwd is.
  assertEquals(
    await readBucketGuide(bucketGuidePath("general"), undefined, emptyEnv),
    await readGuide("general"),
  );

  // Naming the base directory outright is the other supported spelling
  // (Issue #1024), and resolves to the same guide.
  assertEquals(
    await readBucketGuide(bucketGuidePath("general"), `${REPO_ROOT}prompts`),
    await readGuide("general"),
  );
});

Deno.test("bucketGuidePath - maps a bucket to its guide path", () => {
  assertEquals(
    bucketGuidePath("general"),
    "prompts/best_practices/buckets/general.md",
  );
  assertEquals(
    bucketGuidePath("aws-cloudformation"),
    "prompts/best_practices/buckets/aws-cloudformation.md",
  );
});

for (const bucket of BUCKETS) {
  Deno.test(`bucket guide '${bucket}' - exists and is non-empty`, async () => {
    const guide = await readGuide(bucket);
    assert(
      guide.trim().length > 0,
      `guide for bucket '${bucket}' must be non-empty`,
    );
  });

  Deno.test(
    `bucket guide '${bucket}' - is inlined into the assembled wrapper`,
    async () => {
      const guide = await readGuide(bucket);
      const out = assembleBestPracticesPrompt(
        "Run a {{BUCKET}} review.",
        guide,
        {
          bucket,
          suppressedIds: [],
          knownOpenFindingIds: [],
        },
      );

      // The wrapper names the bucket and substitutes {{BUCKET}}.
      assertStringIncludes(out, `**Bucket:** \`${bucket}\``);
      assertStringIncludes(out, `Run a ${bucket} review.`);
      assert(!out.includes("{{BUCKET}}"), "{{BUCKET}} must be substituted");

      // The loaded guide is inlined under its dedicated section heading.
      assertStringIncludes(out, `## Bucket Guide — \`${bucket}\` (inlined)`);
      assertStringIncludes(out, guide.trim());
    },
  );
}
