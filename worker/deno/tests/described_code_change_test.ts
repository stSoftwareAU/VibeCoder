/**
 * Tests for `detectDescribedCodeChange` (Issue #2687): a no-change run whose
 * output names files to change is a failed implementation, not analysis.
 */

import { assert, assertEquals } from "@std/assert";
import {
  detectDescribedCodeChange,
  MAX_DESCRIBED_FILES,
} from "../lib/described_code_change.ts";
import { GRQ_4871_OUTPUT } from "./support/grq_4871_output.ts";

Deno.test("detectDescribedCodeChange - GRQ#4871 output describes a code change", () => {
  const result = detectDescribedCodeChange(GRQ_4871_OUTPUT);
  assert(result.described);
  assert(
    result.files.includes("test/worker/IntelligentDesignHeapClampSkip.ts"),
  );
  assert(result.files.includes("worker/shared/heap_clamp_skip.sh"));
});

Deno.test("detectDescribedCodeChange - plain analysis prose is not a code change", () => {
  const prose = "A".repeat(200) +
    " Here is my analysis of the issue. The root cause is a race between the " +
    "scheduler and the claim lock; I recommend the owner decide which wins.";
  assertEquals(detectDescribedCodeChange(prose), {
    described: false,
    files: [],
  });
});

Deno.test("detectDescribedCodeChange - a path with no change verb is not a change", () => {
  const out = "The module `lib/foo.ts` is 200 lines long and well covered.";
  assertEquals(detectDescribedCodeChange(out).described, false);
});

Deno.test("detectDescribedCodeChange - a descriptive -s verb is not a change", () => {
  const out = "Today `lib/foo.ts` adds a header and updates the cache.";
  assertEquals(detectDescribedCodeChange(out).described, false);
});

Deno.test("detectDescribedCodeChange - a negated line is not a change", () => {
  const out = "No need to modify `lib/foo.ts` — it already handles this.\n" +
    "We should not edit worker/shared/run.sh either.";
  assertEquals(detectDescribedCodeChange(out).described, false);
});

Deno.test("detectDescribedCodeChange - a URL is not a file to change", () => {
  const out =
    "Fix documented at https://example.com/docs/guide.md for reference.";
  assertEquals(detectDescribedCodeChange(out).described, false);
});

Deno.test("detectDescribedCodeChange - an un-fenced dotted word is not a file", () => {
  const out = "Update the Node.js section of the recommendation.";
  assertEquals(detectDescribedCodeChange(out).described, false);
});

Deno.test("detectDescribedCodeChange - empty output is not a change", () => {
  assertEquals(detectDescribedCodeChange(""), { described: false, files: [] });
});

Deno.test("detectDescribedCodeChange - strips line and column suffixes", () => {
  const out = "Fix the off-by-one in `src/auth/login.ts:45:7`.";
  assertEquals(detectDescribedCodeChange(out), {
    described: true,
    files: ["src/auth/login.ts"],
  });
});

Deno.test("detectDescribedCodeChange - a backticked bare filename counts", () => {
  const out = "Update `README.md` with the new flag.";
  assertEquals(detectDescribedCodeChange(out).files, ["README.md"]);
});

Deno.test("detectDescribedCodeChange - unicode paths and prose are handled", () => {
  const out = "Écrire — add the colour fallback to `lib/colour_ünïcode.ts` 🎨";
  assertEquals(detectDescribedCodeChange(out), {
    described: true,
    files: ["lib/colour_ünïcode.ts"],
  });
});

Deno.test("detectDescribedCodeChange - dedupes and caps the file list", () => {
  const lines = Array.from(
    { length: MAX_DESCRIBED_FILES + 5 },
    (_, i) => `- Edit \`lib/mod_${i}.ts\` and \`lib/mod_${i}.ts\` again`,
  );
  const result = detectDescribedCodeChange(lines.join("\n"));
  assert(result.described);
  assertEquals(result.files.length, MAX_DESCRIBED_FILES);
  assertEquals(new Set(result.files).size, MAX_DESCRIBED_FILES);
  assertEquals(result.files[0], "lib/mod_0.ts");
});
