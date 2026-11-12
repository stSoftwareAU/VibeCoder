/**
 * Issue #5072: a repair that stops because a provider's quota, credit or
 * balance is spent is a normal park. It must not reach the AggregateError the
 * babysitter pass raises for real failures, and it is logged once, quietly.
 */

import { assertEquals, assertStringIncludes } from "@std/assert";
import {
  repairFailureClass,
  runRepairs,
  startBabysitterFailure,
} from "../commands/fleet_pr_babysitter.ts";
import { BabysitterQuotaPark } from "../lib/fleet_babysitter_container.ts";
import { BabysitterParked } from "../lib/babysitter_retry_state.ts";

function captureConsole<T>(body: () => Promise<T>) {
  const lines: { level: string; text: string }[] = [];
  const saved = { error: console.error, log: console.log, warn: console.warn };
  for (const level of ["error", "log", "warn"] as const) {
    console[level] = (...args: unknown[]) =>
      lines.push({ level, text: args.map(String).join(" ") });
  }
  return body().finally(() => Object.assign(console, saved)).then(
    (value) => ({ value, lines }),
  );
}

Deno.test("a parked repair is logged quietly and does not fail the pass", async () => {
  const { lines } = await captureConsole(() =>
    runRepairs([{
      key: "repo#1",
      version: "head",
      run: () =>
        Promise.reject(
          new BabysitterParked("repo#1: quota-exhausted: balance is spent"),
        ),
    }], 1)
  );
  assertEquals(lines.filter((line) => line.level === "error"), []);
  assertEquals(lines.length, 1);
  assertStringIncludes(lines[0]!.text, "parked");
  assertStringIncludes(lines[0]!.text, "quota-exhausted");
});

Deno.test("a quota park from the container becomes a BabysitterParked failure", () => {
  const parked = startBabysitterFailure(
    new BabysitterQuotaPark("agent exited 1; quota-exhausted: spent"),
  );
  assertEquals(parked instanceof BabysitterParked, true);
  assertEquals(parked.blockerClass, "infrastructure");
});

Deno.test("refused paid overflow is a host capability fault, not a code failure", () => {
  assertEquals(
    repairFailureClass(
      "provider choice failed: refusing paid DeepSeek overflow: no subscription credential is loaded",
    ),
    "capability",
  );
});
