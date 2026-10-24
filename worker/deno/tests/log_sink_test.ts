/**
 * Level stays on the logger, not in the message text (Issue #4176).
 *
 * Uses Australian English throughout (behaviour, colour, organisation).
 */

import { assertEquals } from "@std/assert";
import { bindLogger, logAt } from "../lib/log_sink.ts";

Deno.test("logAt writes a warning and an error on those methods, with no level prefix (Issue #4176)", () => {
  const seen: { level: string; message: string }[] = [];
  const logger = {
    info: (message: string) => seen.push({ level: "info", message }),
    warn: (message: string) => seen.push({ level: "warn", message }),
    error: (message: string) => seen.push({ level: "error", message }),
  };

  logAt(logger, "warn", "Could not measure how far the branch is behind");
  logAt(logger, "error", "corrupt clone moved aside");
  logAt(logger, "info", "sync finished");

  assertEquals(seen, [
    {
      level: "warn",
      message: "Could not measure how far the branch is behind",
    },
    { level: "error", message: "corrupt clone moved aside" },
    { level: "info", message: "sync finished" },
  ]);
  for (const row of seen) {
    assertEquals(row.message.includes("WARNING:"), false, row.message);
    assertEquals(row.message.includes("ERROR:"), false, row.message);
  }
});

Deno.test("logAt passes the level to a callback and skips an absent sink (Issue #4176)", () => {
  const seen: { message: string; level?: string }[] = [];
  const log = (message: string, level?: "info" | "warn" | "error") => {
    seen.push({ message, level });
  };

  logAt(log, "warn", "disk is tight");
  logAt(undefined, "error", "nobody is listening");

  assertEquals(seen, [{ message: "disk is tight", level: "warn" }]);
});

Deno.test("bindLogger keeps a plain message at info and a warning at warn (Issue #4176)", () => {
  const seen: { level: string; message: string }[] = [];
  const log = bindLogger({
    info: (message: string) => seen.push({ level: "info", message }),
    warn: (message: string) => seen.push({ level: "warn", message }),
    error: (message: string) => seen.push({ level: "error", message }),
  });

  log("ordinary");
  log("Could not list milestones", "warn");
  log("corrupt clone", "error");

  assertEquals(seen, [
    { level: "info", message: "ordinary" },
    { level: "warn", message: "Could not list milestones" },
    { level: "error", message: "corrupt clone" },
  ]);
});
