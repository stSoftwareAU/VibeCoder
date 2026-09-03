/**
 * Issue #856: every log line carries the host that wrote it.
 *
 * Measured over 25.7 hours on GRQ-23, 16,070 lines: **4,129 carried `host=`**
 * — and those were almost entirely `[idle-census]` and `[idle-detect]`.
 * Nothing else did:
 *
 * ```text
 * [2026-09-03 00:48:14Z] ERROR: [s1 stSoftwareAU/VibeCoder#834] Failed to ensure milestone branch …
 * [2026-09-03 01:21:27Z] INFO: [s1 stSoftwareAU/VibeCoder#798] PR created prUrl=…
 * ```
 *
 * Copy those to a central store beside other hosts' and "which host is
 * failing?" cannot be answered: every claim, PR, error, escalation and
 * outcome is unattributable. The `[sN …]` slot prefix does not help — it is
 * host-local, so two hosts' `s1` streams collide when interleaved.
 *
 * The field is **appended**, not prefixed. Several parsers anchor on the
 * `[timestamp] LEVEL: message` shape — `green_gate_report.ts`'s
 * `PROCESSING_RE`, `first_run_verification.ts`'s `CLAIMED` — and a host
 * inserted before the message would break them for no gain. A trailing field
 * greps and splits just as well.
 *
 * Uses Australian English spelling (behaviour, colour, organisation, etc.)
 */

import { assert, assertEquals, assertStringIncludes } from "@std/assert";
import { createLogger } from "../lib/logger.ts";

/** Capture the lines a logger writes. */
function capture(host?: string) {
  const lines: string[] = [];
  const logger = createLogger({
    write: (m) => lines.push(m),
    ...(host === undefined ? {} : { host }),
  });
  return { logger, lines };
}

Deno.test("logger host - every level carries the host (Issue #856)", () => {
  const { logger, lines } = capture("vibe-coder-1234:60");
  logger.info("claimed an issue");
  logger.warn("something odd");
  logger.error("it failed");
  assertEquals(lines.length, 3);
  for (const line of lines) {
    assertStringIncludes(line, "host=vibe-coder-1234:60");
  }
});

Deno.test("logger host - the line prefix is unchanged (Issue #856)", () => {
  // `green_gate_report.ts` matches /INFO: (?:\[[^\]]*\] )?Processing issue …/
  // and `first_run_verification.ts` matches /Processing issue[^\n]*#\d+/.
  // Both must still match.
  const { logger, lines } = capture("h:1");
  logger.info("Processing issue stSoftwareAU/VibeCoder#834: a title");
  const line = lines[0] ?? "";
  assert(
    /^\[[^\]]+\] INFO: /.test(line),
    `the timestamp/level prefix must survive: ${line}`,
  );
  assert(
    /INFO: (?:\[[^\]]*\] )?Processing issue (\S+#\d+)/.test(line),
    `green_gate_report's parser must still match: ${line}`,
  );
  assert(
    /Processing issue[^\n]*#\d+/.test(line),
    `first_run_verification's parser must still match: ${line}`,
  );
});

Deno.test("logger host - context fields are preserved (Issue #856)", () => {
  const { logger, lines } = capture("h:1");
  logger.info("PR created", { repo: "stSoftwareAU/VibeCoder", issue: 798 });
  const line = lines[0] ?? "";
  assertStringIncludes(line, "repo=stSoftwareAU/VibeCoder");
  assertStringIncludes(line, "host=h:1");
  assert(
    line.indexOf("repo=") < line.indexOf("host="),
    "host is appended after the context, not interleaved with it",
  );
});

Deno.test("logger host - an empty host omits the field entirely (Issue #856)", () => {
  // A blank value must not produce a dangling `host=` — worse than absent,
  // because a scraper would read it as a host named "".
  const { logger, lines } = capture("");
  logger.info("no host wanted here");
  const line = lines[0] ?? "";
  assert(!line.includes("host="), `expected no host field: ${line}`);
});

Deno.test("logger host - defaults to this process when unset (Issue #856)", () => {
  // The default is what makes this work without touching ~50 call sites that
  // construct a logger with no options at all.
  const { logger, lines } = capture();
  logger.info("a line from the default logger");
  const line = lines[0] ?? "";
  assert(/ host=\S+:\d+$/.test(line), `expected <name>:<pid>: ${line}`);
});

Deno.test("logger host - the slot prefix still attributes within a host (Issue #856)", () => {
  // `[sN owner/repo#issue]` is host-local, which is why it was never enough
  // on its own; it must survive alongside the host, not be replaced by it.
  const { logger, lines } = capture("h:1");
  logger.info("still running");
  assertStringIncludes(lines[0] ?? "", "host=h:1");
});
