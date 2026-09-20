/**
 * The RTK host switch reaches every reactive processor (Issue #2384, part of
 * #2328).
 *
 * The PR-feedback and CI-fix processors take the switch as an option that
 * defaults to off, so a production site that forgets to thread it fails
 * silently: every processor test passes, and an enabled host simply runs those
 * paths unfiltered for ever. The dispatch closures that build those options
 * sit behind real `git` and `gh` calls and cannot be driven from a unit test,
 * so this pins the one invariant that catches the omission: wherever a site
 * hands a processor the CodeGraph switch, it hands it the RTK switch too.
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assert, assertEquals } from "@std/assert";

/** Every file that builds `PrFeedbackProcessorDeps` or `CiProcessorDeps`. */
const SITES = [
  "../lib/run_core_production_deps.ts",
  "../commands/pr_feedback_processor.ts",
  "../commands/pr_ci_processor.ts",
];

function occurrences(source: string, needle: string): number {
  return source.split(needle).length - 1;
}

Deno.test("rtk switch threading - every site that threads the CodeGraph switch threads the RTK switch (Issue #2384)", async () => {
  for (const site of SITES) {
    const source = await Deno.readTextFile(new URL(site, import.meta.url));
    const codegraph = occurrences(
      source,
      "codegraphContextEnabled: config.codegraphContext.enabled",
    );
    assert(codegraph > 0, `${site} no longer threads the CodeGraph switch`);
    assertEquals(
      occurrences(source, "rtkOutputEnabled: config.rtkOutput.enabled"),
      codegraph,
      `${site} must thread rtk_output.enabled beside every CodeGraph switch`,
    );
  }
});
