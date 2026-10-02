/**
 * `listSweptModules` over a temp `prompts/` fixture (Issue #2759).
 *
 * Split out of `lib_sweep_coverage_test.ts`: this test builds a temp
 * directory, which trips the completeness-check family's heavy-op guard
 * (`HEAVY_RE` in `../lib/completeness_checks.ts`) and would disqualify that
 * whole file from `deno task check:manifests` otherwise.
 *
 * Australian English throughout (behaviour, organisation).
 */

import { assertEquals } from "@std/assert";
import { listSweptModules } from "../lib/lib_sweep_coverage.ts";

Deno.test("listSweptModules - lists prompt.md templates and excludes non-template siblings (Issue #2759)", async () => {
  const tempRoot = await Deno.makeTempDir();
  try {
    await Deno.mkdir(`${tempRoot}/prompts/example/buckets`, {
      recursive: true,
    });
    await Deno.writeTextFile(
      `${tempRoot}/prompts/example/prompt.md`,
      "template",
    );
    await Deno.writeTextFile(
      `${tempRoot}/prompts/example/buckets/general.md`,
      "bucket, not a template",
    );
    await Deno.writeTextFile(
      `${tempRoot}/prompts/example/helper.ts`,
      "export {};",
    );
    await Deno.writeTextFile(
      `${tempRoot}/prompts/example/helper_test.ts`,
      "export {};",
    );
    const paths = await listSweptModules(tempRoot, "prompts");
    assertEquals(paths, [
      "prompts/example/helper.ts",
      "prompts/example/prompt.md",
    ]);
  } finally {
    await Deno.remove(tempRoot, { recursive: true });
  }
});
