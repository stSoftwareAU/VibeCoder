/**
 * Tests for the per-launch run-mode record (Issue #4189).
 *
 * Uses Australian English throughout (behaviour, colour, organisation, etc.).
 */

import { assertEquals } from "@std/assert";
import {
  formatRunModeRecord,
  parseRunModeRecord,
  resolveRunHostId,
} from "../lib/run_mode_record.ts";

Deno.test("run mode record - format and parse round-trip through a run_core.log line (Issue #4189)", () => {
  const line = formatRunModeRecord({
    mode: "container",
    host: "host-23",
    runId: "vibe-msyhwilh-2dbf1b",
  });
  assertEquals(
    line,
    "run mode: container host=host-23 run_id=vibe-msyhwilh-2dbf1b",
  );
  assertEquals(parseRunModeRecord(`2026-08-18T10:03:56Z ${line}`), {
    mode: "container",
    host: "host-23",
    runId: "vibe-msyhwilh-2dbf1b",
  });
  assertEquals(
    parseRunModeRecord("2026-08-18T10:03:56Z VIBE_RUN_ID=x"),
    undefined,
  );
});

Deno.test("run mode record - whitespace in values is never spliced into the line (Issue #4189)", () => {
  const line = formatRunModeRecord({
    mode: "container",
    host: "my host",
    runId: "",
  });
  assertEquals(line, "run mode: container host=my_host run_id=unknown");
});

Deno.test("run mode record - host id prefers VIBE_HOST_ID and trims the domain (Issue #4189)", () => {
  assertEquals(
    resolveRunHostId(
      (n) => (n === "VIBE_HOST_ID" ? "host-23" : undefined),
      () => "vibe-coder-1",
    ),
    "host-23",
  );
  assertEquals(
    resolveRunHostId(() => undefined, () => "laptop.local"),
    "laptop",
  );
  assertEquals(
    resolveRunHostId(() => undefined, () => {
      throw new Error("no hostname");
    }),
    "unknown",
  );
});
