import { assertEquals } from "@std/assert";
import { disarmAutoMerge } from "../lib/auto_merge_disarm.ts";

Deno.test("disarmAutoMerge issues --disable-auto and returns true", async () => {
  const calls: string[][] = [];
  const ok = await disarmAutoMerge(
    "o/r",
    7,
    (args) => {
      calls.push(args);
      return Promise.resolve("");
    },
    () => {},
  );
  assertEquals(ok, true);
  assertEquals(calls, [[
    "pr",
    "merge",
    "7",
    "--repo",
    "o/r",
    "--disable-auto",
  ]]);
});

Deno.test("disarmAutoMerge logs a warning and returns false on failure", async () => {
  const logs: string[] = [];
  const ok = await disarmAutoMerge(
    "o/r",
    7,
    () => Promise.reject(new Error("boom")),
    (m) => logs.push(m),
  );
  assertEquals(ok, false);
  assertEquals(logs, [
    "WARNING: could not disarm auto-merge on o/r#7: boom (Issue #3433)",
  ]);
});
