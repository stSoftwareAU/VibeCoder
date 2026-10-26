/**
 * The launchers restate the egress self-check status and marker (Issue #4048).
 *
 * The constant lives in three languages. This test is what keeps them in step.
 */

import { assert, assertEquals } from "@std/assert";
import { executableLines } from "../lib/launcher_source.ts";
import {
  EGRESS_SELFCHECK_EXIT_STATUS,
  EGRESS_SELFCHECK_FAILURE_MARKER,
} from "../lib/egress_selfcheck.ts";

Deno.test("the launchers restate the egress self-check status and marker", async () => {
  for (
    const [name, dialect, url, statusPattern] of [
      [
        "run.sh",
        "bash",
        new URL("../../../run.sh", import.meta.url),
        /EGRESS_SELFCHECK_EXIT_STATUS=(\d+)/,
      ],
      [
        "run.ps1",
        "powershell",
        new URL("../../../run.ps1", import.meta.url),
        /\$EgressSelfCheckExitStatus\s*=\s*(\d+)/,
      ],
    ] as const
  ) {
    const body = executableLines(await Deno.readTextFile(url), dialect).join(
      "\n",
    );
    const status = statusPattern.exec(body);
    assert(status, `${name} does not name the egress self-check exit status`);
    assertEquals(Number(status[1]), EGRESS_SELFCHECK_EXIT_STATUS);
    assert(
      body.includes(EGRESS_SELFCHECK_FAILURE_MARKER),
      `${name} does not restate the egress self-check marker`,
    );
    assert(
      body.includes("missing a network or proxy key"),
      `${name} does not refuse a plan that is missing an egress key`,
    );
  }
});
